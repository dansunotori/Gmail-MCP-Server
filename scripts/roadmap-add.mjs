#!/usr/bin/env node
// Adds a roadmap item (npm run roadmap:add -- "<title>"): appends `## <n>. <title>` with an empty
// body to ROADMAP.md and prints n, numbered as import-prompts numbers a prompt, above every item
// number ROADMAP.md holds, its highest-number comment records or its git history ever held.
// Refuses an empty title, or one holding a line break.
import { highestNumberInRoadmapHistory, nextNumber } from './import-prompts.mjs';
import { roadmapFileIo } from './roadmap-close.mjs';
import { runDirectly } from './script-support.mjs';

const USAGE = 'usage: npm run roadmap:add -- "<title>"';

// The roadmap with an item titled title appended, and the item's number. highestUsed is the
// highest item number an earlier version of the roadmap held.
export function addItem(roadmap, title, highestUsed) {
  const number = nextNumber(roadmap, highestUsed);
  const ending = roadmap === '' || roadmap.endsWith('\n') ? roadmap : `${roadmap}\n`;
  return { roadmap: `${ending}\n## ${number}. ${title}\n`, number };
}

// The command line: read() gives ROADMAP.md, write(markdown) replaces it, highestUsed() gives the
// highest item number its history held, print(line) reports the number and log(line) a refusal.
// Returns the exit code.
export function main(args, { read, write, highestUsed, print, log }) {
  const title = args.length === 1 ? args[0].trim() : '';
  if (title === '' || /[\r\n]/.test(title)) {
    log(USAGE);
    return 2;
  }
  const added = addItem(read(), title, highestUsed());
  write(added.roadmap);
  print(String(added.number));
  return 0;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    ...roadmapFileIo,
    highestUsed: () => highestNumberInRoadmapHistory(process.cwd()),
    print: line => process.stdout.write(`${line}\n`),
  });
}
