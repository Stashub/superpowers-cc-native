// Checks of the repository (spec 7). Module and CLI: node tools/check.mjs
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from './lib/errors.mjs';
import { checkPlugin, checkRootMarketplace, ourLines } from './lib/checks.mjs';
import { finding } from './lib/findings.mjs';
import { repoRoot } from './lib/git.mjs';
import { RUN_TESTS, runOriginalTests, unknownTestFiles } from './lib/original-tests.mjs';
import { upstreamRef } from './lib/upstream.mjs';
import { runValidate } from './lib/validate.mjs';

// Spec 7.1. The checks that run after sync.mjs and before any commit.
function defaultChecks(ctx) {
  const { root, claudeBin, originalTests } = ctx;
  const pluginDir = path.join(root, 'plugin');
  return [
    ...checkPlugin(root),
    ...checkRootMarketplace(root).findings,
    ...runValidate(root, '.', { claudeBin }),
    ...runValidate(root, './plugin', { claudeBin }),
    ...runOriginalTests(pluginDir, originalTests),
    ...unknownTestFiles(pluginDir).map((file) =>
      finding('info', 'unknown-test', `${file} is in neither the run list nor the skip list; decide where it belongs`)),
    ourLines(root, upstreamRef(root)),
  ];
}

// One function per mode: (ctx) -> Finding[].
const MODES = { default: defaultChecks };

// runChecks({ repo, mode, commit, claudeBin, originalTests }) -> { ok, findings }.
// repo: any directory inside the repository. originalTests: the list for runOriginalTests
// (default RUN_TESTS; [] skips them). ok is true when no finding has the level 'fail'.
export function runChecks({
  repo, mode = 'default', commit = null, claudeBin, originalTests = RUN_TESTS,
}) {
  const check = MODES[mode];
  if (check === undefined) throw new ToolError('usage', `unknown mode ${JSON.stringify(mode)}`);
  const findings = check({ root: repoRoot(repo), commit, claudeBin, originalTests });
  return { ok: !findings.some((f) => f.level === 'fail'), findings };
}

const USAGE = 'usage: node tools/check.mjs';

function cli(argv) {
  try {
    if (argv.length > 0) throw new ToolError('usage', USAGE);
    const { ok, findings } = runChecks({ repo: process.cwd() });
    for (const f of findings) console.log(`${f.level.toUpperCase()} ${f.code}: ${f.text}`);
    return ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    console.error(err.code === 'usage' ? err.message : `stop (${err.code}): ${err.message}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)))
  process.exitCode = cli(process.argv.slice(2));
