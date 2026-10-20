#!/usr/bin/env node
// Closes a roadmap item (npm run roadmap:close -- <n>): removes the `## <n>.` section of
// ROADMAP.md up to the next `## ` heading and renumbers the later headings from n, leaving the
// preamble and the spacing between sections as they are. Refuses, naming the headings found,
// when there is no section n or the headings are not numbered 1, 2, 3, … in order.
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

// The markdown with item n removed and the later items renumbered, as { markdown }, or
// { error } naming the headings found.
export function closeItem(markdown, n) {
  const headings = sections(markdown);
  const found = headings.length === 0 ? 'no ## headings' : `the headings are:\n${headings.map(heading => heading.line).join('\n')}`;
  if (!headings.every((heading, index) => NUMBERED.exec(heading.line)?.[1] === String(index + 1))) {
    return { error: `the ## headings are not numbered 1, 2, 3, … in order; ${found}` };
  }
  if (n < 1 || n > headings.length) return { error: `there is no item ${n}; ${found}` };

  const removed = headings[n - 1];
  const next = headings[n];
  let result;
  if (next) {
    result = markdown.slice(0, removed.start) + markdown.slice(next.start);
  } else {
    // The last item: the file keeps the line ending it ended with, after the previous section.
    const ending = /\r?\n$/.exec(markdown)?.[0] ?? '';
    result = markdown.slice(0, removed.start).replace(/(?:\r?\n)+$/, '') + ending;
  }
  // Each later heading moves up by the removed section's length and its number goes down by one;
  // the last is rewritten first, so a number losing a digit leaves the earlier offsets in place.
  const shift = next ? next.start - removed.start : 0;
  for (let number = headings.length; number > n; number--) {
    const at = headings[number - 1].start - shift + 3;
    result = result.slice(0, at) + String(number - 1) + result.slice(at + String(number).length);
  }
  return { markdown: result };
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
