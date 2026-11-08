import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPlugin, checkRootMarketplace, ourLines } from '../lib/checks.mjs';
import { git } from '../lib/git.mjs';
import { RUN_TESTS } from '../lib/original-tests.mjs';
import { runChecks } from '../check.mjs';
import {
  cleanValidateReport, commitAll, initRepo, makeFakeClaude, tempDir, writeFiles,
} from './helpers.mjs';

const CHECK = fileURLToPath(new URL('../check.mjs', import.meta.url));
const MARKETPLACE = '.claude-plugin/marketplace.json';
const PLUGIN_JSON = 'plugin/.claude-plugin/plugin.json';

const marketplace = (over = {}) => ({
  name: 'superpowers-cc-native',
  owner: { name: 'Stashub', url: 'https://github.com/Stashub' },
  description: 'Claude Code native fork of obra/superpowers',
  plugins: [{ name: 'superpowers-cc-native', source: './plugin', version: '7.0.2-cc.1' }],
  ...over,
});
const withPlugin = (over) => marketplace({ plugins: [{ ...marketplace().plugins[0], ...over }] });
const json = (obj) => JSON.stringify(obj, null, 2) + '\n';

// A repository that passes every check: a minimal plugin/, the root marketplace and, in
// plugin/tests, a passing script for each of the original tests.
function makeFixture(t) {
  const repo = tempDir(t);
  initRepo(repo);
  writeFiles(repo, {
    [MARKETPLACE]: json(marketplace()),
    [PLUGIN_JSON]: json({ name: 'superpowers-cc-native', description: 'x' }),
    'plugin/skills/a/SKILL.md': 'Use superpowers-cc-native:b first.\n',
    'plugin/README.md': 'Readme.\n',
    ...Object.fromEntries(RUN_TESTS.map((p) => [`plugin/${p}`, 'exit 0\n'])),
  });
  return repo;
}

const run = (repo, claudeBin, extra = {}) => runChecks({ repo, claudeBin, originalTests: [], ...extra });
const fails = (findings, code) => findings.filter((f) => f.level === 'fail' && (!code || f.code === code));

test('passes on a valid fixture', (t) => {
  const repo = makeFixture(t);
  const res = run(repo, makeFakeClaude(t).bin);
  assert.deepEqual(fails(res.findings), []);
  assert.equal(res.ok, true);
});

test('passes with the original tests of the fixture', (t) => {
  const repo = makeFixture(t);
  const res = runChecks({ repo, claudeBin: makeFakeClaude(t).bin });
  assert.equal(res.ok, true);
  assert.equal(res.findings.filter((f) => f.code === 'original-test').length, 11);
});

const BREAKS = [
  ['old-refs', 'superpowers:x in plugin/skills/a/SKILL.md', (r) => writeFiles(r, { 'plugin/skills/a/SKILL.md': 'Run superpowers:x now.\n' })],
  ['plugin-name', 'a wrong name in plugin.json', (r) => writeFiles(r, { [PLUGIN_JSON]: json({ name: 'superpowers' }) })],
  ['plugin-name', 'a missing plugin.json', (r) => rmSync(path.join(r, PLUGIN_JSON))],
  ['plugin-version', 'version in plugin.json', (r) => writeFiles(r, { [PLUGIN_JSON]: json({ name: 'superpowers-cc-native', version: '1.0.0' }) })],
  ['plugin-marketplace', 'plugin/.claude-plugin/marketplace.json', (r) => writeFiles(r, { 'plugin/.claude-plugin/marketplace.json': '{}\n' })],
  ['marketplace', "version '7.0.2'", (r) => writeFiles(r, { [MARKETPLACE]: json(withPlugin({ version: '7.0.2' })) })],
  ['marketplace', 'two plugins', (r) => writeFiles(r, { [MARKETPLACE]: json(marketplace({ plugins: [marketplace().plugins[0], marketplace().plugins[0]] })) })],
  ["marketplace", "source './'", (r) => writeFiles(r, { [MARKETPLACE]: json(withPlugin({ source: './' })) })],
];
for (const [code, what, breakIt] of BREAKS) {
  test(`fails with ${code}: ${what}`, (t) => {
    const repo = makeFixture(t);
    breakIt(repo);
    const res = run(repo, makeFakeClaude(t).bin);
    assert.ok(fails(res.findings, code).length > 0, JSON.stringify(res.findings));
    assert.equal(res.ok, false);
  });
}

test('fails when the original tests fail, and reports a validate failure', (t) => {
  const repo = makeFixture(t);
  writeFiles(repo, { [`plugin/${RUN_TESTS[0]}`]: 'echo nope; exit 1\n' });
  const res = runChecks({ repo, claudeBin: makeFakeClaude(t).bin });
  assert.equal(fails(res.findings, 'original-test').length, 1);
  assert.equal(res.ok, false);

});

test('a validate error is a failure for both targets', (t) => {
  const report = cleanValidateReport();
  report.manifest.errors = [{ path: 'name', message: 'x', code: null }];
  const bad = makeFakeClaude(t, { output: report, exitCode: 1 });
  const res = run(makeFixture(t), bad.bin);
  assert.equal(fails(res.findings, 'validate').length, 2);
  assert.equal(res.ok, false);
});

test('validates both . and ./plugin from the repository root', (t) => {
  const repo = makeFixture(t);
  const fake = makeFakeClaude(t);
  run(repo, fake.bin);
  assert.deepEqual(fake.calls().map((c) => c.argv[2]), ['.', './plugin']);
  assert.ok(fake.calls().every((c) => c.cwd === repo));
});

test('a missing claude is a warning and does not fail the check', (t) => {
  const repo = makeFixture(t);
  const res = run(repo, '/nonexistent/claude');
  const warns = res.findings.filter((f) => f.level === 'warn' && f.code === 'validate');
  assert.ok(warns.length >= 1);
  assert.equal(res.ok, true);
});

test('unknown test files are reported as info, not failures', (t) => {
  const repo = makeFixture(t);
  writeFiles(repo, { 'plugin/tests/claude-code/test-new.sh': 'exit 0\n' });
  const res = run(repo, makeFakeClaude(t).bin);
  const unknown = res.findings.filter((f) => f.code === 'unknown-test');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].level, 'info');
  assert.match(unknown[0].text, /tests\/claude-code\/test-new\.sh/);
  assert.equal(res.ok, true);
});

test('an unknown mode is a usage error', (t) => {
  const repo = makeFixture(t);
  assert.throws(() => runChecks({ repo, mode: 'nope', originalTests: [] }), { code: 'usage' });
});

test('checkPlugin does not follow symlinks and skips binary files', (t) => {
  const repo = makeFixture(t);
  writeFiles(repo, {
    'plugin/loop': { symlink: '.' },
    'plugin/link': { symlink: 'skills/a/SKILL.md' },
    'plugin/bin.dat': Buffer.concat([Buffer.from('superpowers:x'), Buffer.from([0])]),
    'plugin/ok.md': 'superpowers-cc-native:x, my-superpowers:x, superpowers: x\n',
  });
  assert.deepEqual(fails(checkPlugin(repo)), []);
  writeFiles(repo, { 'plugin/two.md': 'superpowers:a and superpowers:b\n' });
  const bad = fails(checkPlugin(repo), 'old-refs');
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /plugin\/two\.md/);
  assert.match(bad[0].text, /2/);
});

test('checkPlugin without a plugin directory fails only on plugin.json', (t) => {
  const repo = tempDir(t);
  initRepo(repo);
  const f = checkPlugin(repo);
  assert.deepEqual(fails(f).map((x) => x.code), ['plugin-name']);
});

test('checkRootMarketplace returns the version and flags each defect', (t) => {
  const repo = tempDir(t);
  initRepo(repo);
  writeFiles(repo, { [MARKETPLACE]: json(marketplace()) });
  let res = checkRootMarketplace(repo);
  assert.equal(res.version, '7.0.2-cc.1');
  assert.deepEqual(fails(res.findings), []);

  const defects = [
    marketplace({ name: undefined }), marketplace({ owner: {} }), marketplace({ description: undefined }),
    marketplace({ plugins: [] }), withPlugin({ name: 'superpowers' }), withPlugin({ version: undefined }),
    withPlugin({ version: '7.0.2-cc.0' }),
  ];
  for (const d of defects) {
    writeFiles(repo, { [MARKETPLACE]: json(d) });
    res = checkRootMarketplace(repo);
    assert.ok(fails(res.findings, 'marketplace').length >= 1, JSON.stringify(d));
  }
  writeFiles(repo, { [MARKETPLACE]: '{ not json' });
  res = checkRootMarketplace(repo);
  assert.equal(fails(res.findings, 'marketplace').length, 1);
  assert.equal(res.version, null);
  writeFiles(repo, { [MARKETPLACE]: { symlink: 'nowhere' } });
  assert.equal(checkRootMarketplace(repo).version, null);
});

test('ourLines counts the lines of ours against the upstream branch', (t) => {
  const repo = makeFixture(t);
  assert.equal(ourLines(repo, null).level, 'info');
  assert.equal(ourLines(repo, null).code, 'our-lines');
  commitAll(repo, 'base');
  git(repo, ['branch', 'upstream']);
  assert.match(ourLines(repo, 'upstream').text, /no lines of ours/i);
  writeFiles(repo, { 'plugin/README.md': 'Readme.\nMore.\nAnd more.\n' });
  commitAll(repo, 'ours');
  const f = ourLines(repo, 'upstream');
  assert.equal(f.level, 'info');
  assert.equal(f.code, 'our-lines');
  assert.match(f.text, /\+2/);
  assert.match(f.text, /1 file/);
});

test('CLI works from a subdirectory and prints one line per finding', (t) => {
  const repo = makeFixture(t);
  const fake = makeFakeClaude(t);
  const res = spawnSync(process.execPath, [CHECK], {
    cwd: path.join(repo, 'plugin/skills'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.ok(lines.some((l) => /^OK plugin-name: /.test(l)), res.stdout);
  assert.ok(lines.some((l) => /^OK original-test: /.test(l)));
  assert.equal(lines.filter((l) => /^OK original-test: /.test(l)).length, 11);
});

test('CLI exits 1 on a failure and on a usage error', (t) => {
  const repo = makeFixture(t);
  writeFiles(repo, { 'plugin/skills/a/SKILL.md': 'superpowers:x\n' });
  const fake = makeFakeClaude(t);
  const env = { ...process.env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` };
  const res = spawnSync(process.execPath, [CHECK], { cwd: repo, encoding: 'utf8', env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL old-refs: /m);
  const usage = spawnSync(process.execPath, [CHECK, '--bogus'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage/);
});
