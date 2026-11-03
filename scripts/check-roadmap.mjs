#!/usr/bin/env node
// Refuses text reporting finished work in ROADMAP.md, which holds open items only (AGENTS.md:
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
import fs from 'fs';
import path from 'path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { answerHook, readCommit, unreadableCommit } from './commit-hook.mjs';
import { processIo, runDirectly } from './script-support.mjs';

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

// Claude Code PreToolUse hook on Write and Edit: the deny reason for a change to the project's
// ROADMAP.md (env.CLAUDE_PROJECT_DIR, else the session directory) whose result reports finished
// work, or undefined.
export function runHook(payload, env) {
  const project = env.CLAUDE_PROJECT_DIR || payload.cwd;
  const target = path.resolve(payload.cwd || project, payload.tool_input?.file_path ?? '');
  const roadmap = path.join(project, ROADMAP);
  if (target !== roadmap) return undefined;
  const current = fs.existsSync(roadmap) ? fs.readFileSync(roadmap, 'utf8') : '';
  const result = applyToolEdit(current, payload.tool_name, payload.tool_input);
  if (result === null) return undefined;
  const findings = findCompletionLanguage(result);
  if (findings.length === 0) return undefined;
  return `${ROADMAP} lists open work only; reword these to describe what remains to do:\n${format(ROADMAP, findings)}`;
}

// The ROADMAP.md the commit will record, from git's index, or null when none is staged. Run
// from a pre-commit hook, git's own environment names the repository. Both queries name the
// file at the repository root from any directory inside it (`:(top)` and `:<path>` are
// root-relative). A git failure throws.
function stagedRoadmap(cwd, run) {
  const git = args => run('git', args, { cwd });
  if (git(['ls-files', '--stage', '--', `:(top)${ROADMAP}`]) === '') return null;
  return git(['show', `:${ROADMAP}`]);
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

// Claude Code PreToolUse hook on Bash (configured for git commands only): the deny reason for a
// git commit while its repository's ROADMAP.md reports finished work, or undefined. Both the
// staged copy and the working copy are checked, since `commit -a` and a pathspec commit record
// the working copy; which one a given command records is not predicted from its flags. run
// answers as runCaptured (script-support.mjs) does.
export function runCommitHook(payload, run) {
  const commit = readCommit(payload, run);
  if (commit === null) return undefined;
  if (commit === 'refuse') return unreadableCommit(ROADMAP);
  const { root } = commit;
  const working = path.join(root, ROADMAP);
  const reports = [
    checkCopy(`${ROADMAP} (staged)`, () => stagedRoadmap(root, run)),
    checkCopy(`${ROADMAP} (working copy)`, () => (fs.existsSync(working) ? fs.readFileSync(working, 'utf8') : null)),
  ].filter(report => report !== null);
  if (reports.length === 0) return undefined;
  return `${ROADMAP} lists open work only; reword these, stage the file again and commit:\n${reports.join('\n')}`;
}

// The command line with io (processIo in script-support.mjs); returns the exit code.
export function main(args, io) {
  if (args[0] === '--hook') return answerHook(io, payload => runHook(payload, io.env));
  if (args[0] === '--commit-hook') return answerHook(io, payload => runCommitHook(payload, io.run));
  if (args[0] === '--staged') {
    const staged = stagedRoadmap(io.cwd, io.run);
    const findings = staged === null ? [] : findCompletionLanguage(staged);
    if (findings.length === 0) return 0;
    io.stderr(`${format(`${ROADMAP} (staged)`, findings)}\n`);
    return 1;
  }
  const file = args[0] ?? ROADMAP;
  const findings = findCompletionLanguage(fs.readFileSync(path.resolve(io.cwd, file), 'utf8'));
  if (findings.length === 0) return 0;
  io.stderr(`${format(file, findings)}\n`);
  return 1;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), processIo);
}
