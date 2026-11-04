#!/usr/bin/env node
// Refuses text reporting finished work in ROADMAP.md, which holds open items only (AGENTS.md:
// no changelogs, history or reports in the repository): a word list over the file's prose, code
// blocks and inline code spans not checked. Also refuses a `## ` heading that holds no item
// number or repeats one, and a staged ROADMAP.md that drops an item the working copy or HEAD
// holds without its highest-number comment recording the item's number, as roadmap:close does,
// so that number is never given to another item.
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
import { itemHeadings, numberingProblems, recordedHighest } from './roadmap-close.mjs';
import { processIo, runDirectly } from './script-support.mjs';

const ROADMAP = 'ROADMAP.md';
const RULE = `${ROADMAP} lists open work only, each item under a "## N." heading holding a number of its own`;

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

const lineAt = (markdown, offset) => markdown.slice(0, offset).split('\n').length;

// The findings of one copy of the roadmap, each a line under label: the words reporting finished
// work, then the headings without a number of their own.
function findingsOf(label, markdown) {
  return [
    ...findCompletionLanguage(markdown).map(({ line, phrase }) => `${label}:${line}: "${phrase}"`),
    ...numberingProblems(markdown).map(({ start, line, problem }) => `${label}:${lineAt(markdown, start)}: "${line}" ${problem}`),
  ];
}

// Claude Code PreToolUse hook on Write and Edit: the deny reason for a change to the project's
// ROADMAP.md (env.CLAUDE_PROJECT_DIR, else the session directory) whose result fails, or
// undefined.
export function runHook(payload, env) {
  const project = env.CLAUDE_PROJECT_DIR || payload.cwd;
  const target = path.resolve(payload.cwd || project, payload.tool_input?.file_path ?? '');
  const roadmap = path.join(project, ROADMAP);
  if (target !== roadmap) return undefined;
  const current = fs.existsSync(roadmap) ? fs.readFileSync(roadmap, 'utf8') : '';
  const result = applyToolEdit(current, payload.tool_name, payload.tool_input);
  if (result === null) return undefined;
  const findings = findingsOf(ROADMAP, result);
  if (findings.length === 0) return undefined;
  return `${RULE}; fix these:\n${findings.join('\n')}`;
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

// The ROADMAP.md HEAD holds, or null when it holds none or there is no commit yet: one
// `git cat-file --batch` answers both, naming an object it cannot find "missing". The path is
// read from the repository root from any directory inside it. A git failure throws.
function headRoadmap(cwd, run) {
  const output = Buffer.from(run('git', ['cat-file', '--batch'], { cwd, input: `HEAD:${ROADMAP}\n`, encoding: 'buffer' }));
  // A found blob is "<sha> blob <size>\n<content>\n".
  const headerEnd = output.indexOf(10);
  const [, type, size] = output.subarray(0, headerEnd).toString('utf8').split(' ');
  if (type !== 'blob') return null;
  return output.subarray(headerEnd + 1, headerEnd + 1 + Number(size)).toString('utf8');
}

// The ROADMAP.md of the work tree at root, or null when there is none.
function workingRoadmap(root) {
  const working = path.join(root, ROADMAP);
  return fs.existsSync(working) ? fs.readFileSync(working, 'utf8') : null;
}

// A copy of the roadmap read: { label, markdown }, markdown null when there is no such copy, or
// { label, error } when it cannot be read, so one unreadable copy does not hide the findings of
// another.
function readCopy(label, read) {
  try {
    return { label, markdown: read() };
  } catch (error) {
    return { label, error: error.message };
  }
}

const unreadable = copy => (copy.error === undefined ? [] : [`${copy.label}: cannot be read: ${copy.error}`]);
const ownFindings = copy => (typeof copy.markdown === 'string' ? findingsOf(copy.label, copy.markdown) : unreadable(copy));

// The items the copies hold that the staged copy drops while its highest-number comment records
// less than their number, each named once with the first copy holding it.
function unrecordedRemovals(staged, copies) {
  if (typeof staged.markdown !== 'string') return [];
  const kept = new Set(itemHeadings(staged.markdown).map(heading => heading.number));
  const recorded = recordedHighest(staged.markdown);
  const found = [];
  for (const { label, markdown } of copies.filter(copy => typeof copy.markdown === 'string')) {
    for (const { number, line } of itemHeadings(markdown)) {
      if (number === undefined || kept.has(number) || Number(number) <= recorded) continue;
      kept.add(number);
      found.push(`${staged.label} drops "${line}", which ${label} holds, while its highest-number comment records ${recorded}: ` +
        `stage ${ROADMAP} with the item, or put it back and close it with npm run roadmap:close -- ${number}`);
    }
  }
  return found;
}

// The copies a commit's staged check reads, cwd being any directory of the work tree at root:
// the staged copy, the working copy and HEAD's, the last two read only when a copy is staged.
function commitCopies(cwd, root, run) {
  const staged = readCopy(`${ROADMAP} (staged)`, () => stagedRoadmap(cwd, run));
  if (typeof staged.markdown !== 'string') return { staged, compared: [] };
  return {
    staged,
    compared: [readCopy(`${ROADMAP} (working copy)`, () => workingRoadmap(root())), readCopy(`${ROADMAP} (HEAD)`, () => headRoadmap(cwd, run))],
  };
}

// Claude Code PreToolUse hook on Bash (configured for git commands only): the deny reason for a
// git commit while its repository's ROADMAP.md fails, or undefined. Both the staged copy and the
// working copy are checked, since `commit -a` and a pathspec commit record the working copy;
// which one a given command records is not predicted from its flags. A staged copy is also
// checked for items it drops. run answers as runCaptured (script-support.mjs) does.
export function runCommitHook(payload, run) {
  const commit = readCommit(payload, run);
  if (commit === null) return undefined;
  if (commit === 'refuse') return unreadableCommit(ROADMAP);
  const { root } = commit;
  const { staged, compared } = commitCopies(root, () => root, run);
  const [working = readCopy(`${ROADMAP} (working copy)`, () => workingRoadmap(root)), head] = compared;
  const reports = [...ownFindings(staged), ...ownFindings(working), ...(head ? unreadable(head) : []), ...unrecordedRemovals(staged, compared)];
  if (reports.length === 0) return undefined;
  return `${RULE}; fix these, stage the file again and commit:\n${reports.join('\n')}`;
}

// The command line with io (processIo in script-support.mjs); returns the exit code.
export function main(args, io) {
  if (args[0] === '--hook') return answerHook(io, payload => runHook(payload, io.env));
  if (args[0] === '--commit-hook') return answerHook(io, payload => runCommitHook(payload, io.run));
  let findings;
  if (args[0] === '--staged') {
    const root = () => io.run('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd }).trim();
    const { staged, compared } = commitCopies(io.cwd, root, io.run);
    findings = [...ownFindings(staged), ...compared.flatMap(unreadable), ...unrecordedRemovals(staged, compared)];
  } else {
    const file = args[0] ?? ROADMAP;
    findings = findingsOf(file, fs.readFileSync(path.resolve(io.cwd, file), 'utf8'));
  }
  if (findings.length === 0) return 0;
  io.stderr(`${findings.join('\n')}\n`);
  return 1;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), processIo);
}
