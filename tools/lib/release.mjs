// The release state of a commit (spec 7.2): base, last release, expected number, and whether
// there is nothing to release, a release is being prepared, or something is wrong.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.mjs';
import { finding } from './findings.mjs';
import { git, run } from './git.mjs';
import { compareRelease, nextReleaseVersion, parseRelease } from './semver.mjs';
import { readImportTrailers, upstreamRef } from './upstream.mjs';

const MARKETPLACE = '.claude-plugin/marketplace.json';
const CHANGELOG = 'CHANGELOG.md';

// The object name `rev` resolves to, or null. `--end-of-options`: rev is never an option.
function revParse(root, rev) {
  const res = run(root, ['rev-parse', '--verify', '-q', '--end-of-options', rev]);
  return res.status === 0 ? res.stdout.toString('utf8').trim() : null;
}

// resolveCommit(root, rev): the sha of the commit `rev` names, or null if it names none.
export const resolveCommit = (root, rev) => revParse(root, `${rev}^{commit}`);

// The text of `rel` from the working copy, or from the commit `sha`; null if it is absent.
function readText(root, rel, sha, worktree) {
  if (worktree) {
    try {
      return readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  }
  const res = run(root, ['cat-file', 'blob', `${sha}:${rel}`]);
  return res.status === 0 ? res.stdout.toString('utf8') : null;
}

// The `version` of the single plugin in the root marketplace, or null. Whether it is valid is
// checkRootMarketplace's business; here a wrong value simply is not the expected number.
function marketplaceVersion(text) {
  if (text === null) return null;
  try {
    const plugins = JSON.parse(text)?.plugins;
    const version = Array.isArray(plugins) && plugins.length === 1 ? plugins[0]?.version : null;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

// `Upstream-Tag` of the merge base of `sha` and the upstream branch, without "v"; or null.
function baseOf(root, sha) {
  const upstream = upstreamRef(root);
  if (upstream === null) return null;
  const res = run(root, ['merge-base', sha, upstream]);
  if (res.status !== 0) return null;
  const { tag } = readImportTrailers(root, res.stdout.toString('utf8').trim());
  return tag === null ? null : tag.replace(/^v/, '');
}

const isRelease = (tag) => {
  try {
    parseRelease(tag);
    return true;
  } catch (err) {
    if (err instanceof ToolError) return false;
    throw err;
  }
};

// Release tags `v*-cc.*` reachable from `sha`. Spec 8: they are annotated, and only those
// count. Returns { last, lightweight }: the highest annotated one without "v" (or null) and
// the names of the lightweight ones.
function releaseTags(root, sha) {
  const out = git(root, [
    'for-each-ref', '--merged', sha, '--format=%(objecttype) %(refname:strip=2)', 'refs/tags/v*-cc.*',
  ]);
  const annotated = [];
  const lightweight = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [type, name] = line.split(' ');
    if (isRelease(name)) (type === 'tag' ? annotated : lightweight).push(name);
  }
  if (annotated.length === 0) return { last: null, lightweight };
  return { last: annotated.reduce((a, b) => (compareRelease(a, b) >= 0 ? a : b)).slice(1), lightweight };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasHeading = (text, version) => {
  const re = new RegExp(`^## ${escapeRe(version)} - \\d{4}-\\d{2}-\\d{2}$`);
  return text !== null && text.split(/\r?\n/).some((line) => re.test(line));
};

// releaseState(root, { commit, worktree }) -> { state, base, last, expected, version, errors }.
// root: the working tree root. state: 'nothing' | 'preparing' | 'error'; errors: fail
// findings, empty unless the state is 'error'. plugin/ is always taken from `commit`; the marketplace number and CHANGELOG.md come from the
// working copy when `worktree` is true, else from `commit`. Throws ToolError('bad-commit').
export function releaseState(root, { commit = 'HEAD', worktree = true } = {}) {
  const sha = resolveCommit(root, commit);
  if (sha === null) throw new ToolError('bad-commit', `${commit} is not a commit`);
  const base = baseOf(root, sha);
  const { last, lightweight } = releaseTags(root, sha);
  const expected = base === null ? null : nextReleaseVersion(base, last);
  const version = marketplaceVersion(readText(root, MARKETPLACE, sha, worktree));
  const result = (state, errors = []) => ({ state, base, last, expected, version, errors });
  const fail = (code, text) => finding('fail', code, text);
  const shown = version === null ? `missing in ${MARKETPLACE}` : version;
  const tagErrors = lightweight.map((name) => fail('tag-lightweight',
    `release tag ${name} is lightweight, so it does not count as a release (release tags are annotated); ` +
    `if it was never pushed, replace it on the same commit: git tag -f -a -m "Release ${name}" ${name} ${name}`));

  const tree = revParse(root, `${sha}:plugin`);
  const changed = last === null ? tree !== null : tree !== revParse(root, `refs/tags/v${last}:plugin`);
  if (!changed) {
    if (last === null || version === last) return result(tagErrors.length === 0 ? 'nothing' : 'error', tagErrors);
    return result('error', [...tagErrors, fail('no-plugin-change',
      `the version is ${shown}, not the last release ${last}, but plugin/ has not changed since v${last}`)]);
  }

  const errors = [...tagErrors];
  if (base === null) {
    errors.push(fail('no-base', 'plugin/ exists, but no upstream import is merged, so there is no base for the number'));
  } else if (version !== expected) {
    errors.push(fail('version-expected', version === last
      ? `plugin/ changed since v${last}, but the version is still ${last}; expected ${expected}`
      : `the version is ${shown}; expected ${expected}`));
  }
  if (version !== null) {
    if (!hasHeading(readText(root, CHANGELOG, sha, worktree), version))
      errors.push(fail('changelog-missing', `${CHANGELOG} has no heading "## ${version} - YYYY-MM-DD"`));
    if (version !== last && !lightweight.includes(`v${version}`) && revParse(root, `refs/tags/v${version}`) !== null)
      errors.push(fail('tag-elsewhere', `tag v${version} already exists, but it is not the last release reachable from this commit`));
  }
  return result(errors.length === 0 ? 'preparing' : 'error', errors);
}

// One line for people: the state and the expected number (spec 7.2: the script prints it).
export function describeRelease(s) {
  const numbers = `(base ${s.base ?? 'unknown'}, last release ${s.last ?? 'none'}, marketplace ${s.version ?? 'none'})`;
  const expected = s.expected ?? 'unknown, no upstream import is merged';
  if (s.state === 'nothing') return `nothing to release; expected number for the next release: ${expected} ${numbers}`;
  if (s.state === 'preparing') return `preparing release ${s.version}; expected number: ${expected} ${numbers}`;
  return `the release state is wrong; expected number: ${expected} ${numbers}`;
}
