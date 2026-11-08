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

// git runs the hook with the remote name and its URL as arguments.
const runHook = (cwd, line, remote = 'origin') =>
  spawnSync(process.execPath, [HOOK, remote, remote], { cwd, input: line + '\n', encoding: 'utf8' });
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

test('a foreign commit already on the remote does not block', (t) => {
  const { repo } = makeRepo(t);
  writeFiles(repo, { 'notes.md': 'From someone else.\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs: notes'], { env: as(OTHER) });
  const foreign = git(repo, ['rev-parse', 'HEAD']);
  writeFiles(repo, { 'notes.md': 'Ours on top.\n' });
  const ours = commitAll(repo, 'docs: our notes');
  assert.equal(hook(repo, `refs/heads/plan/x ${ours} refs/heads/plan/x ${foreign}`), 0);
  // The same commit on a new remote branch: the remote-tracking refs of the remote count.
  assert.equal(hook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`), 1);
  git(repo, ['update-ref', 'refs/remotes/origin/plan/x', foreign]);
  assert.equal(hook(repo, `refs/heads/plan/y ${ours} refs/heads/plan/y ${ZERO}`), 0);
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
