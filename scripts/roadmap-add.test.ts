import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { highestNumberInRoadmapHistory } from './import-prompts.mjs';
import { main } from './roadmap-add.mjs';
import { closeItem } from './roadmap-close.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROADMAP = '# Roadmap\n\nWork to implement, in order.\n\n## 1. First\n\nOne.\n\n## 2. Second\n\nTwo.\n';

// roadmap:add on start held in memory, highestUsed answering for the history: its exit code, the
// roadmap it leaves, and what it printed and logged.
function add(args: string[], start: string, highestUsed = () => 0) {
  let roadmap = start;
  const printed: string[] = [];
  const logged: string[] = [];
  const code = main(args, {
    read: () => roadmap,
    write: (markdown: string) => { roadmap = markdown; },
    highestUsed,
    print: (line: string) => printed.push(line),
    log: (line: string) => logged.push(line),
  });
  return { code, roadmap, printed, logged };
}

describe('roadmap-add.mjs', () => {
  it('appends the item with an empty body under the next number and prints the number', () => {
    expect(add(['  Check the thing  '], ROADMAP)).toEqual({ code: 0, roadmap: `${ROADMAP}\n## 3. Check the thing\n`, printed: ['3'], logged: [] });
  });

  it('numbers the item above an item closed before any commit', () => {
    const closed = closeItem(ROADMAP, 2).markdown as string;
    const added = add(['New'], closed);
    expect(added.printed).toEqual(['3']);
    expect(added.roadmap.match(/^## .*$/gm)).toEqual(['## 1. First', '## 3. New']);
  });

  it('numbers the item above a number only the git history holds', () => {
    // git log -p of ROADMAP.md: a commit that removed item 40.
    const gitLog = () => '@@ -1,6 +1,3 @@\n # Roadmap\n-\n-## 40. Old\n-\n-Forty.\n';
    expect(add(['New'], ROADMAP, () => highestNumberInRoadmapHistory('/repo', gitLog)).printed).toEqual(['41']);
  });

  it.each([[[]], [['']], [['   ']], [['Two\nlines']], [['a', 'b']]])('refuses the arguments %j with the usage and leaves the roadmap unchanged', (args) => {
    expect(add(args, ROADMAP)).toEqual({ code: 2, roadmap: ROADMAP, printed: [], logged: ['usage: npm run roadmap:add -- "<title>"'] });
  });

  it('is the roadmap:add npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['roadmap:add']).toBe('node scripts/roadmap-add.mjs');
  });
});
