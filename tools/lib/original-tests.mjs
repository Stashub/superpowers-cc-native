// Tests of the original that run without a model (spec 7.4).
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { finding, tail } from './findings.mjs';

// Paths are relative to the plugin directory.
export const RUN_TESTS = [
  'tests/skill-size/test-skill-size.sh',
  'tests/skill-layout/test-no-dev-files-in-skills.sh',
  'tests/hooks/test-session-start.sh',
  'tests/sdd-helper-paths/test-sdd-helper-paths.sh',
  'tests/claude-code/test-executing-plans-scripts.sh',
  'tests/claude-code/test-sdd-workspace.sh',
  'tests/claude-code/test-worktree-path-policy.sh',
  'tests/diagnosing-superpowers/test-skill-structure.sh',
  'tests/systematic-debugging/test-find-polluter.sh',
  'tests/shell-lint/test-lint-shell.sh',
  'tests/brainstorm-server/start-server.test.sh',
];

// Files we know and do not run (the table of spec 7.4, without the folders of other tools).
export const SKIP_FILES = [
  'tests/claude-code/test-subagent-driven-development.sh',
  'tests/claude-code/test-subagent-driven-development-integration.sh',
  'tests/claude-code/test-worktree-native-preference.sh',
  'tests/writing-skills/test-render-graphs.sh',
  'tests/version-bump/test-bump-version.sh',
  'tests/brainstorm-server/auth.test.js',
  'tests/brainstorm-server/branding.test.js',
  'tests/brainstorm-server/browser-launcher.test.js',
  'tests/brainstorm-server/helper.test.js',
  'tests/brainstorm-server/lifecycle.test.js',
  'tests/brainstorm-server/server.test.js',
  'tests/brainstorm-server/ws-protocol.test.js',
  'tests/brainstorm-server/stop-server.test.sh',
  'tests/hooks/test-run-hook-cmd-windows.sh',
  'tests/brainstorm-server/windows-lifecycle.test.sh',
  'tests/claude-code/run-skill-tests.sh',
  'tests/claude-code/test-helpers.sh',
  'tests/claude-code/analyze-token-usage.py',
];

// Directory names under tests/ that are not looked at: other tools, and tests that need a model.
export const SKIP_DIRS = [
  'antigravity', 'codex', 'codex-plugin-sync', 'devin', 'hermes', 'kimi', 'opencode', 'pi',
  'explicit-skill-requests',
];

const TEST_EXT = new Set(['.sh', '.js', '.mjs', '.cjs', '.py', '.ts']);
const TEST_TIMEOUT_MS = 300_000;

function lstatSyncOrNull(file) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

// Runs each listed file as `bash <file>` in pluginDir: one `original-test` finding per file.
export function runOriginalTests(pluginDir, list = RUN_TESTS) {
  return list.map((file) => {
    if (lstatSyncOrNull(path.join(pluginDir, file))?.isFile() !== true)
      return finding('fail', 'original-test', `${file}: the listed test file does not exist`);
    const res = spawnSync('bash', [file], {
      cwd: pluginDir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: TEST_TIMEOUT_MS,
    });
    if (res.error) return finding('fail', 'original-test', `${file}: could not run: ${res.error.message}`);
    if (res.status === 0) return finding('ok', 'original-test', `${file} passed`);
    const how = res.status === null ? `was stopped by ${res.signal}` : `failed (exit ${res.status})`;
    return finding('fail', 'original-test', `${file} ${how}:\n${tail(`${res.stdout}\n${res.stderr}`)}`);
  });
}

// Test-like files (by extension) in pluginDir/tests that are in neither list, outside SKIP_DIRS
// and outside node_modules. Sorted; paths relative to pluginDir with "/" separators.
export function unknownTestFiles(pluginDir) {
  const known = new Set([...RUN_TESTS, ...SKIP_FILES]);
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(path.join(pluginDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || (rel === 'tests' && SKIP_DIRS.includes(entry.name))) continue;
        walk(child);
      } else if (entry.isFile() && TEST_EXT.has(path.extname(entry.name)) && !known.has(child)) {
        found.push(child);
      }
    }
  };
  walk('tests');
  return found.sort();
}
