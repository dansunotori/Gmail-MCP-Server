import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations; its exports are typed by their use here.
import { everInRoadmapHistory, importPrompts } from './import-prompts.mjs';

const ROADMAP = '# Roadmap\n\nWork to implement, in order.\n\n## 7. Script to import prompts\n\nBody.\n\n## 12. Another item\n\nBody.\n';

const PROMPT = '# Errors that say why\n\nA failed call prints an error.\n\n## Contract\n\n- One line.\n\n## Done when\n\n- Live, it works.\n';

describe('importPrompts', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-prompts-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
  const never = () => false;

  it('appends a new gmail prompt verbatim under the next number, its headings one level down, and ignores other servers\' prompts', () => {
    write('gmail-error-detail.md', PROMPT);
    write('outlook-event-body.md', '# Outlook item\n\nNot ours.\n');
    write('gmail-notes.txt', '# Not a prompt\n');
    const { roadmap, added } = importPrompts({ promptsDir: dir, roadmap: ROADMAP, imported: never });
    expect(added).toEqual(['gmail-error-detail.md']);
    expect(roadmap).toBe(`${ROADMAP}\n## 13. Errors that say why\n\nSource: \`gmail-error-detail.md\`\n\nA failed call prints an error.\n\n### Contract\n\n- One line.\n\n### Done when\n\n- Live, it works.\n`);
    expect(roadmap).not.toContain('Outlook item');
  });

  it('adds nothing the second time it runs against the same prompts', () => {
    write('gmail-error-detail.md', PROMPT);
    const first = importPrompts({ promptsDir: dir, roadmap: ROADMAP, imported: never });
    const second = importPrompts({ promptsDir: dir, roadmap: first.roadmap, imported: never });
    expect(second.added).toEqual([]);
    expect(second.roadmap).toBe(first.roadmap);
  });

  it('skips a prompt whose item was imported earlier and has since left the roadmap', () => {
    write('gmail-error-detail.md', PROMPT);
    write('gmail-new.md', '# New item\n\nBody.\n');
    const { added, roadmap } = importPrompts({
      promptsDir: dir,
      roadmap: ROADMAP,
      imported: (source: string) => source === 'Source: `gmail-error-detail.md`',
    });
    expect(added).toEqual(['gmail-new.md']);
    expect(roadmap).toContain('## 13. New item\n\nSource: `gmail-new.md`\n');
  });

  it('numbers several new prompts in file-name order, starting at 1 in a roadmap with no items', () => {
    write('gmail-b.md', '# Second\n\nB.\n');
    write('gmail-a.md', '# First\n\nA.\n');
    const { roadmap, added } = importPrompts({ promptsDir: dir, roadmap: '# Roadmap\n', imported: never });
    expect(added).toEqual(['gmail-a.md', 'gmail-b.md']);
    expect(roadmap).toBe('# Roadmap\n\n## 1. First\n\nSource: `gmail-a.md`\n\nA.\n\n## 2. Second\n\nSource: `gmail-b.md`\n\nB.\n');
  });

  it('refuses a prompt with no title line rather than invent one', () => {
    write('gmail-untitled.md', 'No heading here.\n');
    expect(() => importPrompts({ promptsDir: dir, roadmap: ROADMAP, imported: never }))
      .toThrow('gmail-untitled.md has no "# " title line');
  });
});

describe('everInRoadmapHistory', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'import-prompts-repo-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('finds a Source line that a past version of ROADMAP.md held, and not one it never held', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '## 1. Item\n\nSource: `gmail-old.md`\n');
    git('add', 'ROADMAP.md');
    git('commit', '-q', '-m', 'add');
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n');
    git('commit', '-q', '-am', 'remove');
    expect(everInRoadmapHistory(repo, 'Source: `gmail-old.md`')).toBe(true);
    expect(everInRoadmapHistory(repo, 'Source: `gmail-never.md`')).toBe(false);
  });
});
