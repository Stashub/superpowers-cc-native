// Test helpers shared by tools/test/*.test.mjs. Tests only, never imported by tools/.
//
// Importing this module makes git hermetic for the whole test process (and for the child
// processes it spawns): no global or system config, and no identity from the environment.
import os from 'node:os';
import path from 'node:path';
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { git } from '../lib/git.mjs';
import { IDENTITY } from '../lib/constants.mjs';

process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
  delete process.env[name];

// tempDir(t): string. A fresh empty directory, removed in t.after.
export function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scn-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// setIdentity(dir): void. Writes IDENTITY into the repository's local config.
export function setIdentity(dir) {
  git(dir, ['config', '--local', 'user.name', IDENTITY.name]);
  git(dir, ['config', '--local', 'user.email', IDENTITY.email]);
}

// initRepo(dir): void. `git init` on branch main with IDENTITY in the local config.
export function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  setIdentity(dir);
}

// writeFiles(dir, files): void. files maps a relative path to one of:
//   string | Buffer          regular file (mode 644)
//   { exec: string }         regular file with the executable bit
//   { symlink: string }      symlink to the given target
// An existing path is replaced, never written through.
export function writeFiles(dir, files) {
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    rmSync(file, { recursive: true, force: true });
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      writeFileSync(file, value);
    } else if (value && typeof value.symlink === 'string') {
      symlinkSync(value.symlink, file);
    } else if (value && typeof value.exec === 'string') {
      writeFileSync(file, value.exec);
      chmodSync(file, 0o755);
    } else {
      throw new TypeError(`writeFiles: unsupported value for ${rel}`);
    }
  }
}

// commitAll(dir, msg): string. `git add -A` plus a commit; returns the new commit sha.
export function commitAll(dir, msg) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);

function baseOriginFiles(tag, pluginName) {
  const pluginJson = {
    name: pluginName,
    description: 'Core skills library for Claude Code',
    version: tag.replace(/^v/, ''),
    author: { name: 'Jesse Vincent', email: 'jesse@example.invalid' },
    homepage: 'https://github.com/obra/superpowers',
    repository: 'https://github.com/obra/superpowers',
    license: 'MIT',
  };
  const marketplaceJson = {
    name: 'superpowers-dev',
    owner: { name: 'Jesse Vincent' },
    plugins: [{ name: pluginName, source: './' }],
  };
  return {
    '.claude-plugin/plugin.json': JSON.stringify(pluginJson, null, 2) + '\n',
    '.claude-plugin/marketplace.json': JSON.stringify(marketplaceJson, null, 2) + '\n',
    'skills/demo/SKILL.md': 'Use superpowers:demo first.\n',
    'assets/logo.png': PNG_BYTES,
    'scripts/run.sh': { exec: '#!/bin/sh\necho demo\n' },
    link: { symlink: 'README.md' },
    'README.md': '# Superpowers\n',
  };
}

// makeOrigin(t, releases): string. A fake obra/superpowers repository (a path usable as the
// `from` of fetchUpstreamTag). releases: Array<{ tag, files?, pluginName? }>. Each release is
// one new commit on top of the previous one plus an annotated tag `tag`. The tree of a release
// is exactly the base files (see below) overridden or extended by `files` (same value kinds as
// writeFiles); nothing carries over from the previous release. `pluginName` replaces the
// `name` in .claude-plugin/plugin.json (default 'superpowers').
// Base files: .claude-plugin/plugin.json (version = tag without "v"),
// .claude-plugin/marketplace.json, skills/demo/SKILL.md ("Use superpowers:demo first.\n"),
// assets/logo.png (contains 0x00), scripts/run.sh (exec), link (symlink to README.md), README.md.
export function makeOrigin(t, releases) {
  const dir = tempDir(t);
  initRepo(dir);
  for (const { tag, files = {}, pluginName = 'superpowers' } of releases) {
    for (const entry of readdirSync(dir)) {
      if (entry !== '.git') rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
    writeFiles(dir, { ...baseOriginFiles(tag, pluginName), ...files });
    commitAll(dir, `Release ${tag}`);
    git(dir, ['tag', '-a', '-m', `Release ${tag}`, tag]);
  }
  return dir;
}

// seedMain(dir): void. Commits the minimal root files of main in an initRepo()'d directory:
// .gitignore, .gitattributes, README.md, CHANGELOG.md and .claude-plugin/marketplace.json
// (plugin version 1.0.0-cc.1, which matches makeOrigin's v1.0.0).
export function seedMain(dir) {
  const marketplace = {
    name: 'superpowers-cc-native',
    owner: { name: 'Stashub', url: 'https://github.com/Stashub' },
    description: 'Claude Code native fork of obra/superpowers',
    plugins: [{ name: 'superpowers-cc-native', source: './plugin', version: '1.0.0-cc.1' }],
  };
  writeFiles(dir, {
    '.gitignore': '.superpowers/\n',
    '.gitattributes': [
      '/.gitattributes text eol=lf',
      '/.gitignore text eol=lf',
      '/LICENSE text eol=lf',
      '/*.md text eol=lf',
      '/.claude-plugin/** text eol=lf',
      '/tools/** text eol=lf',
      '/docs/** text eol=lf',
      '',
    ].join('\n'),
    'README.md': '# superpowers-cc-native\n',
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n',
    '.claude-plugin/marketplace.json': JSON.stringify(marketplace, null, 2) + '\n',
  });
  commitAll(dir, 'chore: seed main');
}
