#!/usr/bin/env node
// Closes a roadmap item (npm run roadmap:close -- <n>): removes the `## <n>.` section of
// ROADMAP.md up to the next `## ` heading, leaving the numbers of the other items, the preamble
// and the spacing between sections as they are. Refuses, naming the headings found, when there
// is no section n or a heading does not hold a number of its own.
import fs from 'fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { runDirectly } from './script-support.mjs';

const ROADMAP = 'ROADMAP.md';
const USAGE = 'usage: npm run roadmap:close -- <n>';
const NUMBERED = /^## (\d+)\. /;

// The top-level `## ` headings, read as CommonMark so a heading-like line in a code block is not
// one: each with its offset and its source line.
function sections(markdown) {
  return fromMarkdown(markdown).children
    .filter(node => node.type === 'heading' && node.depth === 2)
    .map(node => {
      const start = node.position.start.offset;
      return { start, line: markdown.slice(start, node.position.end.offset).split(/\r?\n/)[0] };
    });
}

// The markdown with item n removed, as { markdown }, or { error } naming the headings found.
export function closeItem(markdown, n) {
  const headings = sections(markdown);
  const found = headings.length === 0 ? 'no ## headings' : `the headings are:\n${headings.map(heading => heading.line).join('\n')}`;
  const numbers = headings.map(heading => NUMBERED.exec(heading.line)?.[1]);
  if (numbers.some(number => number === undefined) || new Set(numbers).size !== numbers.length) {
    return { error: `the ## headings do not each hold a unique number; ${found}` };
  }
  const index = numbers.indexOf(String(n));
  if (index === -1) return { error: `there is no item ${n}; ${found}` };

  const removed = headings[index];
  const next = headings[index + 1];
  if (next) return { markdown: markdown.slice(0, removed.start) + markdown.slice(next.start) };
  // The last item: the file keeps the line ending it ended with, after the previous section.
  const ending = /\r?\n$/.exec(markdown)?.[0] ?? '';
  return { markdown: markdown.slice(0, removed.start).replace(/(?:\r?\n)+$/, '') + ending };
}

function main(args) {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const closed = closeItem(fs.readFileSync(ROADMAP, 'utf8'), Number(args[0]));
  if (closed.error) {
    process.stderr.write(`roadmap:close: ${closed.error}\n`);
    return 1;
  }
  fs.writeFileSync(ROADMAP, closed.markdown);
  return 0;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
