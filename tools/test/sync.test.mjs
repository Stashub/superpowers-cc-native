import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/git.mjs';
import { verifySeals } from '../lib/upstream.mjs';
import { runSync } from '../sync.mjs';
import {
  commitAll, initRepo, makeFakeClaude, makeOrigin, seedMain, tempDir, writeFiles,
} from './helpers.mjs';

const SYNC = fileURLToPath(new URL('../sync.mjs', import.meta.url));
const SKILL = 'plugin/skills/demo/SKILL.md';

// Two releases of a fake original: v1.1.0 changes only README.md.
const RELEASES = [{ tag: 'v1.0.0' }, { tag: 'v1.1.0', files: { 'README.md': '# Superpowers 1.1\n' } }];

// A repo with a seeded main, as a fresh checkout of our fork would be.
function newRepo(t) {
  const repo = tempDir(t);
  initRepo(repo);
  seedMain(repo);
  return repo;
}

const sync = (repo, tag, origin) => runSync({ repo, tag, from: origin, check: false });

// What the owner does after a release: main takes the sync branch, the branch goes away.
function finishToMain(repo, tag) {
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', `sync/${tag}`]);
  git(repo, ['branch', '-q', '-d', `sync/${tag}`]);
}

// main has v1.0.0 merged; our edit and the original's v1.1.0 edit hit the same line.
function setupConflict(t) {
  const origin = makeOrigin(t, [
    { tag: 'v1.0.0' },
    { tag: 'v1.1.0', files: { 'skills/demo/SKILL.md': 'Original changed this line.\n' } },
  ]);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  finishToMain(repo, 'v1.0.0');
  writeFiles(repo, { [SKILL]: 'We changed this line.\n' });
  commitAll(repo, 'feat: our edit');
  return { origin, repo };
}

test('first import creates sealed upstream and merges into sync branch', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  const res = sync(repo, 'v1.0.0', origin);
  assert.equal(res.status, 'merged');
  assert.equal(res.branch, 'sync/v1.0.0');
  assert.equal(res.imported, true);
  assert.deepEqual(res.conflicts, []);
  assert.equal(git(repo, ['rev-list', '--count', 'upstream']), '1');
  assert.deepEqual(verifySeals(repo, 'upstream'), []);
  assert.equal(git(repo, ['branch', '--show-current']), 'sync/v1.0.0');
  assert.equal(git(repo, ['log', '-1', '--format=%s']), 'Merge upstream v1.0.0');
  assert.equal(existsSync(join(repo, 'plugin/.claude-plugin/marketplace.json')), false);
  assert.equal(existsSync(join(repo, 'plugin/skills/demo/SKILL.md')), true);
  assert.equal(res.numstat, '');
});

test('second release merges cleanly with the previous import as base', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  const firstImport = git(repo, ['rev-parse', 'upstream']);
  finishToMain(repo, 'v1.0.0');
  const res = sync(repo, 'v1.1.0', origin);
  assert.equal(res.status, 'merged');
  assert.equal(res.imported, true);
  assert.equal(res.branch, 'sync/v1.1.0');
  assert.deepEqual(res.conflicts, []);
  assert.equal(git(repo, ['rev-parse', 'upstream^']), firstImport);
  assert.equal(git(repo, ['show', 'HEAD:plugin/README.md']), '# Superpowers 1.1');
});

test('numstat counts our lines in upstream files', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  finishToMain(repo, 'v1.0.0');
  writeFiles(repo, { [SKILL]: 'Use superpowers-cc-native:demo first.\nOur extra line.\n' });
  commitAll(repo, 'feat: our edit');
  const res = sync(repo, 'v1.1.0', origin);
  assert.equal(res.status, 'merged');
  assert.equal(res.numstat, `1\t0\t${SKILL}`);
});

test('conflict reports files and the CLI exits with 2', (t) => {
  const { origin, repo } = setupConflict(t);
  const res = sync(repo, 'v1.1.0', origin);
  assert.equal(res.status, 'conflict');
  assert.equal(res.imported, true);
  assert.equal(res.branch, 'sync/v1.1.0');
  assert.deepEqual(res.conflicts, [SKILL]);
  assert.equal(git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).length, 40);

  const second = setupConflict(t);
  const cli = spawnSync(process.execPath, [SYNC, 'v1.1.0', '--from', second.origin], {
    cwd: second.repo, encoding: 'utf8',
  });
  assert.equal(cli.status, 2);
  assert.match(cli.stdout, /conflict/);
  assert.ok(cli.stdout.includes(SKILL));
});

test('rerun of a merged tag is nothing-to-do and changes no refs', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  const before = git(repo, ['for-each-ref']);
  const onBranch = sync(repo, 'v1.0.0', origin);
  assert.equal(onBranch.status, 'nothing-to-do');
  assert.equal(onBranch.imported, false);
  assert.equal(git(repo, ['for-each-ref']), before);

  finishToMain(repo, 'v1.0.0');
  const afterFinish = git(repo, ['for-each-ref']);
  assert.equal(sync(repo, 'v1.0.0', origin).status, 'nothing-to-do');
  assert.equal(git(repo, ['for-each-ref']), afterFinish);
});

test('imported but unmerged tag is merged on rerun', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'sync/v1.0.0']);
  const res = sync(repo, 'v1.0.0', origin);
  assert.equal(res.imported, false);
  assert.equal(res.status, 'merged');
  assert.equal(res.branch, 'sync/v1.0.0');
  assert.equal(git(repo, ['rev-list', '--count', 'upstream']), '1');
});

test('interrupted run recreates a missing upstream tag', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  finishToMain(repo, 'v1.0.0');
  git(repo, ['tag', '-d', 'upstream/v1.0.0']);
  sync(repo, 'v1.0.0', origin);
  assert.equal(git(repo, ['cat-file', '-t', 'upstream/v1.0.0']), 'tag');
});

test('refuses to run outside main and leaves the branch alone', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  git(repo, ['checkout', '-q', '-b', 'plan/x']);
  assert.throws(() => sync(repo, 'v1.0.0', origin), { code: 'not-on-main' });
  assert.equal(git(repo, ['branch', '--show-current']), 'plan/x');
  assert.equal(git(repo, ['branch', '--list', 'upstream']), '');
});

test('CLI works from a subdirectory', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  sync(repo, 'v1.0.0', origin);
  finishToMain(repo, 'v1.0.0');
  const cli = spawnSync(process.execPath, [SYNC, 'v1.0.0', '--from', origin], {
    cwd: join(repo, 'plugin/skills'), encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /nothing-to-do/);
});

test('CLI resolves a relative --from against the invoking directory', (t) => {
  // The original is fetched before the not-upstream stop, so a broken path would stop with "git".
  const origin = makeOrigin(t, [{ tag: 'v1.0.0', pluginName: 'other' }]);
  const repo = newRepo(t);
  const cwd = join(repo, 'plugin');
  mkdirSync(cwd);
  const cli = spawnSync(process.execPath, [SYNC, 'v1.0.0', '--from', relative(cwd, origin)], {
    cwd, encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^stop \(not-upstream\): /);
});

test('CLI reports a stop on stderr and exits with 1', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  const cli = spawnSync(process.execPath, [SYNC, 'v1.1.0-rc.1', '--from', origin], {
    cwd: repo, encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^stop \(bad-tag\): /);
});

test('CLI identity stop names every overriding variable and the command to rerun', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  const cli = spawnSync(process.execPath, [SYNC, 'v1.0.0', '--from', origin], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Someone Else', GIT_COMMITTER_NAME: 'Someone Else' },
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^stop \(identity\): /);
  assert.ok(cli.stderr.includes('env -u GIT_AUTHOR_NAME -u GIT_COMMITTER_NAME node tools/sync.mjs v1.0.0'), cli.stderr);
  assert.equal(cli.stderr.trim().split('\n').length, 1, cli.stderr);
});

test('CLI rejects missing and unknown arguments with exit 1', (t) => {
  const repo = newRepo(t);
  for (const args of [[], ['v1.0.0', '--frm', 'x'], ['v1.0.0', 'v1.1.0'], ['v1.0.0', '--from']]) {
    const cli = spawnSync(process.execPath, [SYNC, ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(cli.status, 1, args.join(' '));
    assert.match(cli.stderr, /usage/i);
  }
});

// Builds the state of one stop case; every case reaches exactly its own stop.
function prepareStop(t, code) {
  const origin = makeOrigin(t, code === 'not-upstream' ? [{ tag: 'v1.0.0', pluginName: 'other' }] : RELEASES);
  const repo = newRepo(t);
  let tag = 'v1.0.0';
  switch (code) {
    case 'dirty':
      writeFiles(repo, { 'scratch.txt': 'uncommitted\n' });
      break;
    case 'identity':
      git(repo, ['config', '--local', '--unset', 'user.email']);
      break;
    case 'bad-tag':
      tag = 'v1.1.0-rc.1';
      break;
    case 'no-such-tag':
      tag = 'v9.9.9';
      break;
    case 'not-newer':
      sync(repo, 'v1.1.0', origin);
      finishToMain(repo, 'v1.1.0');
      break;
    case 'not-upstream':
      break;
    case 'upstream-edited': {
      sync(repo, 'v1.0.0', origin);
      finishToMain(repo, 'v1.0.0');
      const tip = git(repo, ['rev-parse', 'upstream']);
      const hand = git(repo, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'hand made']);
      git(repo, ['update-ref', 'refs/heads/upstream', hand]);
      tag = 'v1.1.0';
      break;
    }
    case 'branch-exists':
      git(repo, ['branch', 'sync/v1.0.0']);
      break;
    default:
      throw new Error(`unknown case ${code}`);
  }
  if (code === 'not-newer') tag = 'v1.0.0';
  return { origin, repo, tag };
}

for (const code of [
  'dirty', 'identity', 'bad-tag', 'no-such-tag', 'not-newer', 'not-upstream',
  'upstream-edited', 'branch-exists',
]) {
  test(`stops with ${code}`, (t) => {
    const { origin, repo, tag } = prepareStop(t, code);
    assert.throws(() => sync(repo, tag, origin), { code });
  });
}

test('a bad tag stops before anything is fetched', (t) => {
  // origin cannot be reached, so a fetch before the tag check would stop with "git".
  const repo = newRepo(t);
  const missing = join(tempDir(t), 'missing');
  git(repo, ['remote', 'add', 'origin', missing]);
  assert.throws(() => sync(repo, 'v1.1.0-rc.1', missing), { code: 'bad-tag' });
  assert.equal(git(repo, ['branch', '--show-current']), 'main');
  assert.equal(git(repo, ['branch', '--list', 'upstream']), '');
});

test('a merge that fails without conflicts is a git error, not a conflict', (t) => {
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  // An untracked file that the merge would overwrite makes git refuse, with no unmerged paths.
  writeFiles(repo, { 'plugin/README.md': 'untracked\n' });
  git(repo, ['config', '--local', 'status.showUntrackedFiles', 'no']);
  assert.throws(() => sync(repo, 'v1.0.0', origin), { code: 'git' });
});

test('a failing check.mjs after a clean merge stops sync with check-failed', (t) => {
  // The fake original has no tests/, so the original-test findings fail in the spawned check.mjs.
  // runSync runs in a child process: the check inherits its stdio, and here that is captured
  // instead of landing in the test log. The last line of stdout is the outcome.
  const origin = makeOrigin(t, RELEASES);
  const repo = newRepo(t);
  const fake = makeFakeClaude(t);
  const script = `
    import { runSync } from ${JSON.stringify(new URL('../sync.mjs', import.meta.url).href)};
    try {
      const res = runSync({ repo: process.argv[1], tag: 'v1.0.0', from: process.argv[2], check: true });
      console.log('returned ' + res.status);
    } catch (err) {
      console.log('threw ' + err.code + ': ' + err.message);
    }`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script, repo, origin], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
  });
  const outcome = res.stdout.split('\n').at(-2);
  assert.match(outcome, /^threw check-failed: /, res.stdout + res.stderr);
  // The report is lost, so the message says where the merge is.
  assert.match(outcome, /you are on sync\/v1\.0\.0/);
  assert.match(outcome, /merge .* is committed there/);
  assert.match(res.stdout, /^FAIL original-test: /m);
  assert.equal(fake.calls().length, 2);
  assert.equal(git(repo, ['branch', '--show-current']), 'sync/v1.0.0');
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(git(repo, ['log', '-1', '--format=%s']), 'Merge upstream v1.0.0');

  // Recovery (CLAUDE.md): a rerun reports nothing-to-do and does not run the check again.
  const rerun = runSync({ repo, tag: 'v1.0.0', from: origin, check: true });
  assert.equal(rerun.status, 'nothing-to-do');
  assert.equal(fake.calls().length, 2);
});
