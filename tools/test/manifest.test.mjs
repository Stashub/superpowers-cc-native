import test from 'node:test';
import assert from 'node:assert/strict';
import { transformPluginJson } from '../lib/manifest.mjs';

// Real .claude-plugin/plugin.json of obra/superpowers v7.0.2, author email replaced.
const INPUT_702 = `
{
  "name": "superpowers",
  "description": "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
  "version": "7.0.2",
  "author": {
    "name": "Jesse Vincent",
    "email": "jesse@example.invalid"
  },
  "homepage": "https://github.com/obra/superpowers",
  "repository": "https://github.com/obra/superpowers",
  "license": "MIT",
  "keywords": [
    "skills",
    "tdd",
    "debugging",
    "collaboration",
    "best-practices",
    "workflows"
  ]
}
`.trimStart();

// Spec 6.4 result block for 7.0.2, plus a trailing newline.
const EXPECTED_702 = `{
  "name": "superpowers-cc-native",
  "description": "Claude Code native fork of obra/superpowers. Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
  "author": {
    "name": "Stashub",
    "url": "https://github.com/Stashub"
  },
  "homepage": "https://github.com/Stashub/superpowers-cc-native",
  "repository": "https://github.com/Stashub/superpowers-cc-native",
  "license": "MIT",
  "keywords": [
    "skills",
    "tdd",
    "debugging",
    "collaboration",
    "best-practices",
    "workflows"
  ]
}
`;

test('transforms the 7.0.2 manifest exactly', () => {
  assert.equal(transformPluginJson(INPUT_702), EXPECTED_702);
});
test('keeps unknown fields in place and drops only version', () => {
  const out = JSON.parse(transformPluginJson(JSON.stringify({ name: 'superpowers', version: '1.0.0',
    description: 'd', foo: 1, author: { name: 'x' }, homepage: 'h', repository: 'r', keywords: [] })));
  assert.deepEqual(Object.keys(out), ['name', 'description', 'foo', 'author', 'homepage', 'repository', 'keywords']);
  assert.equal(out.foo, 1);
  assert.equal(out.description, 'Claude Code native fork of obra/superpowers. d');
});
test('appends missing replaced fields in table order', () => {
  const out = JSON.parse(transformPluginJson('{"name":"superpowers","description":"d"}'));
  assert.deepEqual(Object.keys(out), ['name', 'description', 'author', 'homepage', 'repository']);
});
test('rejects invalid JSON', () => { assert.throws(() => transformPluginJson('{')); });
test('rejects JSON that is not an object', () => {
  assert.throws(() => transformPluginJson('[]'), { code: 'bad-manifest' });
  assert.throws(() => transformPluginJson('null'), { code: 'bad-manifest' });
});
