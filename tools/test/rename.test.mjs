import test from 'node:test';
import assert from 'node:assert/strict';
import { renameBuffer, countOldRefs, isText, OLD_REF_SOURCE } from '../lib/rename.mjs';

const r = (s) => renameBuffer(Buffer.from(s, 'latin1')).buf.toString('latin1');

test('renames skill, command and agent refs', () => {
  assert.equal(r('use superpowers:brainstorming'), 'use superpowers-cc-native:brainstorming');
  assert.equal(r('`/superpowers:brainstorm`'), '`/superpowers-cc-native:brainstorm`');
  assert.equal(renameBuffer(Buffer.from('superpowers:a superpowers:b')).count, 2);
});
test('keeps non-refs', () => {
  for (const s of ['foo-superpowers:x', 'my_superpowers:x', 'superpowers: x', 'superpowers:X',
                   '"name": "superpowers"', 'superpowers@superpowers-marketplace'])
    assert.equal(r(s), s);
});
test('is idempotent', () => { const once = r('superpowers:tdd'); assert.equal(r(once), once); });
test('is byte exact outside matches', () => {
  const pre = Buffer.from([0xe9, 0x0d, 0x0a]), post = Buffer.from([0xff]);
  const out = renameBuffer(Buffer.concat([pre, Buffer.from('superpowers:a'), post])).buf;
  assert.deepEqual(out, Buffer.concat([pre, Buffer.from('superpowers-cc-native:a'), post]));
});
test('isText is false only with a NUL byte', () => {
  assert.equal(isText(Buffer.from([0x61, 0x00])), false);
  assert.equal(isText(Buffer.from([0xff, 0xfe, 0x41])), true);
});
test('countOldRefs counts without changing', () => {
  assert.equal(countOldRefs(Buffer.from('superpowers:a foo-superpowers:b')), 1);
});
test('repeated calls are independent of regex state', () => {
  const buf = Buffer.from('superpowers:a superpowers:b');
  assert.equal(countOldRefs(buf), 2);
  assert.equal(countOldRefs(buf), 2);
  assert.equal(renameBuffer(buf).count, 2);
  assert.equal(OLD_REF_SOURCE, '(?<![\\w-])superpowers:(?=[a-z])');
});
