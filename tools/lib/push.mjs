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

// Commits that `localSha` publishes: not reachable from the remote sha when this clone has
// it, otherwise not reachable from the remote-tracking refs of `remote` (all of them when
// there is no remote name). One git call. Returns [{ sha, author, committer, ok }].
function newCommits(repo, remote, localSha, remoteSha) {
  const tip = peelCommit(repo, localSha);
  if (tip === null) return [];
  const known = ZERO_RE.test(remoteSha) ? null : peelCommit(repo, remoteSha);
  const exclude = known !== null ? [known] : remote ? [`--remotes=${remote}`] : [];
  const out = git(repo, [
    'rev-list', '--no-commit-header', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', tip, '--not', ...exclude,
  ]);
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

// checkPushIdentity(repo, remote, updates) -> string[]: one block message per problem, []
// if the push may go. remote: the remote name the hook got (argv[2]), or null. updates: the
// lines of the hook's stdin as [{ localRef, localSha, remoteRef, remoteSha }].
export function checkPushIdentity(repo, remote, updates) {
  const blocks = [];
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

    const wrong = newCommits(repo, remote, localSha, remoteSha).filter((c) => !c.ok && !named.has(c.sha));
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
