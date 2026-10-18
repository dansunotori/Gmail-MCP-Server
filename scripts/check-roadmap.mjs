#!/usr/bin/env node
// Refuses text reporting finished work in ROADMAP.md, which holds open items only (CLAUDE.md:
// no changelogs, history or reports in the repository). A word list over the file's prose;
// code blocks and inline code spans are not checked.
//
//   node scripts/check-roadmap.mjs [file]   check the file (default ROADMAP.md); exit 1 on a finding
//   node scripts/check-roadmap.mjs --hook   Claude Code PreToolUse hook: reads the Write/Edit
//                                           payload on stdin and denies a change to ROADMAP.md
//                                           whose result fails
//   node scripts/check-roadmap.mjs --staged check the ROADMAP.md staged for commit, for a git
//                                           pre-commit hook; exit 1 on a finding
//   node scripts/check-roadmap.mjs --commit-hook  Claude Code PreToolUse hook on Bash: denies a
//                                           git commit while its repository's staged or working
//                                           ROADMAP.md fails
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromMarkdown } from 'mdast-util-from-markdown';

const ROADMAP = 'ROADMAP.md';

const PATTERNS = [
  /\bfixed\b/gi,
  /\bshipped\b/gi,
  /\blanded\b/gi,
  /\bmerged\b/gi,
  /\bresolved\b/gi,
  /(?<!\bnot (?:yet )?)\bimplemented\b/gi,
  /(?<!\bfor )\bnow\b/gi,
  /\bno longer\b/gi,
  /\bpreviously\b/gi,
  /\[[xX]\]/g,
  /~~[^~]+~~/g,
  // Status markers, matched in capitals only: lower-case "done when" and "complete the flow"
  // describe open work.
  /\*\*Done:\*\*/g,
  /✅/g,
  /\b(?:COMPLETE|DONE|MITIGATED|RESOLVED)\b/g,
];

// Blocks whose source is prose: their raw text, emphasis and bracket markers included, is what
// the patterns read, with every inline code span inside blanked. Code blocks are never read.
const PROSE_BLOCKS = new Set(['paragraph', 'heading', 'html']);

function codeSpans(node, spans = []) {
  if (node.type === 'inlineCode') spans.push(node.position);
  for (const child of node.children ?? []) codeSpans(child, spans);
  return spans;
}

function proseBlocks(node, blocks = []) {
  if (PROSE_BLOCKS.has(node.type)) {
    blocks.push(node);
    return blocks;
  }
  for (const child of node.children ?? []) proseBlocks(child, blocks);
  return blocks;
}

// The markdown is parsed as CommonMark (mdast-util-from-markdown), so fences of any length,
// in block quotes and list items, CRLF line endings and code spans across line breaks are
// read as the spec reads them.
export function findCompletionLanguage(markdown) {
  const lineStarts = [0];
  for (let index = markdown.indexOf('\n'); index !== -1; index = markdown.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineOf = offset => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
    return line + 1;
  };
  const found = [];
  for (const block of proseBlocks(fromMarkdown(markdown))) {
    const start = block.position.start.offset;
    let prose = markdown.slice(start, block.position.end.offset);
    for (const span of codeSpans(block)) {
      const from = span.start.offset - start;
      const to = span.end.offset - start;
      prose = prose.slice(0, from) + prose.slice(from, to).replace(/[^\r\n]/g, ' ') + prose.slice(to);
    }
    for (const pattern of PATTERNS) {
      for (const match of prose.matchAll(pattern)) found.push({ offset: start + match.index, phrase: match[0] });
    }
  }
  return found.sort((a, b) => a.offset - b.offset).map(({ offset, phrase }) => ({ line: lineOf(offset), phrase }));
}

function replace(content, oldString, newString, replaceAll) {
  if (!content.includes(oldString)) return null;
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
}

// The file as the Write or Edit would leave it, or null when the edit does not apply.
export function applyToolEdit(current, toolName, toolInput) {
  if (toolName === 'Write') return toolInput.content;
  if (toolName === 'Edit') return replace(current, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
  return null;
}

const format = (label, findings) => findings.map(({ line, phrase }) => `${label}:${line}: "${phrase}"`).join('\n');

function runHook() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const project = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  const target = path.resolve(payload.cwd || project, payload.tool_input?.file_path ?? '');
  const roadmap = path.join(project, ROADMAP);
  if (target !== roadmap) return;
  const current = fs.existsSync(roadmap) ? fs.readFileSync(roadmap, 'utf8') : '';
  const result = applyToolEdit(current, payload.tool_name, payload.tool_input);
  if (result === null) return;
  const findings = findCompletionLanguage(result);
  if (findings.length === 0) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${ROADMAP} lists open work only; reword these to describe what remains to do:\n${format(ROADMAP, findings)}`,
    },
  }));
}

// The ROADMAP.md the commit will record, from git's index, or null when none is staged. Run
// from a pre-commit hook, git's own environment names the repository. Both queries name the
// file at the repository root from any directory inside it (`:(top)` and `:<path>` are
// root-relative). A git failure throws.
function stagedRoadmap(cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['ls-files', '--stage', '--', `:(top)${ROADMAP}`]) === '') return null;
  return git(['show', `:${ROADMAP}`]);
}

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

// What a Bash command does as far as the commit hook goes: { commit: [-C dirs, in order] } for a
// git commit, 'refuse' for a command that mentions commit in a form not read here, or null.
// The hook guards against finished-work wording slipping into a commit, not against a command
// built to evade it, so a command that never names `commit` (an alias, an encoded word) is let
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

// One copy of the roadmap checked: its findings formatted for the deny, or a line saying it
// could not be read, so one unreadable copy does not hide the findings of the other.
function checkCopy(label, read) {
  let markdown;
  try {
    markdown = read();
  } catch (error) {
    return `${label}: cannot be read: ${error.message}`;
  }
  const findings = markdown === null ? [] : findCompletionLanguage(markdown);
  return findings.length === 0 ? null : format(label, findings);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// Claude Code PreToolUse hook on Bash (configured for git commands only): a git commit is
// denied while its repository's ROADMAP.md reports finished work. Both the staged copy and the
// working copy are checked, since `commit -a` and a pathspec commit record the working copy;
// which one a given command records is not predicted from its flags. A commit in a command whose
// target repository cannot be read from its text is refused rather than guessed at.
function runCommitHook() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const target = commitTarget(payload.tool_input?.command ?? '');
  if (target === null) return;
  if (target === 'refuse') {
    deny(`This command cannot be checked against ${ROADMAP}: run the commit as a single plain git command, ` +
      'git [-c name=value] [-C dir] commit ..., without shell operators, variables, ~, globs, backslashes ' +
      'or other git options, so the hook can tell which repository it records into.');
    return;
  }
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = workTreeRoot(cwd, target.commit);
  if (root === null) return;
  const working = path.join(root, ROADMAP);
  const reports = [
    checkCopy(`${ROADMAP} (staged)`, () => stagedRoadmap(root)),
    checkCopy(`${ROADMAP} (working copy)`, () => (fs.existsSync(working) ? fs.readFileSync(working, 'utf8') : null)),
  ].filter(report => report !== null);
  if (reports.length === 0) return;
  deny(`${ROADMAP} lists open work only; reword these, stage the file again and commit:\n${reports.join('\n')}`);
}

function main(args) {
  if (args[0] === '--hook') {
    runHook();
    return 0;
  }
  if (args[0] === '--commit-hook') {
    runCommitHook();
    return 0;
  }
  if (args[0] === '--staged') {
    const staged = stagedRoadmap();
    const findings = staged === null ? [] : findCompletionLanguage(staged);
    if (findings.length === 0) return 0;
    process.stderr.write(`${format(`${ROADMAP} (staged)`, findings)}\n`);
    return 1;
  }
  const file = args[0] ?? ROADMAP;
  const findings = findCompletionLanguage(fs.readFileSync(file, 'utf8'));
  if (findings.length === 0) return 0;
  process.stderr.write(`${format(file, findings)}\n`);
  return 1;
}

// Run directly (not imported by the tests). Node reports the module by its real path, so the
// script path is resolved the same way.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
