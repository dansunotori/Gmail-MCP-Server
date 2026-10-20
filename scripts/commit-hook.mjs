// What the project's Claude Code PreToolUse hooks on git commits share (.claude/settings.json):
// which repository a Bash command commits into, read from its text, and the deny they answer
// with. Each hook checks that repository and denies the commit while its check fails.
import { execFileSync } from 'child_process';
import fs from 'fs';

// Characters that make the shell, not git, decide what a command means: operators, subshells,
// redirection, expansions ($, `, ~, globs, braces), escapes, comments and line breaks.
const SHELL_SPECIAL = new Set([...';&|()<>$`\\~*?[]{}!#\n\r']);

// The words of a command line that is one plain command, or null for anything the shell would
// read differently from its text. Single quotes hold anything; double quotes hold anything but
// $, ` and \, which expand or escape inside them.
function plainWords(command) {
  const words = [];
  let word = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === ' ' || char === '\t') {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      if (end === -1) return null;
      const quoted = command.slice(index + 1, end);
      if (char === '"' && /[$`\\]/.test(quoted)) return null;
      word = (word ?? '') + quoted;
      index = end;
    } else if (SHELL_SPECIAL.has(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

// git's global options that leave the repository a command acts on unchanged. -C moves it and
// is followed; -c and --config-env set configuration only. Any other option (--git-dir,
// --work-tree, --bare, …) is not interpreted.
const NEUTRAL_OPTIONS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs',
]);

// What a Bash command does as far as the commit hooks go: { commit: [-C dirs, in order] } for a
// git commit, 'refuse' for a command that mentions commit in a form not read here, or null.
// The hooks guard against a failing check slipping into a commit, not against a command built
// to evade them, so a command that never names `commit` (an alias, an encoded word) is let
// through; this project's shell rules reject operators and expansions before they run anyway.
function commitTarget(command) {
  const mentionsCommit = command.includes('commit');
  const refuse = mentionsCommit ? 'refuse' : null;
  const words = plainWords(command);
  if (words === null || words[0] !== 'git') return refuse;
  const dirs = [];
  let index = 1;
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index];
    if (option === '-C' || option === '-c') {
      if (index + 1 >= words.length) return null;
      if (option === '-C') dirs.push(words[index + 1]);
      index += 2;
    } else if (NEUTRAL_OPTIONS.has(option) || option.startsWith('--config-env=')) {
      index += 1;
    } else {
      return refuse;
    }
  }
  return words[index] === 'commit' ? { commit: dirs } : null;
}

// The root of the work tree a git command with these -C options acts on, from the session's
// directory, as git itself resolves them (symlinks included); null when git finds none, in
// which case the commit fails in git too.
function workTreeRoot(cwd, dirs) {
  try {
    const args = [...dirs.flatMap(dir => ['-C', dir]), 'rev-parse', '--show-toplevel'];
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    if (typeof error?.status === 'number' || error?.code === 'ENOENT') return null;
    throw error;
  }
}

// The hook input on stdin: { root } for a git commit into the work tree at root, 'refuse' for a
// commit whose target repository cannot be read from the command's text, which a hook refuses
// rather than guesses at, or null for anything else.
export function readCommit() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const target = commitTarget(payload.tool_input?.command ?? '');
  if (target === null || target === 'refuse') return target;
  const root = workTreeRoot(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), target.commit);
  return root === null ? null : { root };
}

// The deny for a commit 'refuse' stands for, naming what the hook checks.
export const unreadableCommit = checked => `This command cannot be checked against ${checked}: run the commit as a single plain git command, ` +
  'git [-c name=value] [-C dir] commit ..., without shell operators, variables, ~, globs, backslashes ' +
  'or other git options, so the hook can tell which repository it records into.';

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}
