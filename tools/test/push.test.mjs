import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from '../lib/git.mjs';
import { IDENTITY } from '../lib/constants.mjs';
import { checkPushIdentity } from '../lib/push.mjs';
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
  assert.deepEqual(checkPushIdentity(repo, 'origin', [
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
  const blocks = checkPushIdentity(repo, 'origin', [update(committer, 'refs/heads/plan/x')]);
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
  assert.deepEqual(checkPushIdentity(repo, 'origin', [update(good, 'refs/heads/main', foreign)]), []);
  assert.equal(checkPushIdentity(repo, 'origin', [update(good, 'refs/heads/main')]).length, 1);
});

test('a new remote ref skips the commits on the remote-tracking refs of that remote', (t) => {
  const repo = newRepo(t);
  const foreign = commitAs(repo, 'a', OTHER);
  git(repo, ['update-ref', 'refs/remotes/origin/main', foreign]);
  const good = commitAs(repo, 'b');
  assert.deepEqual(checkPushIdentity(repo, 'origin', [update(good, 'refs/heads/plan/y')]), []);
  // Another remote, or no remote name at all, has not seen the foreign commit.
  assert.equal(checkPushIdentity(repo, 'backup', [update(good, 'refs/heads/plan/y')]).length, 1);
  assert.equal(checkPushIdentity(repo, null, [update(good, 'refs/heads/plan/y')]).length, 1);
  // A remote sha this clone does not have falls back to the remote-tracking refs.
  assert.deepEqual(checkPushIdentity(repo, 'origin', [update(good, 'refs/heads/main', 'f'.repeat(40))]), []);
});

test('an annotated tag with another tagger blocks and names the tagger', (t) => {
  const repo = newRepo(t);
  const commit = commitAs(repo, 'a');
  const tag = tagAs(repo, 'v1.0.0-cc.1', commit, OTHER);
  const blocks = checkPushIdentity(repo, 'origin', [update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /refs\/tags\/v1\.0\.0-cc\.1/);
  assert.match(blocks[0], /tagger Someone Else <someone@example\.invalid>/);
  // Any tag, not only release tags.
  const other = tagAs(repo, 'note', commit, OTHER);
  assert.equal(checkPushIdentity(repo, 'origin', [update(other, 'refs/tags/note')]).length, 1);
});

test('release and import tags must be annotated, other tags may be lightweight', (t) => {
  const repo = newRepo(t);
  const commit = commitAs(repo, 'a');
  for (const ref of ['refs/tags/v1.0.0-cc.1', 'refs/tags/upstream/v1.0.0']) {
    const blocks = checkPushIdentity(repo, 'origin', [update(commit, ref)]);
    assert.equal(blocks.length, 1, ref);
    assert.match(blocks[0], new RegExp(`${ref.replace(/[.\/]/g, '\\$&')}.*lightweight`), ref);
  }
  assert.deepEqual(checkPushIdentity(repo, 'origin', [update(commit, 'refs/tags/note')]), []);
});

test('a pushed tag also checks the commits it publishes', (t) => {
  const repo = newRepo(t);
  const foreign = commitAs(repo, 'a', OTHER);
  const tag = tagAs(repo, 'v1.0.0-cc.1', foreign);
  const blocks = checkPushIdentity(repo, 'origin', [update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes(foreign.slice(0, 7)), blocks[0]);
  // Pushed with its branch, the commit is named once.
  const both = checkPushIdentity(repo, 'origin', [update(foreign, 'refs/heads/main'), update(tag, 'refs/tags/v1.0.0-cc.1')]);
  assert.equal(both.length, 1);
  assert.match(both[0], /^refs\/heads\/main: /);
});

test('a long list of foreign commits is cut short', (t) => {
  const repo = newRepo(t);
  let tip = null;
  for (let i = 0; i < 12; i += 1) tip = commitAs(repo, `f${i}`, OTHER);
  const blocks = checkPushIdentity(repo, 'origin', [update(tip, 'refs/heads/plan/x')]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /12 new commits/);
  assert.match(blocks[0], /and 2 more/);
});
