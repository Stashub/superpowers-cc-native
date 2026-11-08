import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_TESTS, SKIP_DIRS, SKIP_FILES, runOriginalTests, unknownTestFiles,
} from '../lib/original-tests.mjs';
import { tempDir, writeFiles } from './helpers.mjs';

test('runs listed tests in the plugin dir and reports a failure with output', (t) => {
  const pluginDir = tempDir(t);
  writeFiles(pluginDir, {
    'tests/a/test-ok.sh': 'exit 0\n',
    'tests/b/test-bad.sh': 'echo boom; echo "bad: $(basename "$PWD")" >&2; exit 1\n',
  });
  const f = runOriginalTests(pluginDir, ['tests/a/test-ok.sh', 'tests/b/test-bad.sh']);
  assert.deepEqual(f.map((x) => x.level), ['ok', 'fail']);
  assert.deepEqual(f.map((x) => x.code), ['original-test', 'original-test']);
  assert.match(f[0].text, /tests\/a\/test-ok\.sh/);
  assert.match(f[1].text, /tests\/b\/test-bad\.sh/);
  assert.match(f[1].text, /boom/);
  assert.match(f[1].text, /bad: /);
});

test('a failure keeps only about the last 20 lines of output', (t) => {
  const pluginDir = tempDir(t);
  writeFiles(pluginDir, { 'tests/t.sh': 'for i in $(seq 1 100); do echo "line $i"; done; exit 3\n' });
  const [f] = runOriginalTests(pluginDir, ['tests/t.sh']);
  assert.equal(f.level, 'fail');
  assert.match(f.text, /line 100\b/);
  assert.match(f.text, /line 81\b/);
  assert.doesNotMatch(f.text, /line 80\b/);
  assert.match(f.text, /exit 3|status 3/);
});

test('a listed test file that does not exist is a failure', (t) => {
  const pluginDir = tempDir(t);
  const [f] = runOriginalTests(pluginDir, ['tests/nope.sh']);
  assert.equal(f.level, 'fail');
  assert.equal(f.code, 'original-test');
  assert.match(f.text, /tests\/nope\.sh/);
  assert.match(f.text, /missing|not found|does not exist/);
});

test('an empty list runs nothing', (t) => {
  assert.deepEqual(runOriginalTests(tempDir(t), []), []);
});

test('lists unknown test files outside skipped dirs', (t) => {
  const pluginDir = tempDir(t);
  writeFiles(pluginDir, {
    [RUN_TESTS[0]]: 'exit 0\n',
    [SKIP_FILES[0]]: 'exit 0\n',
    'tests/claude-code/test-new.sh': 'exit 0\n',
    'tests/claude-code/deep/more/x.py': 'pass\n',
    'tests/opencode/test-x.sh': 'exit 0\n',
    'tests/claude-code/README.md': 'doc\n',
    'tests/claude-code/node_modules/pkg/index.js': 'x\n',
    'tests/z.mjs': 'x\n',
  });
  assert.deepEqual(unknownTestFiles(pluginDir), [
    'tests/claude-code/deep/more/x.py',
    'tests/claude-code/test-new.sh',
    'tests/z.mjs',
  ]);
});

test('a missing tests directory has no unknown files', (t) => {
  assert.deepEqual(unknownTestFiles(tempDir(t)), []);
});

test('run and skip lists do not overlap and have 11 runnable tests', () => {
  assert.equal(RUN_TESTS.length, 11);
  assert.equal(new Set(RUN_TESTS).size, 11);
  assert.deepEqual(RUN_TESTS.filter((x) => SKIP_FILES.includes(x)), []);
  assert.equal(SKIP_FILES.length, 18);
  assert.equal(new Set(SKIP_FILES).size, 18);
  assert.deepEqual(SKIP_DIRS, [
    'antigravity', 'codex', 'codex-plugin-sync', 'devin', 'hermes', 'kimi', 'opencode', 'pi',
    'explicit-skill-requests',
  ]);
});
