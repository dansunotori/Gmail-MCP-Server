#!/usr/bin/env node
// Appends this server's prompts (gmail-*.md in a prompts directory, such as
// figaro-pa-predecessor/docs/prompts) to ROADMAP.md as numbered items, each with a
// `Source: \`<file>\`` line. A prompt already imported is skipped: its Source line is in
// ROADMAP.md, or was in an earlier version of it, since an item leaves the roadmap once it
// is implemented. Idempotent.
//
//   node scripts/import-prompts.mjs <prompts-dir>
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROMPT_FILE = /^gmail-.+\.md$/;

const sourceLine = name => `Source: \`${name}\``;

// The next item number: one more than the highest `## N.` heading, or 1 when there is none.
function nextNumber(roadmap) {
  const numbers = [...roadmap.matchAll(/^## (\d+)\./gm)].map(match => Number(match[1]));
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

// The prompt as a roadmap item: its "# " title becomes the numbered heading, and its body is
// kept as written, except that its headings move one level down to sit under that heading.
// Lines inside fenced code are never headings and are left alone.
function sectionFor(number, name, content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const titleIndex = lines.findIndex(line => line.startsWith('# '));
  if (titleIndex < 0) throw new Error(`${name} has no "# " title line`);
  let fenced = false;
  const body = lines.slice(titleIndex + 1).map(line => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,5} /.test(line) ? `#${line}` : line;
  });
  const text = body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `## ${number}. ${lines[titleIndex].slice(2).trim()}\n\n${sourceLine(name)}\n\n${text}\n`;
}

// Returns the roadmap with every prompt not yet imported appended, and the names it added.
// imported(sourceLine) says whether an earlier version of the roadmap held that line.
export function importPrompts({ promptsDir, roadmap, imported }) {
  const names = fs.readdirSync(promptsDir).filter(name => PROMPT_FILE.test(name)).sort();
  const added = [];
  let result = roadmap.endsWith('\n') ? roadmap : `${roadmap}\n`;
  for (const name of names) {
    const source = sourceLine(name);
    const present = result.split('\n').some(line => line.startsWith(source));
    if (present || imported(source)) continue;
    const section = sectionFor(nextNumber(result), name, fs.readFileSync(path.join(promptsDir, name), 'utf-8'));
    result += `\n${section}`;
    added.push(name);
  }
  return { roadmap: result, added };
}

// Whether any commit added or removed the line in ROADMAP.md.
export function everInRoadmapHistory(repoRoot, line) {
  const out = execFileSync('git', ['log', '-F', `-S${line}`, '--format=%h', '--', 'ROADMAP.md'], { cwd: repoRoot, encoding: 'utf-8' });
  return out.trim() !== '';
}

// Run directly (not imported by the tests).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const promptsDir = process.argv[2];
  if (!promptsDir || process.argv.length > 3) {
    console.error('usage: node scripts/import-prompts.mjs <prompts-dir>');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const roadmapPath = path.join(root, 'ROADMAP.md');
  const { roadmap, added } = importPrompts({
    promptsDir,
    roadmap: fs.readFileSync(roadmapPath, 'utf-8'),
    imported: line => everInRoadmapHistory(root, line),
  });
  if (added.length === 0) {
    console.log('nothing to import');
  } else {
    fs.writeFileSync(roadmapPath, roadmap);
    for (const name of added) console.log(`imported ${name}`);
  }
}
