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

  it('closing the last item leaves the file ending in one newline', () => {
    expect(closeItem(roadmap, 3)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '## 1. First', '', 'One.', '', '## 2. Second', '', 'Two.', '', '```', '## 9. not a heading', '```'),
    });
  });

  it('closing the only item keeps CRLF line endings', () => {
    expect(closeItem('# Roadmap\r\n\r\n## 1. Only\r\n\r\nIt.\r\n', 1)).toEqual({ markdown: '# Roadmap\r\n' });
  });

  it('renumbers a heading whose number loses a digit', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `## ${index + 1}. Item ${index + 1}\n\nText.\n`).join('\n');
    const closed = closeItem(`# Roadmap\n\n${eleven}`, 9).markdown as string;
    expect(closed.match(/^## .*$/gm)).toEqual([
      '## 1. Item 1', '## 2. Item 2', '## 3. Item 3', '## 4. Item 4', '## 5. Item 5', '## 6. Item 6', '## 7. Item 7', '## 8. Item 8',
      '## 9. Item 10', '## 10. Item 11',
    ]);
  });

  it('refuses an item that does not exist, naming the headings found', () => {
    const refused = closeItem(roadmap, 4);
    expect(refused.markdown).toBeUndefined();
    expect(refused.error).toContain('## 1. First');
    expect(refused.error).toContain('## 2. Second');
    expect(refused.error).toContain('## 3. Third');
  });

  it('refuses when the roadmap has no items', () => {
    const refused = closeItem('# Roadmap\n\nNothing open.\n', 1);
    expect(refused.markdown).toBeUndefined();
    expect(refused.error).toBeDefined();
  });

  it.each([
    ['a skipped number', '## 1. First\n\n## 3. Third\n', ['## 1. First', '## 3. Third']],
    ['a heading with no number', '## 1. First\n\n## Notes\n', ['## Notes']],
  ])('refuses headings not numbered 1, 2, 3, … in order: %s', (_name, input, named) => {
    const refused = closeItem(input, 1);
    expect(refused.markdown).toBeUndefined();
    expect(refused.error).toBeDefined();
    for (const heading of named) expect(refused.error).toContain(heading);
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

  it('closes the item in ROADMAP.md', () => {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
    expect(run(['2']).code).toBe(0);
    expect(file()).toBe(lines('# Roadmap', '', 'Work to implement, in order.', '', '## 1. First', '', 'One.', '', '## 2. Third', '', 'Three.'));
  });

  it('refuses a missing item without changing the file', () => {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
    const refused = run(['4']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).not.toBe('');
    expect(file()).toBe(roadmap);
  });

  it.each([[[]], [['0']], [['two']], [['1', '2']]])('refuses the arguments %j with the usage and leaves the file unchanged', (args) => {
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), roadmap);
    const refused = run(args);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('roadmap:close');
    expect(file()).toBe(roadmap);
  });

  it('is the roadmap:close npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['roadmap:close']).toBe('node scripts/roadmap-close.mjs');
  });
});
