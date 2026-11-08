import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/git.mjs';
import { RUN_TESTS } from '../lib/original-tests.mjs';
import { releaseState } from '../lib/release.mjs';
import { runChecks } from '../check.mjs';
import { runSync } from '../sync.mjs';
import {
  commitAll, initRepo, makeFakeClaude, makeOrigin, seedMain, tempDir, writeFiles,
} from './helpers.mjs';

const CHECK = fileURLToPath(new URL('../check.mjs', import.meta.url));
const MARKETPLACE = '.claude-plugin/marketplace.json';
const SKILL = 'plugin/skills/demo/SKILL.md';

// The original's tests pass in every release, so the release checks can run them.
const PASSING_TESTS = Object.fromEntries(RUN_TESTS.map((file) => [file, 'exit 0\n']));
const RELEASES = [
  { tag: 'v1.0.0', files: PASSING_TESTS },
  { tag: 'v1.1.0', files: { ...PASSING_TESTS, 'README.md': '# Superpowers 1.1\n' } },
];

// CHANGELOG.md with a dated heading for each number given, newest first.
const changelog = (...versions) => [
  '# Changelog', '', '## Unreleased', '',
  ...versions.flatMap((v) => [`## ${v} - 2026-11-08`, 'Based on obra/superpowers.', '']),
].join('\n');

function setVersion(repo, version) {
  const m = JSON.parse(readFileSync(path.join(repo, MARKETPLACE), 'utf8'));
  m.plugins[0].version = version;
  writeFiles(repo, { [MARKETPLACE]: JSON.stringify(m, null, 2) + '\n' });
}

const codes = (s) => s.errors.map((e) => e.code);
const fails = (findings, code) => findings.filter((f) => f.level === 'fail' && (!code || f.code === code));

// A seeded main before any import. Its marketplace already holds 1.0.0-cc.1.
function fresh(t) {
  const repo = tempDir(t);
  initRepo(repo);
  seedMain(repo);
  return repo;
}

// Release step 1 of the first release (spec 8): v1.0.0 is merged into sync/v1.0.0 (HEAD), the
// marketplace holds 1.0.0-cc.1, the CHANGELOG entry is written but not committed.
function prepared(t) {
  const origin = makeOrigin(t, RELEASES);
  const repo = fresh(t);
  runSync({ repo, tag: 'v1.0.0', from: origin, check: false });
  writeFiles(repo, { 'CHANGELOG.md': changelog('1.0.0-cc.1') });
  return { origin, repo };
}

// The first release done: release commit, main fast-forwarded to it, tag v1.0.0-cc.1.
// HEAD is main.
function released(t) {
  const { origin, repo } = prepared(t);
  const commit = commitAll(repo, 'Release v1.0.0-cc.1');
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', 'sync/v1.0.0']);
  git(repo, ['branch', '-q', '-d', 'sync/v1.0.0']);
  git(repo, ['tag', '-a', '-m', 'Release v1.0.0-cc.1', 'v1.0.0-cc.1']);
  return { origin, repo, commit };
}

test('nothing to release before the first import', (t) => {
  const s = releaseState(fresh(t));
  assert.equal(s.state, 'nothing');
  assert.deepEqual(s.errors, []);
  assert.equal(s.base, null);
  assert.equal(s.last, null);
  assert.equal(s.expected, null);
});

test('first release is prepared as 1.0.0-cc.1', (t) => {
  const { repo } = prepared(t);
  const s = releaseState(repo);
  assert.equal(s.state, 'preparing', JSON.stringify(s.errors));
  assert.equal(s.expected, '1.0.0-cc.1');
  assert.equal(s.base, '1.0.0');
  assert.equal(s.last, null);
  assert.equal(s.version, '1.0.0-cc.1');
  assert.deepEqual(s.errors, []);
});

test('wrong number, missing changelog entry and foreign tag are errors', (t) => {
  const withCc2 = prepared(t).repo;
  setVersion(withCc2, '1.0.0-cc.2');
  writeFiles(withCc2, { 'CHANGELOG.md': changelog('1.0.0-cc.2') });

  const noEntry = prepared(t).repo;
  writeFiles(noEntry, { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 1.0.0-cc.1\n' });

  const foreignTag = prepared(t).repo;
  const elsewhere = git(foreignTag, ['commit-tree', 'HEAD^{tree}', '-m', 'not on this branch']);
  git(foreignTag, ['tag', '-a', '-m', 'Release v1.0.0-cc.1', 'v1.0.0-cc.1', elsewhere]);

  for (const [code, repoX] of [['version-expected', withCc2], ['changelog-missing', noEntry], ['tag-elsewhere', foreignTag]]) {
    const s = releaseState(repoX);
    assert.ok(s.errors.some((e) => e.code === code), `${code}: ${JSON.stringify(s.errors)}`);
    assert.deepEqual(codes(s), [code]);
    assert.equal(s.state, 'error');
    assert.ok(s.errors.every((e) => e.level === 'fail'));
  }
});

test('after the tag there is nothing to release', (t) => {
  const { repo } = released(t);
  let s = releaseState(repo);
  assert.equal(s.state, 'nothing', JSON.stringify(s.errors));
  assert.equal(s.last, '1.0.0-cc.1');
  assert.equal(s.expected, '1.0.0-cc.2');
  // Commits outside plugin/ need no release.
  writeFiles(repo, { 'README.md': '# superpowers-cc-native\n\nMore words.\n' });
  commitAll(repo, 'docs: README');
  s = releaseState(repo);
  assert.equal(s.state, 'nothing', JSON.stringify(s.errors));
});

test('our plugin change on the same base expects cc.2, a new base resets to cc.1', (t) => {
  const { origin, repo } = released(t);
  writeFiles(repo, { [SKILL]: 'Our own wording.\n' });
  commitAll(repo, 'feat: our edit');
  let s = releaseState(repo);
  assert.equal(s.expected, '1.0.0-cc.2');
  // plugin/ changed while the number stayed the last one.
  assert.deepEqual(codes(s), ['version-expected']);

  runSync({ repo, tag: 'v1.1.0', from: origin, check: false });
  s = releaseState(repo);
  assert.equal(s.base, '1.1.0');
  assert.equal(s.last, '1.0.0-cc.1');
  assert.equal(s.expected, '1.1.0-cc.1');
});

test('a bumped number without plugin changes is an error', (t) => {
  const { repo } = released(t);
  setVersion(repo, '1.0.0-cc.2');
  writeFiles(repo, { 'CHANGELOG.md': changelog('1.0.0-cc.2', '1.0.0-cc.1') });
  const s = releaseState(repo);
  assert.equal(s.state, 'error');
  assert.ok(s.errors.some((e) => e.code === 'no-plugin-change'), JSON.stringify(s.errors));
});

test('a lightweight release tag is an error and is not counted as a release', (t) => {
  // The only release tag is lightweight: no release yet, and push mode refuses the commit.
  const { repo } = prepared(t);
  const commit = commitAll(repo, 'Release v1.0.0-cc.1');
  git(repo, ['tag', 'v1.0.0-cc.1', commit]);
  let s = releaseState(repo);
  assert.equal(s.state, 'error');
  assert.equal(s.last, null);
  assert.deepEqual(codes(s), ['tag-lightweight']);
  assert.match(s.errors[0].text, /v1\.0\.0-cc\.1 is lightweight/);
  assert.match(s.errors[0].text, /git tag -f -a/);
  const push = runChecks({ repo, mode: 'push', commit });
  assert.equal(push.ok, false);
  assert.match(push.findings[0].text, /tag-lightweight/);
  // Replaced by an annotated tag on the same commit, it is the last release.
  git(repo, ['tag', '-f', '-a', '-m', 'Release v1.0.0-cc.1', 'v1.0.0-cc.1', commit]);
  s = releaseState(repo);
  assert.equal(s.state, 'nothing', JSON.stringify(s.errors));
  assert.equal(s.last, '1.0.0-cc.1');

  // A lightweight tag above an annotated release: the annotated one is the last release.
  const second = released(t).repo;
  writeFiles(second, { [SKILL]: 'Our own wording.\n', 'CHANGELOG.md': changelog('1.0.0-cc.2', '1.0.0-cc.1') });
  setVersion(second, '1.0.0-cc.2');
  git(second, ['tag', 'v1.0.0-cc.2', commitAll(second, 'Release v1.0.0-cc.2')]);
  s = releaseState(second);
  assert.equal(s.last, '1.0.0-cc.1');
  assert.equal(s.expected, '1.0.0-cc.2');
  assert.deepEqual(codes(s), ['tag-lightweight']);
});

test('plugin/ without a merged upstream import has no base', (t) => {
  const repo = fresh(t);
  writeFiles(repo, { 'plugin/README.md': 'Readme.\n' });
  commitAll(repo, 'feat: plugin without an import');
  const s = releaseState(repo);
  assert.equal(s.state, 'error');
  assert.equal(s.expected, null);
  assert.ok(codes(s).includes('no-base'), JSON.stringify(s.errors));
});

test('without the working copy, marketplace and CHANGELOG come from the commit', (t) => {
  const { repo } = prepared(t);
  setVersion(repo, '1.0.0-cc.5');
  // The committed CHANGELOG has no entry yet and the committed number is 1.0.0-cc.1.
  const s = releaseState(repo, { worktree: false });
  assert.equal(s.version, '1.0.0-cc.1');
  assert.deepEqual(codes(s), ['changelog-missing']);
  assert.equal(releaseState(repo).version, '1.0.0-cc.5');
});

test('push mode checks the given commit, not HEAD', (t) => {
  const { repo, commit: tagged } = released(t);
  // The next release is prepared and committed on a branch, but not tagged.
  git(repo, ['checkout', '-q', '-b', 'plan/x']);
  writeFiles(repo, { [SKILL]: 'Our own wording.\n', 'CHANGELOG.md': changelog('1.0.0-cc.2', '1.0.0-cc.1') });
  setVersion(repo, '1.0.0-cc.2');
  const untagged = commitAll(repo, 'Release v1.0.0-cc.2');
  // HEAD is the seed commit of main: no plugin/, no release tag reachable. The working copy
  // holds a number that fits neither commit.
  git(repo, ['checkout', '-q', '-b', 'elsewhere', 'main~2']);
  assert.equal(git(repo, ['tag', '--merged', 'HEAD']), '');
  setVersion(repo, '9.9.9-cc.9');
  writeFiles(repo, { 'CHANGELOG.md': '# Changelog\n' });

  const bad = runChecks({ repo, mode: 'push', commit: untagged });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.findings.map((f) => f.code), ['not-released']);
  assert.match(bad.findings[0].text, /preparing/);
  assert.match(bad.findings[0].text, /1\.0\.0-cc\.2/);

  const good = runChecks({ repo, mode: 'push', commit: tagged });
  assert.equal(good.ok, true, JSON.stringify(good.findings));
  assert.deepEqual(good.findings.map((f) => f.level), ['ok']);

  // A plugin change with the old number: the text names the problem.
  git(repo, ['checkout', '-q', '-f', 'main']);
  writeFiles(repo, { [SKILL]: 'Unreleased wording.\n' });
  const unreleased = commitAll(repo, 'feat: unreleased');
  const wrong = runChecks({ repo, mode: 'push', commit: unreleased });
  assert.equal(wrong.ok, false);
  assert.match(wrong.findings[0].text, /version-expected/);
  assert.match(wrong.findings[0].text, /1\.0\.0-cc\.2/);
});

test('push mode never passes a commit that does not resolve', (t) => {
  const { repo } = released(t);
  for (const commit of ['no-such-ref', '--git-dir', 'HEAD:plugin']) {
    const res = runChecks({ repo, mode: 'push', commit });
    assert.equal(res.ok, false, commit);
    assert.deepEqual(fails(res.findings).map((f) => f.code), ['bad-commit']);
  }
  assert.throws(() => runChecks({ repo, mode: 'push' }), { code: 'usage' });
});

test('release mode passes while preparing and reports the expected number', (t) => {
  const { repo } = prepared(t);
  const fake = makeFakeClaude(t);
  const res = runChecks({ repo, mode: 'release', claudeBin: fake.bin });
  assert.deepEqual(fails(res.findings), []);
  assert.equal(res.ok, true);
  const info = res.findings.filter((f) => f.code === 'release');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
  assert.match(info[0].text, /preparing release/);
  assert.match(info[0].text, /expected number: 1\.0\.0-cc\.1/);
  assert.ok(res.findings.some((f) => f.level === 'ok' && f.code === 'identity'));
  assert.ok(res.findings.some((f) => f.level === 'ok' && f.code === 'plugin-dirty'));
  assert.equal(res.findings.filter((f) => f.code === 'original-test').length, 11);
  assert.deepEqual(fake.calls().map((c) => c.argv[2]), ['.', './plugin']);
});

test('release mode after the tag says there is nothing to release', (t) => {
  const { repo } = released(t);
  const res = runChecks({ repo, mode: 'release', claudeBin: makeFakeClaude(t).bin, originalTests: [] });
  assert.equal(res.ok, true, JSON.stringify(fails(res.findings)));
  const info = res.findings.find((f) => f.code === 'release');
  assert.match(info.text, /nothing to release/);
  assert.match(info.text, /1\.0\.0-cc\.2/);
});

const RELEASE_BREAKS = [
  ['validate', 'claude is missing', () => {}, '/nonexistent/claude'],
  ['plugin-dirty', 'an uncommitted plugin/ change', (r) => writeFiles(r, { [SKILL]: 'Uncommitted.\n' })],
  ['plugin-dirty', 'an untracked file in plugin/', (r) => writeFiles(r, { 'plugin/new.md': 'New.\n' })],
  ['identity', 'a wrong local user.name', (r) => git(r, ['config', '--local', 'user.name', 'Someone'])],
  ['version-expected', 'a wrong number', (r) => setVersion(r, '1.0.0-cc.3')],
  ['changelog-missing', 'no CHANGELOG entry', (r) => writeFiles(r, { 'CHANGELOG.md': changelog() })],
];
for (const [code, what, breakIt, claudeBin] of RELEASE_BREAKS) {
  test(`release mode fails with ${code}: ${what}`, (t) => {
    const { repo } = prepared(t);
    breakIt(repo);
    const res = runChecks({ repo, mode: 'release', claudeBin: claudeBin ?? makeFakeClaude(t).bin, originalTests: [] });
    assert.ok(fails(res.findings, code).length > 0, JSON.stringify(res.findings));
    assert.equal(res.ok, false);
  });
}

test('CLI: --release prints the expected number, --push checks a commit, bad arguments are usage errors', (t) => {
  const { repo } = prepared(t);
  const fake = makeFakeClaude(t);
  const env = { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` };
  const cli = (...args) => spawnSync(process.execPath, [CHECK, ...args], {
    cwd: path.join(repo, 'plugin/skills'), encoding: 'utf8', env,
  });

  let res = cli('--release');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^INFO release: preparing release 1\.0\.0-cc\.1; expected number: 1\.0\.0-cc\.1/m);

  // An identity from the environment fails and the message says how to rerun this command.
  res = spawnSync(process.execPath, [CHECK, '--release'], {
    cwd: repo, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'Someone Else', GIT_COMMITTER_NAME: 'Someone Else' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL identity: .*env -u GIT_AUTHOR_NAME -u GIT_COMMITTER_NAME node tools\/check\.mjs --release$/m);

  const untagged = commitAll(repo, 'Release v1.0.0-cc.1');
  res = cli('--push', untagged);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL not-released: /m);
  git(repo, ['tag', '-a', '-m', 'Release v1.0.0-cc.1', 'v1.0.0-cc.1', untagged]);
  res = cli('--push', untagged);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^OK release: /m);

  for (const args of [['--push'], ['--release', 'x'], ['--push', 'a', 'b'], ['--bogus'], ['HEAD']]) {
    res = cli(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, /usage/, args.join(' '));
  }
});
