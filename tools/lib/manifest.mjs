import { PLUGIN_NAME, OWNER, REPO_URL, DESCRIPTION_PREFIX } from './constants.mjs';
import { ToolError } from './errors.mjs';

export function transformPluginJson(text) {
  const src = JSON.parse(text);
  if (src === null || typeof src !== 'object' || Array.isArray(src))
    throw new ToolError('bad-manifest', 'plugin.json must contain a JSON object');

  // Table order of spec 6.4; also the order for appending missing fields.
  const replaced = {
    name: PLUGIN_NAME,
    description: DESCRIPTION_PREFIX + (src.description ?? ''),
    author: { ...OWNER },
    homepage: REPO_URL,
    repository: REPO_URL,
  };

  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'version') continue;
    out[key] = Object.hasOwn(replaced, key) ? replaced[key] : value;
  }
  for (const [key, value] of Object.entries(replaced)) {
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return JSON.stringify(out, null, 2) + '\n';
}
