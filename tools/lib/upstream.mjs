// Import of an obra/superpowers tag as a sealed commit on the `upstream` branch (spec 5.1, 6).
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  IDENTITY, OBRA_TAG_PREFIX, UPSTREAM_BRANCH, UPSTREAM_PLUGIN_NAME, UPSTREAM_URL,
} from './constants.mjs';
import { ToolError } from './errors.mjs';
import { git, run } from './git.mjs';
import { transformPluginJson } from './manifest.mjs';
import { isText, renameBuffer } from './rename.mjs';

const PREFIX = 'plugin/';
const MARKETPLACE = '.claude-plugin/marketplace.json';
const MANIFEST = '.claude-plugin/plugin.json';
const LOCAL_REF = `refs/heads/${UPSTREAM_BRANCH}`;
const REMOTE_REF = `refs/remotes/origin/${UPSTREAM_BRANCH}`;

const tagRef = (tag) => `${OBRA_TAG_PREFIX}${tag}`;
const importTagName = (tag) => `upstream/${tag}`;
const refExists = (repo, ref) => run(repo, ['rev-parse', '--verify', '-q', ref]).status === 0;

// Fetches one tag of the original into refs/obra/tags/<tag> (the "+" follows a moved tag).
// Returns the commit the tag points to.
export function fetchUpstreamTag(repo, tag, from = UPSTREAM_URL) {
  const res = run(repo, ['fetch', '--no-tags', from, `+refs/tags/${tag}:${tagRef(tag)}`]);
  if (res.status !== 0) {
    if (/couldn't find remote ref/i.test(res.stderr))
      throw new ToolError('no-such-tag', `the original has no tag ${tag}`);
    throw new ToolError('git', `git fetch ${from} ${tag}: ${res.stderr.trim()}`);
  }
  return git(repo, ['rev-parse', `${tagRef(tag)}^{commit}`]);
}

// `name` from .claude-plugin/plugin.json of a fetched tag; null if absent or unreadable.
export function upstreamPluginName(repo, tag) {
  const res = run(repo, ['show', `${tagRef(tag)}:${MANIFEST}`]);
  if (res.status !== 0) return null;
  try {
    const name = JSON.parse(res.stdout.toString('utf8'))?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

// Entries of `git ls-tree -r -z`. Paths stay byte exact: they are kept as latin1 strings.
function listTree(repo, rev) {
  const out = run(repo, ['ls-tree', '-r', '-z', rev]);
  if (out.status !== 0) throw new ToolError('git', `git ls-tree ${rev}: ${out.stderr.trim()}`);
  const entries = [];
  for (const raw of out.stdout.toString('latin1').split('\0')) {
    if (raw === '') continue;
    const tab = raw.indexOf('\t');
    const [mode, type, sha] = raw.slice(0, tab).split(' ');
    entries.push({ mode, type, sha, path: raw.slice(tab + 1) });
  }
  return entries;
}

// Builds the tree of the import commit without a working copy (spec 6.2, steps 1-5).
// Returns { tree, files, renamedFiles, renamedRefs }: the tree hash, the number of entries in
// it, the number of files changed by renaming and the total number of replacements.
export function buildImportTree(repo, tag) {
  const commit = git(repo, ['rev-parse', `${tagRef(tag)}^{commit}`]);
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  const indexFile = path.join(gitDir, `sync-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: indexFile };
  const writeBlob = (buf) =>
    git(repo, ['hash-object', '-w', '--stdin', '--no-filters'], { input: buf });

  let files = 0;
  let renamedFiles = 0;
  let renamedRefs = 0;
  const lines = [];
  try {
    for (const entry of listTree(repo, commit)) {
      if (entry.path === MARKETPLACE) continue;
      let { sha } = entry;
      if (entry.type === 'blob' && entry.mode !== '120000') {
        const buf = run(repo, ['cat-file', 'blob', sha]).stdout;
        if (entry.path === MANIFEST) {
          let text;
          try {
            text = transformPluginJson(buf.toString('utf8'));
          } catch (err) {
            if (err instanceof SyntaxError)
              throw new ToolError('bad-manifest', `${MANIFEST} of ${tag} is not valid JSON`);
            throw err;
          }
          sha = writeBlob(Buffer.from(text, 'utf8'));
        } else if (isText(buf)) {
          const { buf: renamed, count } = renameBuffer(buf);
          if (count > 0) {
            sha = writeBlob(renamed);
            renamedFiles += 1;
            renamedRefs += count;
          }
        }
      }
      files += 1;
      lines.push(Buffer.concat([
        Buffer.from(`${entry.mode} ${sha}\t${PREFIX}`, 'latin1'),
        Buffer.from(`${entry.path}\0`, 'latin1'),
      ]));
    }
    git(repo, ['update-index', '-z', '--add', '--index-info'], { input: Buffer.concat(lines), env });
    const tree = git(repo, ['write-tree'], { env });
    return { tree, files, renamedFiles, renamedRefs };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}

// Creates the sealed import commit, moves refs/heads/upstream to it (from `parent`, or from
// "no branch" when parent is null) and adds the annotated tag upstream/<tag>. Returns the sha.
export function createImportCommit(repo, { tag, upstreamCommit, tree, parent }) {
  // Stored without a final newline: the message is exactly the block of spec 6.2, so
  // `git log --format=%B` prints it (plus its own terminator) and nothing more.
  const message = [
    `upstream ${tag} (${upstreamCommit.slice(0, 7)})`,
    '',
    `Upstream-Tag: ${tag}`,
    `Upstream-Commit: ${upstreamCommit}`,
    `Sync-Tree: ${tree}`,
  ].join('\n');
  const commit = git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], {
    input: message,
  });
  git(repo, ['update-ref', LOCAL_REF, commit, parent ?? '']);
  ensureImportTag(repo, commit, tag);
  return commit;
}

// Creates the annotated tag upstream/<tag> on `commit` if it is missing. True if it created it.
export function ensureImportTag(repo, commit, tag) {
  const name = importTagName(tag);
  if (refExists(repo, `refs/tags/${name}`)) return false;
  git(repo, ['tag', '-a', '-m', `upstream ${tag}`, name, commit]);
  return true;
}

// Trailers of the commit at `rev`; a missing trailer is null.
export function readImportTrailers(repo, rev) {
  const read = (key) =>
    git(repo, ['log', '-1', `--format=%(trailers:key=${key},valueonly)`, rev]).trim() || null;
  return {
    tag: read('Upstream-Tag'),
    commit: read('Upstream-Commit'),
    tree: read('Sync-Tree'),
  };
}

// Checks every commit of `rev` along --first-parent: it needs the Upstream-Tag and Sync-Tree
// trailers and its tree must equal Sync-Tree. Returns the broken ones; [] means all is well.
export function verifySeals(repo, rev) {
  const broken = [];
  for (const commit of git(repo, ['rev-list', '--first-parent', rev]).split('\n').filter(Boolean)) {
    const trailers = readImportTrailers(repo, commit);
    if (trailers.tag === null || trailers.tree === null) {
      broken.push({ commit, reason: 'no-trailers' });
    } else if (git(repo, ['rev-parse', `${commit}^{tree}`]) !== trailers.tree) {
      broken.push({ commit, reason: 'tree-mismatch' });
    }
  }
  return broken;
}

// Which upstream branch exists, without fetching: local first.
export function upstreamRef(repo) {
  if (refExists(repo, LOCAL_REF)) return UPSTREAM_BRANCH;
  if (refExists(repo, REMOTE_REF)) return `origin/${UPSTREAM_BRANCH}`;
  return null;
}

// Spec 6.7. Fetches origin (if there is one), then reconciles the local upstream branch with
// origin/upstream. 'local' = the local branch is the base (equal to or ahead of origin),
// 'from-origin' = it was just created from origin/upstream (nothing is checked out),
// 'none' = no upstream branch anywhere (a first import).
export function prepareUpstream(repo) {
  if (run(repo, ['config', '--get', 'remote.origin.url']).status === 0) {
    git(repo, ['fetch', 'origin']);
  }
  const hasLocal = refExists(repo, LOCAL_REF);
  const hasRemote = refExists(repo, REMOTE_REF);
  if (!hasLocal && !hasRemote) return 'none';
  if (!hasLocal) {
    git(repo, ['branch', '--no-track', UPSTREAM_BRANCH, REMOTE_REF]);
    return 'from-origin';
  }
  if (!hasRemote) return 'local';
  const isAncestor = (a, b) => run(repo, ['merge-base', '--is-ancestor', a, b]).status === 0;
  if (isAncestor(REMOTE_REF, LOCAL_REF)) return 'local';
  if (isAncestor(LOCAL_REF, REMOTE_REF))
    throw new ToolError('upstream-behind', 'local upstream is behind origin/upstream; fast-forward it first');
  throw new ToolError('upstream-diverged', 'local upstream and origin/upstream have diverged');
}

const IDENT_RE = /^(.*) <(.*)> \d+ [+-]\d{4}$/;

// Spec 5.3, 6.8. Problems with the identity commits would get, [] if there are none. Checks
// the local config, then the identity git really uses (environment variables such as
// GIT_AUTHOR_NAME override the local config). At most one message per field.
export function checkIdentity(repo) {
  const local = (key) => {
    const res = run(repo, ['config', '--local', '--get', key]);
    return res.status === 0 ? res.stdout.toString('utf8').trim() : null;
  };
  const fields = [
    { label: 'name', key: 'user.name', want: IDENTITY.name, got: local('user.name'), problem: null },
    { label: 'email', key: 'user.email', want: IDENTITY.email, got: local('user.email'), problem: null },
  ];
  for (const f of fields) {
    if (f.got === null) {
      f.problem = `local ${f.key} is not set; run: git config --local ${f.key} ${f.want}`;
    } else if (f.got !== f.want) {
      f.problem = `local ${f.key} is "${f.got}", expected "${f.want}"; run: git config --local ${f.key} ${f.want}`;
    }
  }

  const effective = { name: [], email: [] };
  let unavailable = false;
  for (const role of ['AUTHOR', 'COMMITTER']) {
    const res = run(repo, ['var', `GIT_${role}_IDENT`]);
    const m = res.status === 0 ? IDENT_RE.exec(res.stdout.toString('utf8').trim()) : null;
    if (m === null) unavailable = true;
    else {
      effective.name.push({ role, value: m[1] });
      effective.email.push({ role, value: m[2] });
    }
  }

  for (const f of fields) {
    if (f.problem !== null) continue;
    if (unavailable) {
      // `git var` failed although the local config is complete for this field. If the other
      // field is the broken one, git fails because of it, and that field already reports it.
      if (fields.every((x) => x.problem === null))
        f.problem = `git cannot determine the ${f.label} it would commit with (git var failed)`;
      continue;
    }
    const wrong = effective[f.label].find((e) => e.value !== f.want);
    if (wrong) {
      f.problem = `git would use ${f.label} "${wrong.value}" for the ${wrong.role.toLowerCase()}, not "${f.want}": ` +
        `an environment variable (GIT_${wrong.role}_${f.label.toUpperCase()}) overrides the local config; ` +
        `unset it, e.g. env -u GIT_${wrong.role}_${f.label.toUpperCase()} git ...`;
    }
  }
  return fields.filter((f) => f.problem !== null).map((f) => f.problem);
}
