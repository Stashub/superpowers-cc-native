// Integration test: imports six real obra/superpowers releases through runSync, with three
// trial edits of ours on main (spec 4 and 6.9). Needs a local clone of the original with all
// tags, named by SUPERPOWERS_UPSTREAM_CLONE; without it the test is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from '../lib/git.mjs';
import { countOldRefs, isText } from '../lib/rename.mjs';
import { verifySeals } from '../lib/upstream.mjs';
import { runSync } from '../sync.mjs';
import { initRepo, seedMain, tempDir } from './helpers.mjs';

const CLONE = process.env.SUPERPOWERS_UPSTREAM_CLONE;

// Commit prefixes the release tags must point to (spec 14). A clone may carry tags of another
// fork with the same numbers; the result would then mean nothing.
const PINNED = {
  'v6.3.0': 'b36e082', 'v6.4.1': '5bf4e78', 'v6.4.2': '8ca22db',
  'v7.0.0': 'bb92a77', 'v7.0.1': '2ce8aa1', 'v7.0.2': '22f0b46',
};

const FIRST = 'v6.3.0';
const NEXT = ['v6.4.1', 'v6.4.2', 'v7.0.0', 'v7.0.1', 'v7.0.2'];

// Observed in the real run of 2026-11-07 (spec 4).
const EXPECTED_CONFLICTS = {
  'v6.4.1': ['plugin/skills/executing-plans/SKILL.md'],
  'v6.4.2': [],
  'v7.0.0': ['plugin/skills/brainstorming/SKILL.md'],
  'v7.0.1': ['plugin/skills/executing-plans/SKILL.md', 'plugin/skills/subagent-driven-development/SKILL.md'],
  'v7.0.2': [],
};

const SDD_SKILL = 'plugin/skills/subagent-driven-development/SKILL.md';
const EXEC_SKILL = 'plugin/skills/executing-plans/SKILL.md';
const BRAIN_SKILL = 'plugin/skills/brainstorming/SKILL.md';
const POINTER = '\nIn Claude Code, also read references/cc-tasks.md.\n';
const HANDOFF_OLD = 'writing-plans skill';
const HANDOFF_NEW = 'writing-plans skill (CC: see references/cc-handoff.md)';

// applyTrialEdits(repo): void. Idempotent: the three one-line edits of spec 4.
function applyTrialEdits(repo) {
  for (const skill of [SDD_SKILL, EXEC_SKILL]) {
    const file = path.join(repo, skill);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(POINTER)) writeFileSync(file, text + POINTER);
    const ref = path.join(path.dirname(file), 'references', 'cc-tasks.md');
    mkdirSync(path.dirname(ref), { recursive: true });
    writeFileSync(ref, 'our CC-only text\n');
  }
  const brain = path.join(repo, BRAIN_SKILL);
  const text = readFileSync(brain, 'utf8');
  // A no-op when the release has no such phrase (v7.0.0 words that spot differently); the
  // final assertions check the pointer is there at the end.
  if (!text.includes('cc-handoff')) writeFileSync(brain, text.replace(HANDOFF_OLD, HANDOFF_NEW));
}

// commitIfChanged(repo, msg): boolean. Commits the working copy when it differs from HEAD.
function commitIfChanged(repo, msg) {
  git(repo, ['add', '-A']);
  if (git(repo, ['status', '--porcelain']) === '') return false;
  git(repo, ['commit', '-q', '-m', msg]);
  return true;
}

// What the owner does after a release: main takes the sync branch, the branch goes away.
function finishToMain(repo, tag) {
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', `sync/${tag}`]);
  git(repo, ['branch', '-q', '-d', `sync/${tag}`]);
}

test('six real releases merge with only the expected conflicts', {
  skip: CLONE ? false : 'SUPERPOWERS_UPSTREAM_CLONE is not set',
  timeout: 600_000,
}, (t) => {
  // The tags must be the pinned commits, before anything is imported.
  for (const [tag, prefix] of Object.entries(PINNED)) {
    const sha = git(CLONE, ['rev-parse', `${tag}^{commit}`]);
    assert.ok(sha.startsWith(prefix),
      `tag ${tag} in the clone points to ${sha}, expected a commit starting with ${prefix}`);
  }

  const repo = tempDir(t);
  initRepo(repo);
  seedMain(repo);
  const sync = (tag) => runSync({ repo, tag, from: CLONE, check: false });

  // 1. First import, main takes it.
  const first = sync(FIRST);
  assert.equal(first.status, 'merged');
  assert.equal(first.imported, true);
  assert.deepEqual(first.conflicts, []);
  finishToMain(repo, FIRST);

  // The import keeps symlinks of the original.
  assert.match(git(repo, ['ls-tree', '-r', 'upstream']), /^120000 /m);

  // 2. The three trial edits go to main.
  applyTrialEdits(repo);
  assert.equal(commitIfChanged(repo, 'trial: our three edits'), true);

  // 3. The next five releases.
  const seen = {};
  for (const tag of NEXT) {
    const res = sync(tag);
    assert.equal(res.imported, true, `${tag} was not imported`);
    assert.equal(res.branch, `sync/${tag}`);
    seen[tag] = [...res.conflicts].sort();
    assert.deepEqual(seen[tag], EXPECTED_CONFLICTS[tag], `conflicts of ${tag}`);
    if (EXPECTED_CONFLICTS[tag].length === 0) {
      assert.equal(res.status, 'merged', `${tag} should merge cleanly`);
    } else {
      assert.equal(res.status, 'conflict', `${tag} should stop on a conflict`);
      // Our resolution: take the original's version, then redo the trial edits.
      git(repo, ['checkout', '--theirs', '--', ...res.conflicts]);
      applyTrialEdits(repo);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '--no-edit']);
    }
    assert.equal(git(repo, ['status', '--porcelain']), '', `${tag}: working copy is clean after the merge`);
    finishToMain(repo, tag);
    applyTrialEdits(repo);
    commitIfChanged(repo, `trial: our edits after ${tag}`);
  }
  // The loop saw every tag, so an empty comparison cannot pass the test by accident.
  assert.deepEqual(Object.keys(seen), NEXT);

  // The sealed branch holds exactly the six imports.
  assert.deepEqual(verifySeals(repo, 'upstream'), []);
  assert.equal(git(repo, ['rev-list', '--count', 'upstream']), '6');

  // No old-style references anywhere in plugin/ (text files only; symlinks are not followed).
  const files = git(repo, ['ls-files', '-z', '--', 'plugin/']).split('\0').filter(Boolean);
  assert.ok(files.length > 50, `plugin/ has only ${files.length} files`);
  let textFiles = 0;
  for (const rel of files) {
    const abs = path.join(repo, rel);
    if (!existsSync(abs) || !lstatSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    if (!isText(buf)) continue;
    textFiles += 1;
    assert.equal(countOldRefs(buf), 0, `${rel} still has superpowers: references`);
  }
  assert.ok(textFiles > 50, `only ${textFiles} text files were checked`);

  // The pointers are in place.
  for (const skill of [SDD_SKILL, EXEC_SKILL])
    assert.ok(readFileSync(path.join(repo, skill), 'utf8').includes('references/cc-tasks.md'), `${skill} lacks the cc-tasks pointer`);
  assert.ok(readFileSync(path.join(repo, BRAIN_SKILL), 'utf8').includes('cc-handoff'), `${BRAIN_SKILL} lacks the cc-handoff pointer`);

  // Our whole difference from the original in plugin/ is the three edits.
  assert.deepEqual(git(repo, ['diff', '--name-only', 'upstream', 'HEAD', '--', 'plugin/']).split('\n').sort(), [
    'plugin/skills/brainstorming/SKILL.md',
    'plugin/skills/executing-plans/SKILL.md', 'plugin/skills/executing-plans/references/cc-tasks.md',
    'plugin/skills/subagent-driven-development/SKILL.md', 'plugin/skills/subagent-driven-development/references/cc-tasks.md',
  ]);
});
