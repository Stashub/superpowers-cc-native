import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { git } from '../lib/git.mjs';
import { IDENTITY } from '../lib/constants.mjs';
import { checkPublishedTags, checkPushIdentity } from '../lib/push.mjs';
import { initRepo, tempDir, writeFiles } from './helpers.mjs';

const ZERO = '0'.repeat(40);
const OTHER = { name: 'Someone Else', email: 'someone@example.invalid' };

// The environment that makes git use `author` and `committer` (the committer is also the tagger).
const as = (author, committer = author) => ({
  GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
});

// One new commit on HEAD that adds the file `name`; returns its sha.
function commitAs(repo, name, author = IDENTITY, committer = author) {
  writeFiles(repo, { [name]: `${name}\n` });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', name], { env: as(author, committer) });
  return git(repo, ['rev-parse', 'HEAD']);
}

// An annotated tag `name` on `target` made by `tagger`; returns the sha of the tag object.
function tagAs(repo, name, target, tagger = IDENTITY) {
  git(repo, ['tag', '-a', '-m', name, name, target], { env: as(tagger) });
  return git(repo, ['rev-parse', `refs/tags/${name}`]);
}

const update = (localSha, remoteRef, remoteSha = ZERO) => ({ localRef: 'HEAD', localSha, remoteRef, remoteSha });

// A bare repository that stands for the remote and holds `refs` (ref name -> sha); returns its path.
function remoteWith(t, repo, refs = {}) {
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare']);
  for (const [ref, sha] of Object.entries(refs)) git(repo, ['push', '-q', bare, `${sha}:${ref}`]);
  return bare;
}

function newRepo(t) {
  const repo = tempDir(t);
  initRepo(repo);
  return repo;
}

test('commits and tags by IDENTITY pass, deletions are not checked', (t) => {
  const repo = newRepo(t);
  const first = commitAs(repo, 'a');
  const second = commitAs(repo, 'b');
  const tag = tagAs(repo, 'v1.0.0-cc.1', second);
  assert.deepEqual(checkPushIdentity(repo, null, [
    update(second, 'refs/heads/main'),
    update(second, 'refs/heads/plan/x', first),
    update(tag, 'refs/tags/v1.0.0-cc.1'),
    update(ZERO, 'refs/heads/gone', first),
  ]), []);
});

test('a new commit by another author or committer blocks and is named', (t) => {
  const repo = newRepo(t);
  const good = commitAs(repo, 'a');
  const author = commitAs(repo, 'b', OTHER, IDENTITY);
  const committer = commitAs(repo, 'c', IDENTITY, { name: IDENTITY.name, email: OTHER.email });
  const blocks = checkPushIdentity(repo, null, [update(committer, 'refs/heads/plan/x')]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /refs\/heads\/plan\/x/);
  assert.match(blocks[0], /2 new commits/);
  assert.ok(blocks[0].includes(author.slice(0, 7)), blocks[0]);
  assert.ok(blocks[0].includes(committer.slice(0, 7)), blocks[0]);
  assert.ok(!blocks[0].includes(good.slice(0, 7)), blocks[0]);
  assert.match(blocks[0], /author Someone Else <someone@example\.invalid>/);
  assert.match(blocks[0], new RegExp(`committer ${IDENTITY.name} <someone@example\\.invalid>`));
});

test('commits behind the remote sha are already published and pass', (t) => {
  const repo = newRepo(t);
  const foreign = commitAs(repo, 'a', OTHER);
  const good = commitAs(repo, 'b');
  assert.deepEqual(checkPushIdentity(repo, null, [update(good, 'refs/heads/main', foreign)]), []);
  assert.equal(checkPushIdentity(repo, null, [update(good, 'refs/heads/main')]).length, 1);
});

test('a new remote ref skips the commits the remote advertises now', (t) => {
  const repo = newRepo(t);
  const foreign = commitAs(repo, 'a', OTHER);
  const good = commitAs(repo, 'b');
  const url = remoteWith(t, repo, { 'refs/heads/main': foreign });
  assert.deepEqual(checkPushIdentity(repo, url, [update(good, 'refs/heads/plan/y')]), []);
  // No URL, or a URL that cannot be reached, is the strict case: only the remote sha counts.
  assert.equal(checkPushIdentity(repo, null, [update(good, 'refs/heads/plan/y')]).length, 1);
  assert.equal(checkPushIdentity(repo, path.join(tempDir(t), 'missing'), [update(good, 'refs/heads/plan/y')]).length, 1);
  // Another remote has not seen the foreign commit.
  assert.equal(checkPushIdentity(repo, remoteWith(t, repo), [update(good, 'refs/heads/plan/y')]).length, 1);
  // A remote sha this clone does not have: the advertised refs still count.
  assert.deepEqual(checkPushIdentity(repo, url, [update(good, 'refs/heads/main', 'f'.repeat(40))]), []);
});

test('local remote-tracking refs are not trusted: a commit deleted from the remote blocks', (t) => {
  const repo = newRepo(t);
  const base = commitAs(repo, 'a');
  const leaked = commitAs(repo, 'b', OTHER);
  const good = commitAs(repo, 'c');
  // A stale, unpruned tracking ref still holds the commit that was deleted from the remote.
  git(repo, ['update-ref', 'refs/remotes/origin/leak', leaked]);
  const url = remoteWith(t, repo, { 'refs/heads/feat': base });
  const blocks = checkPushIdentity(repo, url, [update(good, 'refs/heads/feat', base)]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes(leaked.slice(0, 7)), blocks[0]);
});

test('an annotated tag with another tagger blocks and names the tagger', (t) => {
  const repo = newRepo(t);
  const commit = commitAs(repo, 'a');
  const tag = tagAs(repo, 'v1.0.0-cc.1', commit, OTHER);
  const blocks = checkPushIdentity(repo, null, [update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /refs\/tags\/v1\.0\.0-cc\.1/);
  assert.match(blocks[0], /tagger Someone Else <someone@example\.invalid>/);
  // Any tag, not only release tags.
  const other = tagAs(repo, 'note', commit, OTHER);
  assert.equal(checkPushIdentity(repo, null, [update(other, 'refs/tags/note')]).length, 1);
});

test('release and import tags must be annotated, other tags may be lightweight', (t) => {
  const repo = newRepo(t);
  const commit = commitAs(repo, 'a');
  for (const ref of ['refs/tags/v1.0.0-cc.1', 'refs/tags/upstream/v1.0.0']) {
    const blocks = checkPushIdentity(repo, null, [update(commit, ref)]);
    assert.equal(blocks.length, 1, ref);
    assert.match(blocks[0], new RegExp(`${ref.replace(/[.\/]/g, '\\$&')}.*lightweight`), ref);
  }
  assert.deepEqual(checkPushIdentity(repo, null, [update(commit, 'refs/tags/note')]), []);
});

test('a pushed tag also checks the commits it publishes', (t) => {
  const repo = newRepo(t);
  const foreign = commitAs(repo, 'a', OTHER);
  const tag = tagAs(repo, 'v1.0.0-cc.1', foreign);
  const blocks = checkPushIdentity(repo, null, [update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes(foreign.slice(0, 7)), blocks[0]);
  // Pushed with its branch, the commit is named once.
  const both = checkPushIdentity(repo, null, [update(foreign, 'refs/heads/main'), update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(both.length, 1);
  assert.match(both[0], /^refs\/heads\/main: /);
});

test('a long list of foreign commits is cut short', (t) => {
  const repo = newRepo(t);
  let tip = null;
  for (let i = 0; i < 12; i += 1) tip = commitAs(repo, `f${i}`, OTHER);
  const blocks = checkPushIdentity(repo, null, [update(tip, 'refs/heads/plan/x')]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /12 new commits/);
  assert.match(blocks[0], /and 2 more/);
});

test('commits already on another remote branch are not new, a new foreign commit still blocks', (t) => {
  const repo = newRepo(t);
  const base = commitAs(repo, 'a');
  // A commit by someone else that is public on the remote's main (say, a PR merged on GitHub).
  git(repo, ['checkout', '-q', '-b', 'pr']);
  const pr = commitAs(repo, 'b', OTHER);
  git(repo, ['checkout', '-q', 'main']);
  const url = remoteWith(t, repo, { 'refs/heads/main': pr, 'refs/heads/plan/x': base });
  // The branch exists on the remote at `base`; merge the remote's main into it.
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge origin/main', pr]);
  const merged = git(repo, ['rev-parse', 'HEAD']);
  assert.deepEqual(checkPushIdentity(repo, url, [update(merged, 'refs/heads/plan/x', base)]), []);

  const fresh = commitAs(repo, 'c', OTHER);
  const blocks = checkPushIdentity(repo, url, [update(fresh, 'refs/heads/plan/x', base)]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /1 new commit is not by/);
  assert.ok(blocks[0].includes(fresh.slice(0, 7)), blocks[0]);
  assert.ok(!blocks[0].includes(pr.slice(0, 7)), blocks[0]);
  // Without a URL only the remote sha counts.
  assert.equal(checkPushIdentity(repo, null, [update(merged, 'refs/heads/plan/x', base)]).length, 1);
  // Another remote has not seen the commit.
  assert.equal(checkPushIdentity(repo, remoteWith(t, repo, { 'refs/heads/plan/x': base }),
    [update(merged, 'refs/heads/plan/x', base)]).length, 1);
});

// Published release and import tags.
const TAG = 'refs/tags/v1.0.0-cc.1';

test('a published annotated release or import tag is never replaced, moved or deleted', (t) => {
  const repo = newRepo(t);
  const first = commitAs(repo, 'a');
  const second = commitAs(repo, 'b');
  const tagObj = tagAs(repo, 'v1.0.0-cc.1', first);
  const other = tagAs(repo, 'other', first);
  const moved = tagAs(repo, 'moved', second);
  for (const ref of [TAG, 'refs/tags/upstream/v1.0.0']) {
    // Same object: nothing changes. A new tag has no remote sha.
    assert.deepEqual(checkPublishedTags(repo, [update(tagObj, ref, tagObj), update(tagObj, ref)]), [], ref);
    // Replaced by another tag object, moved to another commit, deleted.
    for (const local of [other, moved, ZERO]) {
      const blocks = checkPublishedTags(repo, [update(local, ref, tagObj)]);
      assert.equal(blocks.length, 1, `${ref} ${local}`);
      assert.match(blocks[0], new RegExp(`^${ref.replace(/[.\/]/g, '\\$&')}: .*annotated`), blocks[0]);
    }
  }
  // Other tags are not guarded.
  assert.deepEqual(checkPublishedTags(repo, [update(moved, 'refs/tags/note', tagObj), update(ZERO, 'refs/tags/note', tagObj)]), []);
});

test('a lightweight release tag on the remote may be replaced on the same commit or deleted', (t) => {
  const repo = newRepo(t);
  const first = commitAs(repo, 'a');
  const second = commitAs(repo, 'b');
  const same = tagAs(repo, 'v1.0.0-cc.1', first);
  const moved = tagAs(repo, 'moved', second);
  assert.deepEqual(checkPublishedTags(repo, [update(same, TAG, first)]), []);
  assert.deepEqual(checkPublishedTags(repo, [update(first, TAG, first)]), []);
  assert.deepEqual(checkPublishedTags(repo, [update(ZERO, TAG, first)]), []);
  const blocks = checkPublishedTags(repo, [update(moved, TAG, first)]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /commit/);
  // A local object that is not a commit and does not peel to one.
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  assert.equal(checkPublishedTags(repo, [update(tree, TAG, first)]).length, 1);
});

test('a remote sha this clone does not have blocks a release tag update: fetch first', (t) => {
  const repo = newRepo(t);
  const first = commitAs(repo, 'a');
  const tag = tagAs(repo, 'v1.0.0-cc.1', first);
  for (const local of [tag, ZERO]) {
    const blocks = checkPublishedTags(repo, [update(local, TAG, 'f'.repeat(40))]);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /fetch/);
    assert.match(blocks[0], /would clobber existing tag/);
    assert.match(blocks[0], /"Lightweight release tag" in CLAUDE\.md/);
  }
});
