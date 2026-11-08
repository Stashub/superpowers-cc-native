// `claude plugin validate --json` as findings (spec 7.3).
import { spawnSync } from 'node:child_process';
import { finding, tail } from './findings.mjs';

// The one warning we accept: the version lives in the marketplace entry, not in plugin.json.
const isAllowed = (w) =>
  typeof w?.message === 'string' && w.message.startsWith('No version specified') &&
  typeof w?.path === 'string' && w.path.endsWith('version');

const describe = (kind, file, item) => {
  const where = [file, item?.path].filter(Boolean).join(' ');
  return `${kind}${where ? ` in ${where}` : ''}: ${item?.message ?? JSON.stringify(item)}`;
};

// A failure is any error and any warning in `manifest` and `contents`, except the one above.
// `advice` and `directory` are ignored. One ok finding if nothing fails.
export function filterValidateReport(report) {
  const findings = [];
  const scan = (file, errors, warnings) => {
    for (const e of errors ?? []) findings.push(finding('fail', 'validate', describe('error', file, e)));
    for (const w of warnings ?? []) {
      if (!isAllowed(w)) findings.push(finding('fail', 'validate', describe('warning', file, w)));
    }
  };
  scan(report?.manifest?.file, report?.manifest?.errors, report?.manifest?.warnings);
  for (const c of report?.contents ?? []) scan(c?.file, c?.errors, c?.warnings);
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
