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
  it('removes the first item, keeps the numbers of the rest, the preamble and the spacing, and records the closed number before the first item', () => {
    expect(closeItem(roadmap, 1)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '<!-- highest item number: 1 -->', '', '## 2. Second', '', 'Two.', '', '```', '## 9. not a heading', '```', '', '## 3. Third', '', 'Three.'),
    });
  });

  it('closes an item by its number when the numbers are out of order or have gaps, leaving a higher recorded number as it is', () => {
    const closed = closeItem('# Roadmap\n\n<!-- highest item number: 9 -->\n\n## 7. Fix\n\nFix.\n\n## 2. Second\n\nTwo.\n\n## 5. Fifth\n\nFive.\n', 2);
    expect(closed).toEqual({ markdown: '# Roadmap\n\n<!-- highest item number: 9 -->\n\n## 7. Fix\n\nFix.\n\n## 5. Fifth\n\nFive.\n' });
  });

  it('raises a lower recorded number to the closed one', () => {
    const closed = closeItem('# Roadmap\n\n<!-- highest item number: 2 -->\n\n## 1. First\n\nOne.\n\n## 4. Fourth\n\nFour.\n', 4);
    expect(closed).toEqual({ markdown: '# Roadmap\n\n<!-- highest item number: 4 -->\n\n## 1. First\n\nOne.\n' });
  });

  it('closing the last item leaves the file ending in one newline', () => {
    expect(closeItem(roadmap, 3)).toEqual({
      markdown: lines('# Roadmap', '', 'Work to implement, in order.', '', '<!-- highest item number: 3 -->', '', '## 1. First', '', 'One.', '', '## 2. Second', '', 'Two.', '', '```', '## 9. not a heading', '```'),
    });
  });

  it('closing the only item keeps the record and CRLF line endings', () => {
    expect(closeItem('# Roadmap\r\n\r\n## 1. Only\r\n\r\nIt.\r\n', 1)).toEqual({ markdown: '# Roadmap\r\n\r\n<!-- highest item number: 1 -->\r\n' });
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
    ['a repeated number', '## 1. First\n\n## 1. Again\n', ['## 1. First', '## 1. Again']],
    ['a heading with no number', '## 1. First\n\n## Notes\n', ['## Notes']],
  ])('refuses headings that do not each hold a unique number: %s', (_name, input, named) => {
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
    expect(file()).toBe(lines('# Roadmap', '', 'Work to implement, in order.', '', '<!-- highest item number: 2 -->', '', '## 1. First', '', 'One.', '', '## 3. Third', '', 'Three.'));
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
