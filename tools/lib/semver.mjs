import { ToolError } from './errors.mjs';

const UPSTREAM_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_RE = /^v?(\d+)\.(\d+)\.(\d+)-cc\.([1-9]\d*)$/;

export function parseUpstreamTag(tag) {
  const m = UPSTREAM_RE.exec(tag);
  if (!m) throw new ToolError('bad-tag', `not a vX.Y.Z upstream tag: ${tag}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function parseRelease(v) {
  const m = RELEASE_RE.exec(v);
  if (!m) throw new ToolError('bad-version', `not an X.Y.Z-cc.N release number: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), cc: Number(m[4]) };
}

function compareFields(a, b, fields) {
  for (const f of fields) {
    if (a[f] !== b[f]) return a[f] < b[f] ? -1 : 1;
  }
  return 0;
}

export function compareUpstream(a, b) {
  return compareFields(parseUpstreamTag(a), parseUpstreamTag(b), ['major', 'minor', 'patch']);
}

export function compareRelease(a, b) {
  return compareFields(parseRelease(a), parseRelease(b), ['major', 'minor', 'patch', 'cc']);
}

// base: "X.Y.Z"; last: latest release number or null.
export function nextReleaseVersion(base, last) {
  if (!/^\d+\.\d+\.\d+$/.test(base))
    throw new ToolError('bad-version', `not an X.Y.Z base version: ${base}`);
  let cc = 1;
  if (last !== null) {
    const p = parseRelease(last);
    if (`${p.major}.${p.minor}.${p.patch}` === base) cc = p.cc + 1;
  }
  return `${base}-cc.${cc}`;
}
