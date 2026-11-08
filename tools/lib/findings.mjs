// Finding = { level: 'ok' | 'info' | 'warn' | 'fail', code: string, text: string }
// Shared by checks.mjs, validate.mjs and original-tests.mjs.

export const finding = (level, code, text) => ({ level, code, text });

// The last `lines` lines of `text` without trailing whitespace (20 by default).
export function tail(text, lines = 20) {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}
