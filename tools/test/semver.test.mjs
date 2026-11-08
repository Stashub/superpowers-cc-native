import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpstreamTag, parseRelease, compareUpstream, compareRelease, nextReleaseVersion }
  from '../lib/semver.mjs';

test('parses only vX.Y.Z upstream tags', () => {
  assert.deepEqual(parseUpstreamTag('v7.0.2'), { major: 7, minor: 0, patch: 2 });
  for (const t of ['7.0.2', 'v7.1.0-rc.1', 'v7.0', 'release-1'])
    assert.throws(() => parseUpstreamTag(t), { code: 'bad-tag' });
});
test('compares upstream tags numerically', () => {
  assert.ok(compareUpstream('v6.4.10', 'v6.4.2') > 0);
  assert.equal(compareUpstream('v7.0.2', 'v7.0.2'), 0);
  assert.ok(compareUpstream('v6.4.2', 'v7.0.0') < 0);
  assert.throws(() => compareUpstream('v7.0.2', 'v7.0.3-rc.1'), { code: 'bad-tag' });
});
test('parses and compares release numbers', () => {
  assert.deepEqual(parseRelease('v7.0.2-cc.12'), { major: 7, minor: 0, patch: 2, cc: 12 });
  assert.deepEqual(parseRelease('7.0.2-cc.1'), { major: 7, minor: 0, patch: 2, cc: 1 });
  for (const v of ['7.0.2-cc.0', '7.0.2+cc.1', '7.0.2'])
    assert.throws(() => parseRelease(v), { code: 'bad-version' });
  assert.ok(compareRelease('7.0.3-cc.1', '7.0.2-cc.9') > 0);
  assert.ok(compareRelease('7.0.2-cc.10', '7.0.2-cc.9') > 0);
  assert.equal(compareRelease('v7.0.2-cc.1', '7.0.2-cc.1'), 0);
});
test('computes the next release number', () => {
  assert.equal(nextReleaseVersion('7.0.2', null), '7.0.2-cc.1');
  assert.equal(nextReleaseVersion('7.0.2', '7.0.2-cc.1'), '7.0.2-cc.2');
  assert.equal(nextReleaseVersion('7.0.3', '7.0.2-cc.5'), '7.0.3-cc.1');
});
