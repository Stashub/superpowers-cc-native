// Static checks of the repository (spec 7.1, items 1-4 and 7).
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_NAME, VERSION_RE } from './constants.mjs';
import { finding } from './findings.mjs';
import { run } from './git.mjs';
import { countOldRefs, isText } from './rename.mjs';

const PLUGIN_DIR = 'plugin';
const PLUGIN_JSON = 'plugin/.claude-plugin/plugin.json';
const PLUGIN_MARKETPLACE = 'plugin/.claude-plugin/marketplace.json';
const ROOT_MARKETPLACE = '.claude-plugin/marketplace.json';

const lstatOrNull = (file) => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};

// Reads and parses a JSON file. { value } or { error: <short reason> }.
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'file is missing' : `cannot be read (${err.code ?? err.message})` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'is not valid JSON' };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

// Regular files below `dir` as paths relative to `root`, with "/" separators. Symlinks are not
// followed (and not listed): they are not files of ours to rename.
function* walkFiles(root, rel) {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* walkFiles(root, child);
    else if (entry.isFile()) yield child;
  }
}

// Spec 7.1 items 1-3. Old `superpowers:` references in plugin/, plugin.json, no plugin marketplace.
export function checkPlugin(root) {
  const findings = [];

  let scanned = 0;
  let bad = 0;
  if (lstatOrNull(path.join(root, PLUGIN_DIR))?.isDirectory()) {
    for (const rel of walkFiles(root, PLUGIN_DIR)) {
      const buf = readFileSync(path.join(root, rel));
      if (!isText(buf)) continue;
      scanned += 1;
      const count = countOldRefs(buf);
      if (count > 0) {
        bad += 1;
        findings.push(finding('fail', 'old-refs', `${rel}: ${count} old "superpowers:" reference(s); rename them to "${PLUGIN_NAME}:"`));
      }
    }
  }
  if (bad === 0) findings.push(finding('ok', 'old-refs', `no old "superpowers:" references in ${scanned} text files of ${PLUGIN_DIR}/`));

  const manifest = readJson(path.join(root, PLUGIN_JSON));
  if (manifest.error !== undefined) {
    findings.push(finding('fail', 'plugin-name', `${PLUGIN_JSON} ${manifest.error}`));
  } else if (!isObject(manifest.value)) {
    findings.push(finding('fail', 'plugin-name', `${PLUGIN_JSON} is not a JSON object`));
  } else {
    const { name } = manifest.value;
    findings.push(name === PLUGIN_NAME
      ? finding('ok', 'plugin-name', `${PLUGIN_JSON} name is ${PLUGIN_NAME}`)
      : finding('fail', 'plugin-name', `${PLUGIN_JSON} name is ${JSON.stringify(name)}, expected "${PLUGIN_NAME}"`));
    findings.push(Object.hasOwn(manifest.value, 'version')
      ? finding('fail', 'plugin-version', `${PLUGIN_JSON} has a "version" field; the version lives only in ${ROOT_MARKETPLACE}`)
      : finding('ok', 'plugin-version', `${PLUGIN_JSON} has no version`));
  }

  findings.push(lstatOrNull(path.join(root, PLUGIN_MARKETPLACE)) === null
    ? finding('ok', 'plugin-marketplace', `${PLUGIN_MARKETPLACE} is absent`)
    : finding('fail', 'plugin-marketplace', `${PLUGIN_MARKETPLACE} must not exist`));
  return findings;
}

// Spec 7.1 item 4. { findings, version }: version is the `version` string of the single plugin
// entry when there is one (valid or not), else null.
export function checkRootMarketplace(root) {
  const fail = (text) => finding('fail', 'marketplace', `${ROOT_MARKETPLACE}: ${text}`);
  const doc = readJson(path.join(root, ROOT_MARKETPLACE));
  if (doc.error !== undefined) return { findings: [fail(doc.error)], version: null };
  const m = doc.value;
  if (!isObject(m)) return { findings: [fail('is not a JSON object')], version: null };

  const findings = [];
  if (!isNonEmptyString(m.name)) findings.push(fail('"name" is missing'));
  if (!isNonEmptyString(m.owner?.name)) findings.push(fail('"owner.name" is missing'));
  if (!isNonEmptyString(m.description)) findings.push(fail('"description" is missing'));

  let version = null;
  if (!Array.isArray(m.plugins) || m.plugins.length !== 1) {
    findings.push(fail(`it must list exactly one plugin, found ${Array.isArray(m.plugins) ? m.plugins.length : 'no "plugins" array'}`));
  } else {
    const [plugin] = m.plugins;
    if (plugin?.name !== PLUGIN_NAME) findings.push(fail(`plugin name is ${JSON.stringify(plugin?.name)}, expected "${PLUGIN_NAME}"`));
    if (plugin?.source !== './plugin') findings.push(fail(`plugin source is ${JSON.stringify(plugin?.source)}, expected "./plugin"`));
    if (typeof plugin?.version !== 'string') {
      findings.push(fail('plugin "version" is missing'));
    } else {
      version = plugin.version;
      if (!VERSION_RE.test(version)) findings.push(fail(`version '${version}' does not match ${VERSION_RE}`));
    }
  }
  if (findings.length === 0) findings.push(finding('ok', 'marketplace', `${ROOT_MARKETPLACE} is valid (version ${version})`));
  return { findings, version };
}

// Spec 7.1 item 7. For information only: how many lines of ours the files of the original carry,
// `git diff --numstat <upstream> HEAD -- plugin/`. `upstream` is a ref name, or null if none.
export function ourLines(root, upstream) {
  const info = (text) => finding('info', 'our-lines', text);
  if (upstream === null) return info('no upstream branch, our lines are not counted');
  const res = run(root, ['diff', '--numstat', upstream, 'HEAD', '--', `${PLUGIN_DIR}/`]);
  if (res.status !== 0) return info(`git diff against ${upstream} failed: ${res.stderr.trim()}`);
  const rows = res.stdout.toString('utf8').split('\n').filter(Boolean);
  if (rows.length === 0) return info(`no lines of ours in ${PLUGIN_DIR}/ against ${upstream}`);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    const [a, r] = row.split('\t');
    added += Number(a) || 0; // binary files show "-"
    removed += Number(r) || 0;
  }
  return info(`${rows.length} file(s) in ${PLUGIN_DIR}/ differ from ${upstream}: +${added} -${removed} lines`);
}
