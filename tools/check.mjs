// Checks of the repository (spec 7). Module and CLI:
//   node tools/check.mjs [--release | --push <commit>]
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY } from './lib/constants.mjs';
import { ToolError } from './lib/errors.mjs';
import { checkPlugin, checkRootMarketplace, ourLines } from './lib/checks.mjs';
import { finding, tail } from './lib/findings.mjs';
import { git, repoRoot } from './lib/git.mjs';
import { RUN_TESTS, runOriginalTests, unknownTestFiles } from './lib/original-tests.mjs';
import { describeRelease, releaseState, resolveCommit } from './lib/release.mjs';
import { checkIdentity, upstreamRef } from './lib/upstream.mjs';
import { runValidate } from './lib/validate.mjs';

// Spec 7.1. The checks that run after sync.mjs and before any commit. `missing` is the level
// of the validate finding when claude is not found (spec 7.3).
function defaultChecks(ctx) {
  const { root, claudeBin, originalTests, missing = 'warn' } = ctx;
  const pluginDir = path.join(root, 'plugin');
  return [
    ...checkPlugin(root),
    ...checkRootMarketplace(root).findings,
    ...runValidate(root, '.', { claudeBin, missing }),
    ...runValidate(root, './plugin', { claudeBin, missing }),
    ...runOriginalTests(pluginDir, originalTests),
    ...unknownTestFiles(pluginDir).map((file) =>
      finding('info', 'unknown-test', `${file} is in neither the run list nor the skip list; decide where it belongs`)),
    ourLines(root, upstreamRef(root)),
  ];
}

// Spec 7.2, `--release`: everything from 7.1 with a missing claude as a failure, the identity
// commits would get (6.8), a committed plugin/, and the release state of HEAD.
function releaseChecks(ctx) {
  const { root } = ctx;
  const identity = checkIdentity(root);
  const dirty = git(root, ['status', '--porcelain', '--', 'plugin/']);
  const state = releaseState(root);
  return [
    ...defaultChecks({ ...ctx, missing: 'fail' }),
    ...(identity.length === 0
      ? [finding('ok', 'identity', `commits are made as ${IDENTITY.name} <${IDENTITY.email}>`)]
      : identity.map((problem) => finding('fail', 'identity', problem))),
    dirty === ''
      ? finding('ok', 'plugin-dirty', 'plugin/ has no uncommitted changes')
      : finding('fail', 'plugin-dirty', `plugin/ has uncommitted changes; commit them first:\n${tail(dirty, 10)}`),
    ...state.errors,
    finding('info', 'release', describeRelease(state)),
  ];
}

// Spec 7.2, `--push <commit>` (run by the pre-push hook for main): the release state of the
// commit from git objects only. It passes only when there is nothing to release.
function pushChecks({ root, commit }) {
  if (commit === null) throw new ToolError('usage', 'push mode needs a commit');
  const sha = resolveCommit(root, commit);
  if (sha === null) return [finding('fail', 'bad-commit', `${commit} is not a commit in this repository`)];
  const s = releaseState(root, { commit: sha, worktree: false });
  const short = sha.slice(0, 7);
  if (s.state === 'nothing') return [finding('ok', 'release', `${short}: ${describeRelease(s)}`)];
  const problems = s.errors.length === 0
    ? `tag v${s.version} does not exist yet`
    : s.errors.map((e) => `${e.code}: ${e.text}`).join('; ');
  return [finding('fail', 'not-released',
    `${short} is in the state "${s.state}", not "nothing": ${describeRelease(s)}; ${problems}. ` +
    'main only takes released, tagged states')];
}

// One function per mode: (ctx) -> Finding[].
const MODES = { default: defaultChecks, release: releaseChecks, push: pushChecks };

// runChecks({ repo, mode, commit, claudeBin, originalTests }) -> { ok, findings }.
// repo: any directory inside the repository. mode: 'default' | 'release' | 'push'; commit is
// the commit to check in push mode. originalTests: the list for runOriginalTests (default
// RUN_TESTS; [] skips them). ok is true when no finding has the level 'fail'.
export function runChecks({
  repo, mode = 'default', commit = null, claudeBin, originalTests = RUN_TESTS,
}) {
  const check = MODES[mode];
  if (check === undefined) throw new ToolError('usage', `unknown mode ${JSON.stringify(mode)}`);
  const findings = check({ root: repoRoot(repo), commit, claudeBin, originalTests });
  return { ok: !findings.some((f) => f.level === 'fail'), findings };
}

const USAGE = 'usage: node tools/check.mjs [--release | --push <commit>]';

function parseArgs(argv) {
  if (argv.length === 0) return { mode: 'default' };
  if (argv.length === 1 && argv[0] === '--release') return { mode: 'release' };
  if (argv.length === 2 && argv[0] === '--push') return { mode: 'push', commit: argv[1] };
  throw new ToolError('usage', USAGE);
}

function cli(argv) {
  try {
    const { ok, findings } = runChecks({ repo: process.cwd(), ...parseArgs(argv) });
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
