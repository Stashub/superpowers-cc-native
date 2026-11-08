import { spawnSync } from 'node:child_process';
import { ToolError } from './errors.mjs';

// run(cwd, args, { input, env }): { status, stdout, stderr }. Never throws on a git failure.
// stdout is a Buffer, stderr a string. LC_ALL=C keeps git messages parseable; prompts are off.
export function run(cwd, args, { input, env } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    input,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 1 << 30,
  });
  if (res.error) throw new ToolError('git', `git ${args.join(' ')}: ${res.error.message}`);
  return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr.toString('utf8') };
}

// git(cwd, args, opts): stdout as UTF-8 without one trailing newline. Throws ToolError('git').
export function git(cwd, args, opts) {
  const res = run(cwd, args, opts);
  if (res.status !== 0) {
    throw new ToolError('git', `git ${args.join(' ')}: ${res.stderr.trim()}`);
  }
  const out = res.stdout.toString('utf8');
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

// repoRoot(cwd): absolute path of the working tree root.
export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}
