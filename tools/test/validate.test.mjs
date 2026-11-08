import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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

test('a report of an unexpected shape fails', () => {
  for (const r of [{}, { success: false }, null, undefined, [], 'text', { manifest: null }, { manifest: [] },
    { error: 'boom' }]) {
    const findings = filterValidateReport(r);
    assert.equal(findings.length, 1, JSON.stringify(r));
    assert.equal(findings[0].level, 'fail', JSON.stringify(r));
    assert.equal(findings[0].code, 'validate');
  }
});

test('success: false with nothing of ours listed fails; success: false with a finding says why', () => {
  const only = filterValidateReport({ ...report({ manifestWarnings: [allowed] }), success: false });
  assert.deepEqual(only.map((f) => f.level), ['fail']);
  assert.match(only[0].text, /success: false/);
  const withError = filterValidateReport({
    ...report({ manifestErrors: [{ path: 'name', message: 'bad name', code: null }] }), success: false,
  });
  assert.equal(fails(withError).length, 1);
  assert.match(withError[0].text, /bad name/);
});

// A real report: `claude plugin validate --json` (CC 2.1.319) on the renamed v7.0.2 plugin
// without a version. Only the machine paths were replaced by <plugin>.
const REAL_REPORT = {
  "success": true,
  "strict": false,
  "target": "<plugin>/.claude-plugin/plugin.json",
  "manifest": {
    "file": "<plugin>/.claude-plugin/plugin.json",
    "type": "plugin",
    "errors": [],
    "warnings": [
      {
        "path": "version",
        "message": "No version specified. Consider adding a version following semver (e.g., \"1.0.0\")",
        "code": null
      }
    ],
    "notes": [],
    "gatingHooks": []
  },
  "contents": [],
  "advice": [
    {
      "file": "<plugin>/README.md",
      "message": "This README has no line that installs \"superpowers-cc-native\" from a marketplace. Add the install line, which works in one step on Claude Code 2.1.275 or later. Validate the folder that holds its marketplace.json to have <owner>/<repo> filled in, and the name its marketplace lists it under.",
      "installLine": "/plugin install superpowers-cc-native --marketplace <owner>/<repo>"
    }
  ],
  "directory": {
    "profile": null,
    "findings": [
      {
        "code": "ICON_MISSING",
        "title": "No icon",
        "severity": "warning",
        "blocking": false,
        "hold": false,
        "file": ".claude-plugin/plugin.json",
        "field": "icon",
        "message": "No icon found in the plugin. The validator looked for `icon` in plugin.json and for a file at .claude-plugin/icon.png or .svg, assets/icon.png or .svg, or a similar path.",
        "fix": "Add a square PNG to the plugin folder at .claude-plugin/icon.png, or set `icon` in plugin.json to the path of a square PNG or JPEG in the plugin: 512 to 2048 px on each side, under 2 MB. SVG and WebP are not accepted. That file may become the listing icon only once: the first time the plugin is saved or submitted in the developer portal. Adding or changing it later does not change the icon."
      }
    ],
    "undecided": [],
    "incomplete": false,
    "failure": null,
    "notes": []
  },
  "digest": null,
  "digestRefusal": null
};

test('the real CC 2.1.319 report for a plugin without a version has no failure', () => {
  assert.equal(REAL_REPORT.success, true);
  assert.deepEqual(filterValidateReport(REAL_REPORT).map((f) => f.level), ['ok']);
});

test('a malformed contents is a failure, never a throw', () => {
  for (const contents of ['abc', [null], ['x'], {}, 5, null, [[]]]) {
    const findings = filterValidateReport(report({ contents }));
    assert.deepEqual(findings.map((f) => f.level), ['fail'], JSON.stringify(contents));
    assert.match(findings[0].text, /contents/);
  }
});

test('errors and warnings that are not arrays are a failure, never a throw', () => {
  for (const bad of ['abc', {}, 5, null]) {
    assert.deepEqual(filterValidateReport(report({ manifestErrors: bad })).map((f) => f.level), ['fail']);
    assert.deepEqual(filterValidateReport(report({ manifestWarnings: bad })).map((f) => f.level), ['fail']);
    assert.deepEqual(filterValidateReport(report({ contents: [{ file: 'x', errors: bad, warnings: [] }] }))
      .map((f) => f.level), ['fail']);
  }
});

test('contents may be absent or empty in a well-formed report', () => {
  const { contents, ...noContents } = report();
  assert.deepEqual(filterValidateReport(noContents).map((f) => f.level), ['ok']);
  assert.deepEqual(filterValidateReport(report({ contents: [] })).map((f) => f.level), ['ok']);
});

test('a root directory that does not exist is a failure naming it, not a missing claude', (t) => {
  const gone = path.join(tempDir(t), 'gone');
  const fake = makeFakeClaude(t);
  for (const missing of ['warn', 'fail']) {
    const findings = runValidate(gone, '.', { claudeBin: fake.bin, missing });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, 'fail');
    assert.equal(findings[0].code, 'validate');
    assert.ok(findings[0].text.includes(gone), findings[0].text);
  }
  assert.equal(fake.calls().length, 0);
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
