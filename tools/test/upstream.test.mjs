import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { git, run } from '../lib/git.mjs';
import {
  buildImportTree, checkIdentity, createImportCommit, ensureImportTag, fetchUpstreamTag,
  prepareUpstream, readImportTrailers, upstreamPluginName, upstreamRef, verifySeals,
} from '../lib/upstream.mjs';
import { IDENTITY } from '../lib/constants.mjs';
import {
  commitAll, initRepo, makeOrigin, setIdentity, tempDir, writeFiles,
} from './helpers.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// An origin with the given releases and a repo that already fetched v1.0.0 from it.
function setup(t, releases = [{ tag: 'v1.0.0' }]) {
  const origin = makeOrigin(t, releases);
  const repo = tempDir(t);
  initRepo(repo);
  const upstreamCommit = fetchUpstreamTag(repo, 'v1.0.0', origin);
  return { origin, repo, upstreamCommit, gitDir: path.join(repo, '.git') };
}

// A repo with one sealed import commit on refs/heads/upstream.
function setupImported(t) {
  const s = setup(t);
  const { tree } = buildImportTree(s.repo, 'v1.0.0');
  const commit = createImportCommit(s.repo, {
    tag: 'v1.0.0', upstreamCommit: s.upstreamCommit, tree, parent: null,
  });
  return { ...s, tree, commit };
}

// Commit a one-file tree on top of `parent` (or as a root) in `dir`; returns the sha.
function plainCommit(dir, parent, name) {
  writeFiles(dir, { [name]: `${name}\n` });
  git(dir, ['add', '-A']);
  const tree = git(dir, ['write-tree']);
  return git(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', name]);
}

test('buildImportTree prefixes plugin/, renames, skips marketplace, transforms manifest', (t) => {
  const { repo } = setup(t);
  const { tree, files } = buildImportTree(repo, 'v1.0.0');
  const ls = git(repo, ['ls-tree', '-r', tree]);
  assert.match(ls, /^120000 blob \S+\tplugin\/link$/m);
  assert.match(ls, /^100755 blob \S+\tplugin\/scripts\/run\.sh$/m);
  assert.doesNotMatch(ls, /plugin\/\.claude-plugin\/marketplace\.json/);
  assert.doesNotMatch(ls, /\t(?!plugin\/)/);
  assert.equal(files, 6);
  assert.equal(git(repo, ['show', `${tree}:plugin/skills/demo/SKILL.md`]), 'Use superpowers-cc-native:demo first.');
  assert.equal(git(repo, ['rev-parse', `${tree}:plugin/assets/logo.png`]),
               git(repo, ['rev-parse', 'refs/obra/tags/v1.0.0:assets/logo.png']));
  const pj = JSON.parse(git(repo, ['show', `${tree}:plugin/.claude-plugin/plugin.json`]));
  assert.equal(pj.name, 'superpowers-cc-native');
  assert.equal('version' in pj, false);
});

test('buildImportTree is deterministic and leaves no temp index', (t) => {
  const { repo, gitDir } = setup(t);
  assert.equal(buildImportTree(repo, 'v1.0.0').tree, buildImportTree(repo, 'v1.0.0').tree);
  assert.deepEqual(readdirSync(gitDir).filter((f) => f.startsWith('sync-index')), []);
});

test('buildImportTree removes the temp index when it fails', (t) => {
  const { repo, gitDir } = setup(t);
  assert.throws(() => buildImportTree(repo, 'v8.8.8'), { code: 'git' });
  assert.deepEqual(readdirSync(gitDir).filter((f) => f.startsWith('sync-index')), []);
});

test('buildImportTree renames text blobs byte for byte, never symlinks, and counts', (t) => {
  const latin1 = Buffer.from('caf\xe9 superpowers:alpha, foo-superpowers:beta, superpowers:gamma\n', 'latin1');
  const origin = makeOrigin(t, [{
    tag: 'v1.0.0',
    files: {
      'docs/latin1.md': latin1,
      'docs/clean.md': 'nothing to rename\n',
      'bin/tool': { exec: '#!/bin/sh\n# superpowers:run\n' },
      'ref-link': { symlink: 'superpowers:target.md' },
      'blob.bin': Buffer.from('superpowers:bin\0\xff superpowers:bin2'),
    },
  }]);
  const repo = tempDir(t);
  initRepo(repo);
  fetchUpstreamTag(repo, 'v1.0.0', origin);
  const { tree, files, renamedFiles, renamedRefs } = buildImportTree(repo, 'v1.0.0');

  const blob = (p) => git(repo, ['rev-parse', `${tree}:plugin/${p}`]);
  const upstreamBlob = (p) => git(repo, ['rev-parse', `refs/obra/tags/v1.0.0:${p}`]);
  const raw = (p) => run(repo, ['cat-file', 'blob', `${tree}:plugin/${p}`]).stdout.toString('latin1');
  assert.equal(raw('docs/latin1.md'), 'caf\xe9 superpowers-cc-native:alpha, foo-superpowers:beta, superpowers-cc-native:gamma\n');
  assert.equal(blob('docs/clean.md'), upstreamBlob('docs/clean.md'));
  assert.equal(blob('ref-link'), upstreamBlob('ref-link'));
  assert.match(git(repo, ['ls-tree', tree, 'plugin/ref-link']), /^120000 /);
  assert.equal(blob('blob.bin'), upstreamBlob('blob.bin'));
  assert.match(git(repo, ['ls-tree', `${tree}:plugin/bin`]), /^100755 blob \S+\ttool$/);
  assert.equal(raw('bin/tool'), '#!/bin/sh\n# superpowers-cc-native:run\n');
  // renamed: latin1.md (2), bin/tool (1), skills/demo/SKILL.md (1)
  assert.equal(renamedFiles, 3);
  assert.equal(renamedRefs, 4);
  assert.equal(files, 11);
});

test('createImportCommit writes exact message, seal and annotated tag', (t) => {
  const { repo, upstreamCommit, tree, commit: c } = setupImported(t);
  assert.equal(git(repo, ['log', '-1', '--format=%B', c]),
    `upstream v1.0.0 (${upstreamCommit.slice(0, 7)})\n\nUpstream-Tag: v1.0.0\nUpstream-Commit: ${upstreamCommit}\nSync-Tree: ${tree}`);
  assert.equal(git(repo, ['rev-parse', 'upstream']), c);
  assert.equal(git(repo, ['rev-parse', `${c}^{tree}`]), tree);
  assert.equal(git(repo, ['cat-file', '-t', 'upstream/v1.0.0']), 'tag');
  assert.equal(git(repo, ['rev-parse', 'upstream/v1.0.0^{commit}']), c);
  assert.equal(git(repo, ['tag', '-l', '--format=%(contents:subject)', 'upstream/v1.0.0']), 'upstream v1.0.0');
  const who = `${IDENTITY.name} <${IDENTITY.email}>`;
  assert.equal(git(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', c]), `${who}|${who}`);
  assert.equal(git(repo, ['tag', '-l', '--format=%(taggername) <%(taggeremail:trim)>', 'upstream/v1.0.0']), who);
  assert.deepEqual(readImportTrailers(repo, 'upstream'), { tag: 'v1.0.0', commit: upstreamCommit, tree });
});

test('createImportCommit chains onto the parent and refuses a stale parent', (t) => {
  const { origin, repo, commit: first } = setupImported(t);
  writeFiles(origin, { 'NEW.md': 'new\n' });
  commitAll(origin, 'next');
  git(origin, ['tag', '-a', '-m', 'v1.1.0', 'v1.1.0']);
  const upstreamCommit = fetchUpstreamTag(repo, 'v1.1.0', origin);
  const { tree } = buildImportTree(repo, 'v1.1.0');
  assert.throws(
    () => createImportCommit(repo, { tag: 'v1.1.0', upstreamCommit, tree, parent: null }),
    { code: 'git' },
  );
  const second = createImportCommit(repo, { tag: 'v1.1.0', upstreamCommit, tree, parent: first });
  assert.equal(git(repo, ['rev-parse', `${second}^`]), first);
  assert.equal(git(repo, ['rev-parse', 'upstream']), second);
});

test('readImportTrailers returns null for missing trailers', (t) => {
  const { repo, commit } = setupImported(t);
  const hand = git(repo, ['commit-tree', EMPTY_TREE, '-p', commit, '-m', 'hand edit']);
  assert.deepEqual(readImportTrailers(repo, hand), { tag: null, commit: null, tree: null });
});

test('ensureImportTag creates a missing tag once', (t) => {
  const { repo, commit } = setupImported(t);
  assert.equal(ensureImportTag(repo, commit, 'v1.0.0'), false);
  git(repo, ['tag', '-d', 'upstream/v1.0.0']);
  assert.equal(ensureImportTag(repo, commit, 'v1.0.0'), true);
  assert.equal(git(repo, ['cat-file', '-t', 'upstream/v1.0.0']), 'tag');
  assert.equal(git(repo, ['rev-parse', 'upstream/v1.0.0^{commit}']), commit);
  assert.equal(ensureImportTag(repo, commit, 'v1.0.0'), false);
});

test('verifySeals flags a hand commit and a tree that does not match its seal', (t) => {
  const { repo, commit } = setupImported(t);
  const handCommit = git(repo, ['commit-tree', EMPTY_TREE, '-p', commit, '-m', 'hand edit']);
  const sealedMessage = git(repo, ['log', '-1', '--format=%B', commit]);
  const fakeSealCommit = git(repo, ['commit-tree', EMPTY_TREE, '-p', commit, '-m', sealedMessage]);
  assert.deepEqual(verifySeals(repo, handCommit).map((x) => x.reason), ['no-trailers']);
  assert.deepEqual(verifySeals(repo, handCommit).map((x) => x.commit), [handCommit]);
  assert.deepEqual(verifySeals(repo, fakeSealCommit).map((x) => x.reason), ['tree-mismatch']);
  assert.deepEqual(verifySeals(repo, 'upstream'), []);
});

test('fetchUpstreamTag follows a tag moved to unrelated history and reports a missing tag', (t) => {
  const { repo, origin } = setup(t);
  const first = fetchUpstreamTag(repo, 'v1.0.0', origin);
  const orphan = git(origin, ['commit-tree', EMPTY_TREE, '-m', 'rewritten history']);
  git(origin, ['tag', '-f', '-a', '-m', 'moved', 'v1.0.0', orphan]);
  assert.notEqual(fetchUpstreamTag(repo, 'v1.0.0', origin), first);
  assert.equal(git(repo, ['rev-parse', 'refs/obra/tags/v1.0.0^{commit}']), orphan);
  assert.throws(() => fetchUpstreamTag(repo, 'v9.9.9', origin), { code: 'no-such-tag' });
});

test('upstreamPluginName reads the manifest name of a tag', (t) => {
  const origin = makeOrigin(t, [
    { tag: 'v1.0.0' },
    { tag: 'v1.1.0', pluginName: 'other-plugin' },
    { tag: 'v1.2.0', files: { '.claude-plugin/plugin.json': 'not json' } },
  ]);
  const repo = tempDir(t);
  initRepo(repo);
  for (const tag of ['v1.0.0', 'v1.1.0', 'v1.2.0']) fetchUpstreamTag(repo, tag, origin);
  assert.equal(upstreamPluginName(repo, 'v1.0.0'), 'superpowers');
  assert.equal(upstreamPluginName(repo, 'v1.1.0'), 'other-plugin');
  assert.equal(upstreamPluginName(repo, 'v1.2.0'), null);
});

// A bare origin whose upstream branch holds one commit, made through the `src` repo.
function setupRemote(t) {
  const bare = tempDir(t);
  git(bare, ['init', '-q', '--bare', '-b', 'main']);
  const src = tempDir(t);
  initRepo(src);
  const first = plainCommit(src, null, 'a.txt');
  git(src, ['update-ref', 'refs/heads/main', first]);
  git(src, ['remote', 'add', 'origin', bare]);
  git(src, ['push', '-q', 'origin', 'main:refs/heads/main', 'main:refs/heads/upstream']);
  const clone = () => {
    const dir = path.join(tempDir(t), 'clone');
    git(path.dirname(dir), ['clone', '-q', bare, dir]);
    setIdentity(dir);
    return dir;
  };
  const pushAhead = (name) => {
    const next = plainCommit(src, git(src, ['rev-parse', 'main']), name);
    git(src, ['update-ref', 'refs/heads/main', next]);
    git(src, ['push', '-q', 'origin', 'main:refs/heads/upstream']);
    return next;
  };
  return { first, clone, pushAhead };
}

test('prepareUpstream: none, local, from-origin, behind, diverged', (t) => {
  const empty = tempDir(t);
  initRepo(empty);
  assert.equal(prepareUpstream(empty), 'none');
  assert.equal(upstreamRef(empty), null);
  git(empty, ['update-ref', 'refs/heads/upstream', plainCommit(empty, null, 'x.txt')]);
  assert.equal(upstreamRef(empty), 'upstream');
  assert.equal(prepareUpstream(empty), 'local');

  const { first, clone: makeClone, pushAhead } = setupRemote(t);
  const clone = makeClone();
  assert.equal(upstreamRef(clone), 'origin/upstream');
  assert.equal(prepareUpstream(clone), 'from-origin');
  assert.equal(upstreamRef(clone), 'upstream');
  assert.equal(git(clone, ['rev-parse', 'upstream']), first);
  assert.equal(git(clone, ['branch', '--show-current']), 'main');
  assert.equal(prepareUpstream(clone), 'local');

  const clone2 = makeClone();
  assert.equal(prepareUpstream(clone2), 'from-origin');
  const localAhead = plainCommit(clone2, first, 'local.txt');
  git(clone2, ['update-ref', 'refs/heads/upstream', localAhead]);
  assert.equal(prepareUpstream(clone2), 'local');

  pushAhead('b.txt');
  assert.throws(() => prepareUpstream(clone), { code: 'upstream-behind' });
  assert.throws(() => prepareUpstream(clone2), { code: 'upstream-diverged' });
});

test('checkIdentity reports missing local name and email', (t) => {
  const bareConfigRepo = tempDir(t);
  git(bareConfigRepo, ['init', '-q', '-b', 'main']);
  assert.equal(checkIdentity(bareConfigRepo).length, 2);
  const repo = tempDir(t);
  initRepo(repo);
  assert.deepEqual(checkIdentity(repo), []);
});

test('checkIdentity reports a wrong local name and email once each', (t) => {
  const repo = tempDir(t);
  initRepo(repo);
  git(repo, ['config', '--local', 'user.name', 'Someone Else']);
  git(repo, ['config', '--local', 'user.email', 'someone@example.invalid']);
  const problems = checkIdentity(repo);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /user\.name/);
  assert.match(problems[1], /user\.email/);
});

for (const [variable, field] of [
  ['GIT_AUTHOR_NAME', 'name'],
  ['GIT_COMMITTER_NAME', 'name'],
  ['GIT_AUTHOR_EMAIL', 'email'],
  ['GIT_COMMITTER_EMAIL', 'email'],
]) {
  test(`checkIdentity reports ${variable} overriding a correct local config`, (t) => {
    const repo = tempDir(t);
    initRepo(repo);
    const saved = process.env[variable];
    process.env[variable] = field === 'name' ? 'Someone Else' : 'someone@example.invalid';
    t.after(() => {
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    });
    const problems = checkIdentity(repo);
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(variable));
    assert.match(problems[0], field === 'name' ? /Someone Else/ : /someone@example\.invalid/);
  });
}
