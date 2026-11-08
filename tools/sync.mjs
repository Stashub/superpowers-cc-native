// Imports an obra/superpowers release into the sealed `upstream` branch and merges it into
// a `sync/<tag>` branch (spec 6.1-6.8). Module and CLI: node tools/sync.mjs <tag> [--from <url|path>]
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_BRANCH, UPSTREAM_PLUGIN_NAME, UPSTREAM_URL } from './lib/constants.mjs';
import { ToolError } from './lib/errors.mjs';
import { git, repoRoot, run } from './lib/git.mjs';
import { compareUpstream, parseUpstreamTag } from './lib/semver.mjs';
import {
  buildImportTree, checkIdentity, createImportCommit, ensureImportTag, fetchUpstreamTag,
  prepareUpstream, readImportTrailers, upstreamPluginName, verifySeals,
} from './lib/upstream.mjs';

const MAIN = 'main';

// runSync({ repo, tag, from, check }) -> { status, imported, branch, conflicts, numstat }.
// status: 'nothing-to-do' | 'merged' | 'conflict'. Stops with a ToolError (spec 6.8).
export function runSync({ repo, tag, from = UPSTREAM_URL, check = true }) {
  const root = repoRoot(repo);

  if (git(root, ['status', '--porcelain']) !== '')
    throw new ToolError('dirty', 'the working copy has uncommitted changes; commit or stash them first');
  const problems = checkIdentity(root, `node tools/sync.mjs ${tag}`);
  if (problems.length > 0) throw new ToolError('identity', problems.join('\n'));

  const syncBranch = `sync/${tag}`;
  const current = git(root, ['branch', '--show-current']);
  if (current !== MAIN && current !== syncBranch)
    throw new ToolError('not-on-main', `run sync from ${MAIN} or ${syncBranch}, not from ${current || 'a detached HEAD'}`);

  const state = prepareUpstream(root);
  if (state !== 'none') {
    const broken = verifySeals(root, UPSTREAM_BRANCH);
    if (broken.length > 0) {
      const list = broken.map((b) => `${b.commit.slice(0, 7)} (${b.reason})`).join(', ');
      throw new ToolError('upstream-edited', `the ${UPSTREAM_BRANCH} branch was edited by hand: ${list}`);
    }
  }
  parseUpstreamTag(tag);

  let imported = false;
  const last = state === 'none' ? null : readImportTrailers(root, UPSTREAM_BRANCH);
  if (last !== null && last.tag === tag) {
    // Already imported (spec 6.6); an interrupted run may have left the tag out.
    ensureImportTag(root, git(root, ['rev-parse', UPSTREAM_BRANCH]), tag);
  } else {
    if (last !== null && compareUpstream(tag, last.tag) <= 0)
      throw new ToolError('not-newer', `${tag} is not newer than the last import ${last.tag}`);
    const upstreamCommit = fetchUpstreamTag(root, tag, from);
    if (upstreamPluginName(root, tag) !== UPSTREAM_PLUGIN_NAME)
      throw new ToolError('not-upstream', `${tag} is not a release of ${UPSTREAM_PLUGIN_NAME}: plugin.json name differs`);
    const { tree } = buildImportTree(root, tag);
    createImportCommit(root, {
      tag, upstreamCommit, tree, parent: last === null ? null : git(root, ['rev-parse', UPSTREAM_BRANCH]),
    });
    imported = true;
  }

  if (run(root, ['merge-base', '--is-ancestor', UPSTREAM_BRANCH, 'HEAD']).status === 0)
    return { status: 'nothing-to-do', imported, branch: null, conflicts: [], numstat: '' };

  if (current === MAIN) {
    if (run(root, ['rev-parse', '--verify', '-q', `refs/heads/${syncBranch}`]).status === 0)
      throw new ToolError('branch-exists', `branch ${syncBranch} already exists; finish or delete it first`);
    git(root, ['checkout', '-q', '-b', syncBranch]);
  }

  const unrelated = run(root, ['merge-base', 'HEAD', UPSTREAM_BRANCH]).status !== 0;
  const merge = run(root, [
    'merge', '--no-ff', ...(unrelated ? ['--allow-unrelated-histories'] : []),
    '-m', `Merge upstream ${tag}`, UPSTREAM_BRANCH,
  ]);
  let conflicts = [];
  if (merge.status !== 0) {
    conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    if (conflicts.length === 0)
      throw new ToolError('git', `git merge ${UPSTREAM_BRANCH}: ${merge.stderr.trim()}`);
  }
  const numstat = git(root, ['diff', '--numstat', UPSTREAM_BRANCH, 'HEAD', '--', 'plugin/']);
  if (conflicts.length > 0) return { status: 'conflict', imported, branch: syncBranch, conflicts, numstat };

  if (check) {
    const res = spawnSync(process.execPath, [fileURLToPath(new URL('./check.mjs', import.meta.url))], {
      cwd: root, stdio: 'inherit',
    });
    if (res.status !== 0) throw new ToolError('check-failed', 'check.mjs failed after the merge');
  }
  return { status: 'merged', imported, branch: syncBranch, conflicts: [], numstat };
}

const USAGE = 'usage: node tools/sync.mjs <tag> [--from <url|path>]';

function parseArgs(argv) {
  let tag = null;
  let from = UPSTREAM_URL;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') {
      if (i + 1 >= argv.length) throw new ToolError('usage', USAGE);
      i += 1;
      // A relative path is taken from where the user stands, not from the repository root.
      const local = path.resolve(argv[i]);
      from = existsSync(local) ? local : argv[i];
    } else if (argv[i].startsWith('-') || tag !== null) {
      throw new ToolError('usage', USAGE);
    } else {
      tag = argv[i];
    }
  }
  if (tag === null) throw new ToolError('usage', USAGE);
  return { tag, from };
}

function report(res) {
  const lines = [`status: ${res.status}`, `new import created: ${res.imported ? 'yes' : 'no'}`];
  if (res.branch !== null) lines.push(`branch: ${res.branch}`);
  if (res.conflicts.length > 0) lines.push('conflicted files:', ...res.conflicts.map((f) => `  ${f}`));
  if (res.status !== 'nothing-to-do') {
    lines.push(res.numstat === ''
      ? 'no lines of ours in upstream files'
      : `our lines in upstream files (added, removed, file):\n${res.numstat}`);
  }
  return lines.join('\n');
}

function cli(argv) {
  try {
    const { tag, from } = parseArgs(argv);
    const res = runSync({ repo: process.cwd(), tag, from });
    console.log(report(res));
    return res.status === 'conflict' ? 2 : 0;
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    console.error(err.code === 'usage' ? err.message : `stop (${err.code}): ${err.message}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)))
  process.exitCode = cli(process.argv.slice(2));
