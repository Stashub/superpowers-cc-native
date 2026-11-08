// `claude plugin validate --json` as findings (spec 7.3).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { finding, tail } from './findings.mjs';

// The one warning we accept: the version lives in the marketplace entry, not in plugin.json.
const isAllowed = (w) =>
  typeof w?.message === 'string' && w.message.startsWith('No version specified') &&
  typeof w?.path === 'string' && w.path.endsWith('version');

const describe = (kind, file, item) => {
  const where = [file, item?.path].filter(Boolean).join(' ');
  return `${kind}${where ? ` in ${where}` : ''}: ${item?.message ?? JSON.stringify(item)}`;
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A failure is any error and any warning in `manifest` and `contents`, except the one above.
// `advice` and `directory` are ignored. One ok finding if nothing fails. This is a gate, so a
// shape we do not know must not pass: a report that is not an object, has no `manifest`
// object, has a `contents` that is neither absent nor an array of objects, has `errors` or
// `warnings` (when present) that are not arrays, or says success: false without any finding
// of ours, is a failure. `contents` may be absent or empty.
export function filterValidateReport(report) {
  const bad = (text) => [finding('fail', 'validate', `unexpected report: ${text}`)];
  if (!isObject(report) || !isObject(report.manifest)) return bad('it is not an object with a "manifest" object');
  const { contents = [] } = report;
  if (!Array.isArray(contents) || !contents.every(isObject)) return bad('"contents" is not an array of objects');

  const findings = [];
  const scan = (where, entry) => {
    for (const key of ['errors', 'warnings']) {
      if (entry[key] !== undefined && !Array.isArray(entry[key])) return `"${key}" of ${where} is not an array`;
    }
    for (const e of entry.errors ?? []) findings.push(finding('fail', 'validate', describe('error', entry.file, e)));
    for (const w of entry.warnings ?? []) {
      if (!isAllowed(w)) findings.push(finding('fail', 'validate', describe('warning', entry.file, w)));
    }
    return null;
  };
  const problem = [scan('manifest', report.manifest), ...contents.map((c, i) => scan(`contents[${i}]`, c))]
    .find((p) => p !== null);
  if (problem) return bad(problem);
  if (findings.length === 0 && report.success === false)
    return [finding('fail', 'validate', 'the report says success: false, but lists no error or warning we count')];
  if (findings.length === 0) findings.push(finding('ok', 'validate', 'no errors or warnings'));
  return findings;
}

// Runs `claude plugin validate <target> --json` in `root`. `missing` is the level of the
// finding when the claude binary does not exist: 'warn' or 'fail'.
export function runValidate(root, target, { claudeBin = 'claude', missing = 'warn' } = {}) {
  const label = `claude plugin validate ${target}`;
  const res = spawnSync(claudeBin, ['plugin', 'validate', target, '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120_000,
  });
  // spawn also reports ENOENT when the working directory does not exist.
  if (res.error?.code === 'ENOENT' && !existsSync(root))
    return [finding('fail', 'validate', `${label}: the directory ${root} does not exist`)];
  if (res.error?.code === 'ENOENT')
    return [finding(missing, 'validate', `${label}: claude (${claudeBin}) was not found, validation skipped`)];
  if (res.error)
    return [finding('fail', 'validate', `${label}: could not run: ${res.error.message}`)];
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    const out = tail(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    return [finding('fail', 'validate', `${label}: output is not JSON (exit ${res.status}):\n${out}`)];
  }
  return filterValidateReport(report).map((f) => ({ ...f, text: `${target}: ${f.text}` }));
}
