import test from 'node:test';
import assert from 'node:assert/strict';
import { filterValidateReport, runValidate } from '../lib/validate.mjs';
import { cleanValidateReport, makeFakeClaude, tempDir } from './helpers.mjs';

const allowed = {
  path: 'plugins[0] plugin.json → version',
  message: 'No version specified. Consider adding a version following semver (e.g., "1.0.0")',
  code: null,
};

function report({ manifestErrors = [], manifestWarnings = [], contents = [], ...rest } = {}) {
  const base = cleanValidateReport();
  return {
    ...base,
    manifest: { ...base.manifest, errors: manifestErrors, warnings: manifestWarnings },
    contents,
    ...rest,
  };
}

const fails = (findings) => findings.filter((f) => f.level === 'fail');

test('allows only the missing-version warning in manifest and contents', () => {
  assert.deepEqual(
    fails(filterValidateReport(report({ manifestWarnings: [allowed, { ...allowed, path: 'version' }] }))),
    [],
  );
  assert.deepEqual(
    fails(filterValidateReport(report({
      contents: [{ file: 'plugin.json', errors: [], warnings: [{ ...allowed, path: 'version' }] }],
    }))),
    [],
  );
  assert.equal(fails(filterValidateReport(report({
    contents: [{
      file: 'skills/x/SKILL.md',
      errors: [],
      warnings: [{ path: 'frontmatter', message: 'No frontmatter block found.', code: null }],
    }],
  }))).length, 1);
  assert.equal(fails(filterValidateReport(report({
    manifestErrors: [{ path: 'name', message: 'x', code: null }],
  }))).length, 1);
});

test('a version warning with another message or another path is not allowed', () => {
  assert.equal(fails(filterValidateReport(report({
    manifestWarnings: [{ ...allowed, message: 'Version "x" is not valid semver' }],
  }))).length, 1);
  assert.equal(fails(filterValidateReport(report({
    manifestWarnings: [{ ...allowed, path: 'name' }],
  }))).length, 1);
});

test('reports the file, path and message of each failure', () => {
  const [f] = fails(filterValidateReport(report({
    contents: [{
      file: 'skills/x/SKILL.md',
      errors: [{ path: 'frontmatter', message: 'bad yaml', code: null }],
      warnings: [],
    }],
  })));
  assert.equal(f.code, 'validate');
  assert.match(f.text, /skills\/x\/SKILL\.md/);
  assert.match(f.text, /frontmatter/);
  assert.match(f.text, /bad yaml/);
});

test('ignores advice and directory findings', () => {
  const r = report({
    advice: [{ message: 'install line' }],
    directory: { findings: [{ code: 'ICON_MISSING', severity: 'warning', blocking: false }] },
  });
  assert.deepEqual(fails(filterValidateReport(r)), []);
});

test('a clean report gives one ok finding', () => {
  const findings = filterValidateReport(report());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'ok');
  assert.equal(findings[0].code, 'validate');
});

test('missing claude is a warning by default and a failure when asked', (t) => {
  const root = tempDir(t);
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude' }).length, 1);
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude' })[0].level, 'warn');
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude', missing: 'fail' })[0].level, 'fail');
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude' })[0].code, 'validate');
});

test('runs `plugin validate <target> --json` in the repository root', (t) => {
  const root = tempDir(t);
  const fake = makeFakeClaude(t);
  const findings = runValidate(root, './plugin', { claudeBin: fake.bin });
  assert.deepEqual(findings.map((f) => f.level), ['ok']);
  const calls = fake.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['plugin', 'validate', './plugin', '--json']);
  assert.equal(calls[0].cwd, root);
});

test('turns the fake report into findings, even when claude exits non-zero', (t) => {
  const root = tempDir(t);
  const bad = report({ manifestErrors: [{ path: 'name', message: 'boom', code: null }] });
  const fake = makeFakeClaude(t, { output: bad, exitCode: 1 });
  const findings = runValidate(root, '.', { claudeBin: fake.bin });
  assert.equal(fails(findings).length, 1);
  assert.match(fails(findings)[0].text, /boom/);
});

test('output that is not JSON is a failure with the output tail', (t) => {
  const root = tempDir(t);
  const fake = makeFakeClaude(t, { output: 'something went wrong\n', exitCode: 2 });
  const findings = runValidate(root, '.', { claudeBin: fake.bin });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'fail');
  assert.equal(findings[0].code, 'validate');
  assert.match(findings[0].text, /something went wrong/);
});

test('a binary that cannot be executed is a failure, not a missing claude', (t) => {
  const root = tempDir(t);
  const fake = makeFakeClaude(t);
  // The directory itself exists but is not executable as a program: spawn fails with EACCES.
  const findings = runValidate(root, '.', { claudeBin: fake.dir });
  assert.equal(findings[0].level, 'fail');
  assert.equal(findings[0].code, 'validate');
});
