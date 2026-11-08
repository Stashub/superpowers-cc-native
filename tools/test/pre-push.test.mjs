import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, run } from '../lib/git.mjs';
import { runSync } from '../sync.mjs';
import {
  commitAll, initRepo, makeOrigin, seedMain, tempDir, writeFiles,
} from './helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/pre-push', import.meta.url));
const ZERO = '0'.repeat(40);
const NODE_WARNING = /\(node:\d+\)|Warning:/;

const OTHER = { name: 'Someone Else', email: 'someone@example.invalid' };

// git runs the hook with the remote name and its URL as arguments (for a push to a bare URL,
// both are the URL).
const runHook = (cwd, line, remote = 'origin', url = remote) =>
  spawnSync(process.execPath, [HOOK, remote, url], { cwd, input: line + '\n', encoding: 'utf8' });
const hook = (cwd, line) => runHook(cwd, line).status;
// The environment that makes git use `who` as author, committer and tagger.
const as = (who) => ({
  GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
  GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
});

// main at the tagged first release v1.0.0-cc.1 (`tagged`) of an imported v1.0.0. On plan/x
// (HEAD) a commit changes plugin/ without a release (`untagged`). `handCommit` is a commit on
// top of upstream that sync.mjs did not make: it has no seal.
function makeRepo(t) {
  const origin = makeOrigin(t, [{ tag: 'v1.0.0' }]);
  const repo = tempDir(t);
  initRepo(repo);
  seedMain(repo);
  runSync({ repo, tag: 'v1.0.0', from: origin, check: false });
  writeFiles(repo, { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 1.0.0-cc.1 - 2026-11-08\n' });
  const tagged = commitAll(repo, 'Release v1.0.0-cc.1');
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', 'sync/v1.0.0']);
  git(repo, ['tag', '-a', '-m', 'Release v1.0.0-cc.1', 'v1.0.0-cc.1']);
  git(repo, ['checkout', '-q', '-b', 'plan/x']);
  writeFiles(repo, { 'plugin/skills/demo/SKILL.md': 'Our own wording.\n' });
  const untagged = commitAll(repo, 'feat: our edit');
  const handCommit = git(repo, ['commit-tree', 'upstream^{tree}', '-p', 'upstream', '-m', 'hand edit']);
  return { repo, tagged, untagged, handCommit };
}

test('blocks main without a release tag and allows a tagged release', (t) => {
  const { repo, tagged, untagged } = makeRepo(t);
  assert.equal(hook(repo, `refs/heads/main ${untagged} refs/heads/main ${ZERO}`), 1);
  assert.equal(hook(repo, `refs/heads/main ${tagged} refs/heads/main ${ZERO}`), 0);

  const res = runHook(repo, `refs/heads/main ${untagged} refs/heads/main ${tagged}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main/);
  assert.match(res.stderr, /not-released/);
  assert.match(res.stderr, /1\.0\.0-cc\.2/);
  assert.doesNotMatch(res.stderr, NODE_WARNING);
});

test('blocks a hand-edited upstream', (t) => {
  const { repo, handCommit } = makeRepo(t);
  assert.equal(hook(repo, `refs/heads/upstream ${handCommit} refs/heads/upstream ${ZERO}`), 1);
  assert.match(runHook(repo, `refs/heads/upstream ${handCommit} refs/heads/upstream ${ZERO}`).stderr, /upstream/);
  const sealed = git(repo, ['rev-parse', 'upstream']);
  assert.equal(hook(repo, `refs/heads/upstream ${sealed} refs/heads/upstream ${ZERO}`), 0);
});

test('blocks deleting main or upstream', (t) => {
  const { repo, tagged } = makeRepo(t);
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/main ${tagged}`), 1);
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/upstream ${tagged}`), 1);
  assert.match(runHook(repo, `(delete) ${ZERO} refs/heads/main ${tagged}`).stderr, /delet/);
});

test('other branches and tags skip the release checks', (t) => {
  const { repo, tagged, untagged } = makeRepo(t);
  assert.equal(hook(repo, `refs/heads/plan/x ${untagged} refs/heads/plan/x ${ZERO}`), 0);
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/plan/x ${untagged}`), 0);
  const tag = git(repo, ['rev-parse', 'refs/tags/v1.0.0-cc.1']);
  assert.equal(hook(repo, `refs/tags/v1.0.0-cc.1 ${tag} refs/tags/v1.0.0-cc.1 ${ZERO}`), 0);
  // One blocked ref in the push blocks all of it.
  assert.equal(hook(repo, [
    `refs/heads/plan/x ${untagged} refs/heads/plan/x ${ZERO}`,
    `refs/heads/plan/x ${untagged} refs/heads/main ${tagged}`,
  ].join('\n')), 1);
});

test('blocks a new commit by another author on any branch', (t) => {
  const { repo, untagged } = makeRepo(t);
  writeFiles(repo, { 'notes.md': 'From someone else.\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs: notes'], { env: { GIT_AUTHOR_NAME: OTHER.name, GIT_AUTHOR_EMAIL: OTHER.email } });
  const foreign = git(repo, ['rev-parse', 'HEAD']);
  const res = runHook(repo, `refs/heads/plan/x ${foreign} refs/heads/plan/x ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^pre-push: blocked: refs\/heads\/plan\/x: 1 new commit is not by Stashub/m);
  assert.ok(res.stderr.includes(`${foreign.slice(0, 7)} author Someone Else <someone@example.invalid>`), res.stderr);
  assert.ok(!res.stderr.includes(untagged.slice(0, 7)), res.stderr);
  assert.doesNotMatch(res.stderr, NODE_WARNING);
});

// A bare repository that stands for the remote, added to `repo` as origin; returns its path.
function addOrigin(t, repo) {
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare']);
  git(repo, ['remote', 'add', 'origin', bare]);
  return bare;
}

test('a foreign commit that the remote advertises does not block, local tracking refs do not count', (t) => {
  const { repo } = makeRepo(t);
  writeFiles(repo, { 'notes.md': 'From someone else.\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs: notes'], { env: as(OTHER) });
  const foreign = git(repo, ['rev-parse', 'HEAD']);
  writeFiles(repo, { 'notes.md': 'Ours on top.\n' });
  const ours = commitAll(repo, 'docs: our notes');
  // The remote sha is the foreign commit.
  assert.equal(hook(repo, `refs/heads/plan/x ${ours} refs/heads/plan/x ${foreign}`), 0);
  // The same commit on a new remote branch: the remote has to advertise it.
  const bare = addOrigin(t, repo);
  assert.equal(hook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`), 1);
  // A tracking ref in this clone is not trusted (it may be stale).
  git(repo, ['update-ref', 'refs/remotes/origin/plan/x', foreign]);
  assert.equal(runHook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`, 'origin', bare).status, 1);
  // The remote advertises it: a named remote and a push to the bare URL behave the same.
  git(repo, ['push', '-q', '--no-verify', bare, `${foreign}:refs/heads/other`]);
  assert.equal(runHook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`, 'origin', bare).status, 0);
  assert.equal(runHook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`, bare).status, 0);
  // A URL that cannot be reached is the strict case.
  const gone = path.join(bare, 'missing');
  assert.equal(runHook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`, gone).status, 1);
});

test('a real git push: a foreign commit deleted from the remote blocks even when a tracking ref keeps it', (t) => {
  const { repo } = makeRepo(t);
  const bare = addOrigin(t, repo);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const push = (...args) => spawnSync('git', ['push', '-q', 'origin', ...args], { cwd: repo, encoding: 'utf8', env });
  const base = git(repo, ['rev-parse', 'HEAD']);
  const leaked = foreignCommit(repo);
  // The leak was on the remote, then deleted there; the clone fetched it before and kept the ref.
  git(repo, ['push', '-q', '--no-verify', 'origin', `${base}:refs/heads/feat`, `${leaked}:refs/heads/leak`]);
  git(repo, ['fetch', '-q', 'origin']);
  git(bare, ['update-ref', '-d', 'refs/heads/leak']);
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/leak']), leaked);
  git(repo, ['config', '--local', 'core.hooksPath', path.dirname(HOOK)]);
  writeFiles(repo, { 'more.md': 'Ours.\n' });
  const ours = commitAll(repo, 'docs: more');
  let res = push(`${ours}:refs/heads/feat`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refs\/heads\/feat: 1 new commit is not by Stashub/);
  assert.ok(res.stderr.includes(leaked.slice(0, 7)), res.stderr);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/feat']), base);

  // Still on another remote branch: not new.
  git(repo, ['push', '-q', '--no-verify', 'origin', `${leaked}:refs/heads/other`]);
  res = push(`${ours}:refs/heads/feat`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/feat']), ours);
});

test('blocks an annotated tag with another tagger', (t) => {
  const { repo, tagged } = makeRepo(t);
  git(repo, ['tag', '-a', '-m', 'note', 'note', tagged], { env: as(OTHER) });
  const tag = git(repo, ['rev-parse', 'refs/tags/note']);
  const res = runHook(repo, `refs/tags/note ${tag} refs/tags/note ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^pre-push: blocked: refs\/tags\/note: .*tagger Someone Else <someone@example\.invalid>/m);
});

test('blocks a lightweight release tag', (t) => {
  const { repo, tagged } = makeRepo(t);
  const res = runHook(repo, `refs/tags/v1.0.0-cc.1 ${tagged} refs/tags/v1.0.0-cc.1 ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^pre-push: blocked: refs\/tags\/v1\.0\.0-cc\.1: a lightweight tag/m);
});

test('a real git push to a bare remote is blocked through core.hooksPath', (t) => {
  const { repo, tagged } = makeRepo(t);
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare']);
  git(repo, ['config', '--local', 'core.hooksPath', path.dirname(HOOK)]);
  // The hook starts with "#!/usr/bin/env node": the node that runs the tests comes first.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const push = (...args) => spawnSync('git', ['push', '-q', bare, ...args], { cwd: repo, encoding: 'utf8', env });

  let res = push(`${tagged}:refs/heads/main`);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, NODE_WARNING);

  // main with the unreleased plugin/ change of plan/x.
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', 'plan/x']);
  res = spawnSync('git', ['push', bare, 'main'], { cwd: repo, encoding: 'utf8', env });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not-released/);
  assert.doesNotMatch(res.stderr, NODE_WARNING);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tagged);
});

test('a real git push --follow-tags of a correct release passes, a foreign tagger blocks it', (t) => {
  const { repo } = makeRepo(t);
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare']);
  git(repo, ['config', '--local', 'core.hooksPath', path.dirname(HOOK)]);
  git(repo, ['remote', 'add', 'origin', bare]);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const push = () => spawnSync('git', ['push', '-q', '--follow-tags', 'origin', 'main', 'upstream'], {
    cwd: repo, encoding: 'utf8', env,
  });

  let res = push();
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, NODE_WARNING);
  assert.equal(git(bare, ['for-each-ref', '--format=%(objecttype) %(refname)', 'refs/tags']),
    'tag refs/tags/upstream/v1.0.0\ntag refs/tags/v1.0.0-cc.1');

  // An annotated tag by someone else on main goes out with --follow-tags and blocks the push.
  git(repo, ['tag', '-a', '-m', 'note', 'note', 'main'], { env: as(OTHER) });
  res = push();
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refs\/tags\/note: .*tagger Someone Else/);
  assert.equal(run(bare, ['rev-parse', '--verify', '-q', 'refs/tags/note']).status, 1);
});

// A commit by OTHER on top of HEAD (plan/x); returns its sha.
function foreignCommit(repo, message = 'docs: notes') {
  writeFiles(repo, { 'notes.md': 'From someone else.\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message], { env: as(OTHER) });
  return git(repo, ['rev-parse', 'HEAD']);
}

test('a local ref with spaces still runs the identity and release checks', (t) => {
  const { repo, tagged, untagged } = makeRepo(t);
  const foreign = foreignCommit(repo);
  const spaced = 'main^{/two words}';
  let res = runHook(repo, `${spaced} ${foreign} refs/heads/plan/x ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /refs\/heads\/plan\/x: 1 new commit is not by Stashub/);
  assert.equal(hook(repo, `${spaced} ${untagged} refs/heads/main ${ZERO}`), 1);
  assert.equal(hook(repo, `${spaced} ${tagged} refs/heads/main ${ZERO}`), 0);
  res = runHook(repo, `${spaced} ${untagged} refs/heads/main ${tagged}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not-released/);
});

test('a real git push with a spaced local ref is checked', (t) => {
  const { repo, tagged } = makeRepo(t);
  foreignCommit(repo, 'two words');
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare']);
  git(repo, ['config', '--local', 'core.hooksPath', path.dirname(HOOK)]);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const push = (src, dst) => spawnSync('git', ['push', '-q', bare, `${src}:${dst}`], { cwd: repo, encoding: 'utf8', env });

  let res = push('plan/x^{/two words}', 'refs/heads/x');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refs\/heads\/x: 1 new commit is not by Stashub/);
  assert.equal(run(bare, ['rev-parse', '--verify', '-q', 'refs/heads/x']).status, 1);

  res = push('plan/x^{/our edit}', 'refs/heads/main');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not-released/);
  assert.equal(run(bare, ['rev-parse', '--verify', '-q', 'refs/heads/main']).status, 1);

  res = push('main^{/Release v1.0.0-cc.1}', 'refs/heads/main');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tagged);
});

test('a line ending in CRLF or with trailing spaces is parsed correctly', (t) => {
  const { repo, tagged, untagged } = makeRepo(t);
  const foreign = foreignCommit(repo);
  const good = `refs/heads/main ${tagged} refs/heads/main ${ZERO}`;
  assert.equal(runHook(repo, good + '\r').status, 0);
  assert.equal(runHook(repo, good + '  ').status, 0);
  assert.equal(runHook(repo, '  ' + good + ' \r').status, 0);
  const bad = `refs/heads/main ${untagged} refs/heads/main ${ZERO}`;
  assert.equal(runHook(repo, bad + '\r').status, 1);
  assert.match(runHook(repo, bad + '  ').stderr, /not-released/);
  const other = `refs/heads/plan/x ${foreign} refs/heads/plan/x ${ZERO}`;
  assert.match(runHook(repo, other + '\r').stderr, /1 new commit is not by Stashub/);
  assert.match(runHook(repo, other + '   ').stderr, /1 new commit is not by Stashub/);
});

test('a malformed line blocks and is named', (t) => {
  const { repo, tagged } = makeRepo(t);
  let res = runHook(repo, `refs/heads/main ${tagged} refs/heads/main`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^pre-push: blocked: .*malformed/m);
  assert.ok(res.stderr.includes(`refs/heads/main ${tagged} refs/heads/main`), res.stderr);
  // A sha that is not 40 or 64 hex chars.
  res = runHook(repo, `refs/heads/main ${tagged.slice(0, 39)} refs/heads/main ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /malformed/);
  res = runHook(repo, `refs/heads/main ${tagged} refs/heads/main ${'g'.repeat(40)}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /malformed/);
  // A blank line is skipped; a SHA-256 length is accepted as well-formed.
  assert.equal(runHook(repo, `\n\nrefs/heads/main ${tagged} refs/heads/main ${ZERO}\n`).status, 0);
  res = runHook(repo, `refs/heads/plan/x ${'a'.repeat(64)} refs/heads/plan/x ${'0'.repeat(64)}`);
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stderr, /malformed/);
});

test('a non-zero local sha that is not in this clone blocks', (t) => {
  const { repo } = makeRepo(t);
  const unknown = 'a'.repeat(40);
  const res = runHook(repo, `refs/heads/plan/x ${unknown} refs/heads/plan/x ${ZERO}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`cannot resolve ${unknown} for refs/heads/plan/x`));
  assert.equal(runHook(repo, `refs/tags/note ${unknown} refs/tags/note ${ZERO}`).status, 1);
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/plan/x ${unknown}`), 0);
});

test('a lightweight release tag on the remote is replaced or deleted by the CLAUDE.md commands, an annotated one is kept', (t) => {
  const { repo, tagged, untagged } = makeRepo(t);
  const bare = addOrigin(t, repo);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  const remote = (...args) => run(bare, args).stdout.toString().trim();
  const TAG = 'v1.0.0-cc.1';
  const REF = `refs/tags/${TAG}`;

  // A GitHub release made in the web UI: a lightweight tag on the remote, the hook not involved.
  // This clone fetches it over its own annotated tag, as another clone would.
  let res = sh('push', '--no-verify', '-q', 'origin', `${tagged}:refs/heads/main`, `${tagged}:${REF}`);
  assert.equal(res.status, 0, res.stderr);
  git(repo, ['tag', '-d', TAG]);
  assert.equal(sh('fetch', '-q', 'origin', '--tags').status, 0);
  assert.equal(git(repo, ['cat-file', '-t', TAG]), 'commit');
  git(repo, ['config', '--local', 'core.hooksPath', path.dirname(HOOK)]);

  // Look at the remote: one line, no ^{} line, so it is lightweight and names commit C.
  assert.equal(remote('for-each-ref', '--format=%(objecttype)', REF), 'commit');
  const c = tagged;
  res = sh('ls-remote', 'origin', REF, `${REF}^{}`);
  assert.equal(res.stdout.trim().split('\n').length, 1);
  assert.ok(res.stdout.startsWith(c), res.stdout);

  // Replace it on the same commit, with the lease.
  assert.equal(sh('tag', '-f', '-a', '-m', `Release ${TAG}`, TAG, c).status, 0);
  res = sh('push', '--force-with-lease=' + `${REF}:${c}`, 'origin', REF);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, NODE_WARNING);
  assert.equal(remote('cat-file', '-t', REF), 'tag');
  assert.equal(remote('rev-parse', `${REF}^{commit}`), c);
  assert.match(sh('ls-remote', 'origin', REF, `${REF}^{}`).stdout, /\^\{\}/);

  // An annotated remote tag is never replaced, moved or deleted, force or not.
  const published = remote('rev-parse', REF);
  sh('tag', '-f', '-a', '-m', 'again', TAG, c);
  res = sh('push', '--force', 'origin', REF);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /annotated tag/);
  sh('tag', '-f', '-a', '-m', 'moved', TAG, untagged);
  res = sh('push', '--force', 'origin', REF);
  assert.notEqual(res.status, 0);
  res = sh('push', 'origin', `:${REF}`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /annotated tag/);
  assert.equal(remote('rev-parse', REF), published);
  // The way to take the remote tag instead.
  assert.equal(sh('fetch', '-q', 'origin', '--force', `${REF}:${REF}`).status, 0);
  assert.equal(git(repo, ['rev-parse', REF]), published);
  assert.equal(sh('fetch', '-q', 'origin', '--tags').status, 0);

  // A lightweight tag that is not a release is deleted with the lease; the lease also keeps a
  // stale delete from touching a tag that has changed.
  const other = 'v1.0.0-cc.2';
  assert.equal(sh('push', '--no-verify', '-q', 'origin', `${untagged}:refs/tags/${other}`).status, 0);
  res = sh('push', `--force-with-lease=refs/tags/${other}:${tagged}`, 'origin', `:refs/tags/${other}`);
  assert.notEqual(res.status, 0);
  assert.equal(remote('rev-parse', `refs/tags/${other}`), untagged);
  res = sh('push', `--force-with-lease=refs/tags/${other}:${untagged}`, 'origin', `:refs/tags/${other}`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(run(bare, ['rev-parse', '--verify', '-q', `refs/tags/${other}`]).status, 1);
});
