# CLAUDE.md

Rules for the agent that maintains this repository. This is a Claude Code
native fork of obra/superpowers, kept as a vendor branch: `upstream` holds
sealed imports of original releases, `main` is `upstream` merged in plus our own
files. Design: `docs/superpowers/specs/2026-11-08-superpowers-cc-native-design.md`.

## Rules

- Never write to the `upstream` branch by hand and never switch to it. Only
  `tools/sync.mjs` writes there.
- Keep our own work in our own files (see "Growth rules").
- Every `plugin/skills/*/SKILL.md` stays under 20000 bytes.
- Changes to `plugin/` reach `main` only together with a release, and every
  release gets a new version number.
- Every change of ours adds a line to `## Unreleased` in `CHANGELOG.md`, in the
  same commit.
- No personal or infrastructure data in the repository: no hosts, no absolute
  machine paths, no profile names, no other projects of the owner.
- Text is in English. Use only the hyphen "-", never long or medium dashes.
- Commit and push only on the owner's explicit word.

## Fresh clone setup

Run these three commands first:

```
git config user.name Stashub
git config user.email 64739874+Stashub@users.noreply.github.com
git config core.hooksPath tools/hooks
```

Do not create the local `upstream` branch by hand: `sync.mjs` creates it from
`origin/upstream`.

The environment variables GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL override the local config, so unset
them when committing in this repository. `sync.mjs` and `check.mjs --release`
stop if the effective identity is not Stashub with the noreply address.

## Tests

```
node --test "tools/test/*.test.mjs"
```

Always pass the explicit pattern. A bare `node --test` also picks up the
original's `plugin/tests/**/*.test.js`.

## Import steps (new original release)

1. Work from a clean `main`. Run `node tools/sync.mjs <tag>` (for example
   `v7.0.3`). It fetches the tag from the original into `refs/obra/tags/*`,
   builds the renamed import commit on `upstream` with tag `upstream/<tag>`,
   creates branch `sync/<tag>` from `main` and merges `upstream` into it with
   `--no-ff`.
2. Read the output. After a clean merge `sync.mjs` runs `node tools/check.mjs`,
   so the check output comes first. The report follows: clean merge or
   conflicted files, and the count of our lines in the original's files
   (`git diff --numstat upstream HEAD -- plugin/`).
3. On conflict the script stops without the check, prints the report and the
   branch stays mid-merge. Resolve it, commit, run `node tools/check.mjs`.
4. If the check fails, the script stops with `check-failed` and prints no
   report. You are on `sync/<tag>` and the merge is committed there. Fix,
   commit, run `node tools/check.mjs`. Rerunning sync for the same tag then
   reports `nothing-to-do` and does not run the check.
5. Release in the same branch (next section). After the owner's word, move
   `main` to the branch with `git merge --ff-only` and delete the `sync/*`
   branch.

Rerunning for a tag that is already imported creates no new commit.

## Release steps

The version is `<original version>-cc.N`, for example `7.0.2-cc.1`,
`7.0.2-cc.2`, `7.0.3-cc.1`. `node tools/check.mjs --release` prints the expected
number and accepts only it. No `-dev` versions in `main`.

1. In the branch, set the version in `.claude-plugin/marketplace.json` (the
   only place it is recorded) and rename `## Unreleased` in `CHANGELOG.md` to
   `## <version> - YYYY-MM-DD`, with a new empty `## Unreleased` above it.
2. `node tools/check.mjs --release`.
3. Commit `Release v<version>`. Move `main` to the branch with
   `git merge --ff-only` and create the annotated tag with
   `git tag -a v<version>`. If `main` moved on meanwhile, merge `main` into the
   branch and repeat steps 1-2: the number may change.
4. `git push --follow-tags origin main upstream`.

Release tags are always annotated: a lightweight `v*-cc.*` tag does not count
as a release and `check.mjs` reports it (`tag-lightweight`). Never move, delete
or recreate a published release tag.

Steps 1-3 need one word from the owner, step 4 a separate one. The
`tools/hooks/pre-push` hook rejects a push of `main` without a tagged release
and a push of `upstream` with a broken `Sync-Tree` seal. It also checks the
identity of every pushed commit and tag on any branch (author, committer and
tagger must be Stashub with the noreply address, release and import tags must
be annotated), so contributions by others are merged on GitHub, not pushed
from a local merge.

## Growth rules

1. Our own things go in our own files: skills in `plugin/skills/cc-<name>/`,
   references to the original's skills in
   `plugin/skills/<skill>/references/cc-<topic>.md`, hooks in
   `plugin/hooks/cc-native.json` (wired through the `hooks` field of
   `plugin.json`).
2. Prefix our files inside the original's folders with `cc-`, so a future file
   of the original with the same name cannot conflict.
3. Touch the original's files as little as possible, ideally one pointer line
   to our own file. Put the pointer at the step where it is needed, not at the
   end of the file: after context compaction only the first 5000 tokens of a
   skill come back.
4. To rework an original skill entirely, make a separate skill with another
   name and leave the original untouched.
5. Every addition is optional: if the Claude Code feature is missing, the
   plugin works like the original.
6. Keep each `SKILL.md` under 20000 bytes with our lines included. Anything
   longer than a pointer line goes to `references/`.
7. Import every original release right away: small steps mean small conflicts.
8. Watch the count of our lines in the original's files (sync and check
   reports). If it grows, move our things out into our own files.
