#!/usr/bin/env node
// Closes a roadmap item (npm run roadmap:close -- <n>): removes the `## <n>.` section of
// ROADMAP.md up to the next `## ` heading, leaving the numbers of the other items, the preamble
// and the spacing between sections as they are, and raises the `<!-- highest item number: N -->`
// comment to n when it is lower. Refuses, naming the headings found, when there is no section n
// or a heading does not hold a number of its own.
import fs from 'fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { runDirectly } from './script-support.mjs';

const ROADMAP = 'ROADMAP.md';
const USAGE = 'usage: npm run roadmap:close -- <n>';
const NUMBERED = /^## (\d+)\. /;

// The top-level `## ` headings, read as CommonMark so a heading-like line in a code block is not
// one: each with its offset, its source line and the item number it holds, undefined when none.
export function itemHeadings(markdown) {
  return fromMarkdown(markdown).children
    .filter(node => node.type === 'heading' && node.depth === 2)
    .map(node => {
      const start = node.position.start.offset;
      const line = markdown.slice(start, node.position.end.offset).split(/\r?\n/)[0];
      return { start, line, number: NUMBERED.exec(line)?.[1] };
    });
}

// The `## ` headings that hold no item number, or repeat the number of a heading before them:
// each as itemHeadings gives it, with the problem.
export function numberingProblems(markdown) {
  const seen = new Set();
  const problems = [];
  for (const heading of itemHeadings(markdown)) {
    if (heading.number === undefined) problems.push({ ...heading, problem: 'holds no item number' });
    else if (seen.has(heading.number)) problems.push({ ...heading, problem: `repeats item number ${heading.number}` });
    seen.add(heading.number);
  }
  return problems;
}

// The comment recording the highest item number the roadmap has held, so that a number closed
// before any commit is still never given to another item.
const HIGHEST = /^<!-- highest item number: (\d+) -->$/m;
const highestComment = number => `<!-- highest item number: ${number} -->`;

// The number the roadmap's highest-number comment records, or 0 when it has none.
export function recordedHighest(markdown) {
  return Number(HIGHEST.exec(markdown)?.[1] ?? 0);
}

// The markdown with item n removed and the highest-number comment at least n, as { markdown },
// or { error } naming the headings found. A missing comment goes before the first item.
export function closeItem(markdown, n) {
  const closed = removeItem(markdown, n);
  if (closed.error) return closed;
  const comment = highestComment(Math.max(recordedHighest(markdown), n));
  if (HIGHEST.test(closed.markdown)) return { markdown: closed.markdown.replace(HIGHEST, comment) };
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const first = itemHeadings(markdown)[0].start;
  return removeItem(markdown.slice(0, first) + comment + eol + eol + markdown.slice(first), n);
}

function removeItem(markdown, n) {
  const headings = itemHeadings(markdown);
  const found = headings.length === 0 ? 'no ## headings' : `the headings are:\n${headings.map(heading => heading.line).join('\n')}`;
  if (numberingProblems(markdown).length > 0) return { error: `the ## headings do not each hold a unique number; ${found}` };
  const index = headings.findIndex(heading => heading.number === String(n));
  if (index === -1) return { error: `there is no item ${n}; ${found}` };

  const removed = headings[index];
  const next = headings[index + 1];
  if (next) return { markdown: markdown.slice(0, removed.start) + markdown.slice(next.start) };
  // The last item: the file keeps the line ending it ended with, after the previous section.
  const ending = /\r?\n$/.exec(markdown)?.[0] ?? '';
  return { markdown: markdown.slice(0, removed.start).replace(/(?:\r?\n)+$/, '') + ending };
}

// The command line: read() gives ROADMAP.md, write(markdown) replaces it and log(line) reports.
// Returns the exit code.
export function main(args, { read, write, log }) {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) {
    log(USAGE);
    return 2;
  }
  const closed = closeItem(read(), Number(args[0]));
  if (closed.error) {
    log(`roadmap:close: ${closed.error}`);
    return 1;
  }
  write(closed.markdown);
  return 0;
}

// The ROADMAP.md of the current directory, as the roadmap command lines take it: read() gives
// it, write(markdown) replaces it and log(line) writes to stderr.
export const roadmapFileIo = {
  read: () => fs.readFileSync(ROADMAP, 'utf8'),
  write: markdown => fs.writeFileSync(ROADMAP, markdown),
  log: line => process.stderr.write(`${line}\n`),
};

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), roadmapFileIo);
}
