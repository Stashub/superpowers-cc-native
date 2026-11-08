// The identity of what a push publishes (spec 5.3, 8; checked by tools/hooks/pre-push). A
// wrong name in public history can only be removed by rewriting it, so every new commit must
// have IDENTITY as author and committer, every pushed annotated tag IDENTITY as tagger, and
// release and import tags must be annotated.
import { IDENTITY } from './constants.mjs';
import { git, run } from './git.mjs';

const ZERO_RE = /^0+$/;
const WANT = `${IDENTITY.name} <${IDENTITY.email}>`;
// refs/tags/v*-cc.* and refs/tags/upstream/*: --follow-tags only sends annotated tags.
const ANNOTATED_ONLY = [/^refs\/tags\/v.*-cc\./, /^refs\/tags\/upstream\//];
const SHOWN = 10;
const TAGGER_RE = /^tagger (.*) <(.*)> \d+ [+-]\d{4}$/;

const isWanted = (name, email) => name === IDENTITY.name && email === IDENTITY.email;

// The commit `rev` peels to, or null (a tree, a blob, or an object this clone does not have).
function peelCommit(repo, rev) {
  const res = run(repo, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`]);
  return res.status === 0 ? res.stdout.toString('utf8').trim() : null;
}

// The commits the remote at `url` advertises right now: one `git ls-remote`, keeping what this
// clone has (peeled to commits). [] when there is no URL or the remote cannot be asked, which
// leaves only the remote sha of each ref excluded: the strict case. The local remote-tracking
// refs are not used on purpose: they are stale after a deletion on the remote, a `set-url`, or
// an extra push URL, and can be made by hand.
function advertisedCommits(repo, url) {
  if (!url) return [];
  const res = run(repo, ['ls-remote', '--end-of-options', url]);
  if (res.status !== 0) return [];
  const shas = new Set(res.stdout.toString('utf8').split('\n').map((l) => l.split('\t')[0]).filter(Boolean));
  if (shas.size === 0) return [];
  const input = [...shas].map((sha) => `${sha}^{commit}\n`).join('');
  const out = run(repo, ['cat-file', '--batch-check=%(objecttype) %(objectname)'], { input });
  if (out.status !== 0) return [];
  const commits = out.stdout.toString('utf8').split('\n').filter((l) => l.startsWith('commit '));
  return [...new Set(commits.map((l) => l.slice('commit '.length)))];
}

// Commits that `localSha` publishes: not reachable from the remote sha of the ref (when this
// clone has it) and not reachable from `advertised`, the commits the remote has in its refs
// right now. Commits reachable from those are already public there, so sending them again
// publishes nothing new; this covers a PR merged on GitHub and then merged into the branch
// being pushed. One git call. Returns [{ sha, author, committer, ok }].
function newCommits(repo, advertised, localSha, remoteSha) {
  const tip = peelCommit(repo, localSha);
  if (tip === null) return [];
  const known = ZERO_RE.test(remoteSha) ? null : peelCommit(repo, remoteSha);
  const exclude = [...new Set([...(known !== null ? [known] : []), ...advertised])];
  const input = [tip, ...exclude.map((sha) => `^${sha}`)].join('\n') + '\n';
  const out = git(repo, [
    'rev-list', '--no-commit-header', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', '--stdin',
  ], { input });
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, an, ae, cn, ce] = line.split('\0');
    return { sha, author: `${an} <${ae}>`, committer: `${cn} <${ce}>`, ok: isWanted(an, ae) && isWanted(cn, ce) };
  });
}

// The tagger of the annotated tag object `sha` as { name, email }, or null if it has none.
function tagger(repo, sha) {
  const header = git(repo, ['cat-file', 'tag', sha]).split('\n\n')[0];
  for (const line of header.split('\n')) {
    const m = TAGGER_RE.exec(line);
    if (m) return { name: m[1], email: m[2] };
  }
  return null;
}

// checkPushIdentity(repo, url, updates) -> string[]: one block message per problem, []
// if the push may go. url: the URL the hook got (argv[3]), or null; it is asked once, and only
// if a ref needs it, which commits the remote already has. updates: the lines of the hook's
// stdin as [{ localRef, localSha, remoteRef, remoteSha }].
export function checkPushIdentity(repo, url, updates) {
  const blocks = [];
  let advertised = null;
  const named = new Set(); // a commit that several refs publish is named once
  for (const { localSha, remoteRef, remoteSha } of updates) {
    if (ZERO_RE.test(localSha)) continue;

    if (remoteRef.startsWith('refs/tags/')) {
      const type = git(repo, ['cat-file', '-t', localSha]);
      if (type === 'tag') {
        const who = tagger(repo, localSha);
        if (who === null || !isWanted(who.name, who.email)) {
          const found = who === null ? 'no tagger' : `tagger ${who.name} <${who.email}>`;
          blocks.push(`${remoteRef}: the tag has ${found}, expected ${WANT}`);
        }
      } else if (ANNOTATED_ONLY.some((re) => re.test(remoteRef))) {
        blocks.push(`${remoteRef}: a lightweight tag (a ${type}); release and import tags must be annotated (git tag -a)`);
      }
    }

    const wrong = newCommits(repo, (advertised ??= advertisedCommits(repo, url)), localSha, remoteSha).filter((c) => !c.ok && !named.has(c.sha));
    for (const c of wrong) named.add(c.sha);
    if (wrong.length > 0) {
      const shown = wrong.slice(0, SHOWN).map((c) => `  ${c.sha.slice(0, 7)} author ${c.author}, committer ${c.committer}`);
      if (wrong.length > SHOWN) shown.push(`  ... and ${wrong.length - SHOWN} more`);
      blocks.push([
        `${remoteRef}: ${wrong.length} new commit${wrong.length === 1 ? ' is' : 's are'} not by ${WANT}:`,
        ...shown,
        '  Commits by others are merged on GitHub, not pushed from a local merge; rewrite own commits with the right identity.',
      ].join('\n'));
    }
  }
  return blocks;
}

// checkPublishedTags(repo, updates) -> string[]: one block message per problem, [] if the push
// may go. A published annotated release or import tag (the ANNOTATED_ONLY names) is never
// replaced, moved or deleted. A lightweight one on the remote (made by a GitHub release) may be
// replaced by an annotated tag on the same commit, or deleted. The remote sha must be in this
// clone: otherwise it cannot be judged, fetch first.
export function checkPublishedTags(repo, updates) {
  const blocks = [];
  for (const { localSha, remoteRef, remoteSha } of updates) {
    if (!ANNOTATED_ONLY.some((re) => re.test(remoteRef)) || ZERO_RE.test(remoteSha) || localSha === remoteSha) continue;
    const short = remoteSha.slice(0, 7);
    if (run(repo, ['cat-file', '-e', remoteSha]).status !== 0) {
      blocks.push(`${remoteRef}: the remote has ${short}, which this clone does not have; fetch first (git fetch origin --tags); if that fails with "would clobber existing tag", see "Lightweight release tag" in CLAUDE.md`);
    } else if (git(repo, ['cat-file', '-t', remoteSha]) === 'tag') {
      blocks.push(`${remoteRef}: the remote has the annotated tag ${short}; a published annotated release or import tag is never replaced, moved or deleted`);
    } else if (!ZERO_RE.test(localSha)) {
      const was = peelCommit(repo, remoteSha);
      const now = peelCommit(repo, localSha);
      if (now === null || now !== was)
        blocks.push(`${remoteRef}: the remote tag names commit ${short}, the new one ${now === null ? 'is not a commit' : `names ${now.slice(0, 7)}`}; a published release or import tag stays on its commit`);
    }
  }
  return blocks;
}
