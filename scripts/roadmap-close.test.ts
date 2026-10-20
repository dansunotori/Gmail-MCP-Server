import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from './git-fixture.js';
import { closeItem } from './roadmap-close.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scripts, '..');
const script = path.join(scripts, 'roadmap-close.mjs');

// Three items, the second holding a code block with a heading-like line that is not a heading.
const roadmap = [
  '# Roadmap', '', 'Work to implement, in order.', '',
  '## 1. First', '', 'One.', '',
  '## 2. Second', '', 'Two.', '', '```', '## 9. not a heading', '```', '',
  '## 3. Third', '', 'Three.', '',
].join('\n');

const lines = (...parts: string[]) => `${parts.join('\n')}\n`;

describe('closeItem', () => {
  it('removes the first item and renumbers the rest, keeping the preamble and spacing', () => {
    expect(closeItem(roadmap, 1)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '## 1. Second', '', 'Two.', '', '```', '## 9. not a heading', '```', '', '## 2. Third', '', 'Three.'),
    });
  });

  it('removes a middle item and renumbers the ones after it', () => {
    expect(closeItem(roadmap, 2)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '## 1. First', '', 'One.', '', '## 2. Third', '', 'Three.'),
    });
  });

  it('removes the last item, leaving the file ending in one line break', () => {
    expect(closeItem(roadmap, 3)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '## 1. First', '', 'One.', '', '## 2. Second', '', 'Two.', '', '```', '## 9. not a heading', '```'),
    });
    expect(closeItem('# Roadmap\r\n\r\n## 1. Only\r\n\r\nIt.\r\n', 1)).toEqual({ markdown: '# Roadmap\r\n' });
  });

  it('renumbers a heading whose number loses a digit', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `## ${index + 1}. Item ${index + 1}\n\nText.\n`).join('\n');
    const closed = closeItem(`# Roadmap\n\n${eleven}`, 1).markdown as string;
    expect(closed.match(/^## .*$/gm)).toEqual(Array.from({ length: 10 }, (_, index) => `## ${index + 1}. Item ${index + 2}`));
  });

  it('refuses an item that does not exist, naming the headings found', () => {
    expect(closeItem(roadmap, 4)).toEqual({ error: 'there is no item 4; the headings are:\n## 1. First\n## 2. Second\n## 3. Third' });
    expect(closeItem('# Roadmap\n\nNothing open.\n', 1)).toEqual({ error: 'there is no item 1; no ## headings' });
  });

  it('refuses headings not numbered 1, 2, 3, … in order, naming them', () => {
    expect(closeItem('## 1. First\n\n## 3. Third\n', 1)).toEqual({
      error: 'the ## headings are not numbered 1, 2, 3, … in order; the headings are:\n## 1. First\n## 3. Third',
    });
    expect(closeItem('## 1. First\n\n## Notes\n', 1).error).toContain('not numbered 1, 2, 3, … in order; the headings are:\n## 1. First\n## Notes');
  });
});

describe('roadmap-close.mjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-close-')));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[]) => runScript(script, args, { cwd: dir, env: process.env });
  const file = () => fs.readFileSync(path.join(dir, 'ROADMAP.md'), 'utf8');

  it('closes the item in ROADMAP.md, and npm run roadmap:check passes on the result', () => {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
    expect(run(['2']).code).toBe(0);
    expect(file()).toBe(closeItem(roadmap, 2).markdown);
    expect(runScript(path.join(scripts, 'check-roadmap.mjs'), [], { cwd: dir, env: process.env }).code).toBe(0);
  });

  it('refuses without changing the file, and asks for one item number', () => {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
    const refused = run(['4']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('roadmap:close: there is no item 4');
    expect(file()).toBe(roadmap);
    for (const args of [[], ['0'], ['two'], ['1', '2']]) {
      expect(run(args), args.join(' ')).toMatchObject({ code: 2, stderr: 'usage: npm run roadmap:close -- <n>\n' });
    }
  });

  it('is the roadmap:close npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['roadmap:close']).toBe('node scripts/roadmap-close.mjs');
  });
});
