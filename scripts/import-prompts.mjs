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
import { fromMarkdown } from 'mdast-util-from-markdown';

const PROMPT_FILE = /^gmail-.+\.md$/;

const sourceLine = name => `Source: \`${name}\``;

// The next item number: one more than the highest `## N.` heading, or 1 when there is none.
function nextNumber(roadmap) {
  const numbers = [...roadmap.matchAll(/^## (\d+)\./gm)].map(match => Number(match[1]));
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

// The raw source of a heading's text, without its # markers or setext underline.
function headingText(text, heading) {
  const children = heading.children ?? [];
  if (children.length === 0) return '';
  return text.slice(children[0].position.start.offset, children[children.length - 1].position.end.offset);
}

// The prompt as a roadmap item: its first top-level "# " heading becomes the numbered heading,
// and its body is kept as written, except that its top-level headings move one level down to
// sit under that heading. The prompt is parsed as CommonMark (mdast-util-from-markdown), so a
// "#" line in code, a block quote or a list item is left alone.
function sectionFor(number, name, content) {
  const text = content.replace(/\r\n?/g, '\n');
  const tree = fromMarkdown(text);
  const titleIndex = tree.children.findIndex(node => node.type === 'heading' && node.depth === 1);
  const title = tree.children[titleIndex];
  if (title === undefined || headingText(text, title).trim() === '') throw new Error(`${name} has no "# " title line`);
  let body = text;
  const headings = tree.children.slice(titleIndex + 1).filter(node => node.type === 'heading' && node.depth <= 5);
  // Edited from the end so earlier offsets stay valid.
  for (const heading of headings.reverse()) {
    const { offset: start } = heading.position.start;
    const { offset: end } = heading.position.end;
    const atx = /^ {0,3}#/.test(text.slice(start, end));
    body = atx
      ? body.slice(0, start) + body.slice(start, end).replace('#', '##') + body.slice(end)
      : body.slice(0, start) + `${'#'.repeat(heading.depth + 1)} ${headingText(text, heading).replace(/\n/g, ' ')}` + body.slice(end);
  }
  const section = body.slice(title.position.end.offset).replace(/^\n+/, '').replace(/\s+$/, '');
  return `## ${number}. ${headingText(text, title).trim()}\n\n${sourceLine(name)}\n\n${section}\n`;
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

// Variables that point git at a repository other than its working directory's; git sets some
// of them when it runs a hook. The repository here is always repoRoot, so they are dropped.
const GIT_LOCATION = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/;

// Whether any commit added or removed the line in ROADMAP.md.
export function everInRoadmapHistory(repoRoot, line) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_LOCATION.test(key)));
  const out = execFileSync('git', ['log', '-F', `-S${line}`, '--format=%h', '--', 'ROADMAP.md'], { cwd: repoRoot, env, encoding: 'utf-8' });
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
