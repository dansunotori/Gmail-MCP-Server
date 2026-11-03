import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { everInRoadmapHistory, highestNumberInRoadmapHistory, importPrompts } from './import-prompts.mjs';
import { closeItem } from './roadmap-close.mjs';
import { fixtureRepo, gitIn } from './git-fixture.js';

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

  it('leaves headings inside fenced code as written, a longer fence quoting a shorter one included', () => {
    write('gmail-fenced.md', '# Fenced\n\n````markdown\n```\n## Inside\n```\n## Still inside\n````\n\n## Outside\n');
    const { roadmap } = importPrompts({ promptsDir: dir, roadmap: '# Roadmap\n', imported: never });
    expect(roadmap).toContain('```\n## Inside\n```\n## Still inside\n````\n\n### Outside\n');
  });

  it('treats a backtick line whose info string holds a backtick as text, so the headings after it still move down', () => {
    write('gmail-inline.md', '# Inline\n\n```npm test```\n\n## Contract\n');
    const { roadmap } = importPrompts({ promptsDir: dir, roadmap: '# Roadmap\n', imported: never });
    expect(roadmap).toContain('```npm test```\n\n### Contract\n');
  });

  it('moves only top-level headings down, leaving those quoted in a block quote or inside a list item', () => {
    write('gmail-nested.md', '# Nested\r\n\r\n> ## Quoted\r\n\r\n- item\r\n\r\n  ~~~\r\n  ## In code\r\n  ~~~\r\n\r\n## Top\r\n');
    const { roadmap } = importPrompts({ promptsDir: dir, roadmap: '# Roadmap\n', imported: never });
    expect(roadmap).toContain('> ## Quoted\n');
    expect(roadmap).toContain('  ## In code\n');
    expect(roadmap).toContain('\n### Top\n');
  });

  it('numbers a new prompt above the highest number the roadmap ever held when that is above every open item', () => {
    write('gmail-new.md', '# New item\n\nBody.\n');
    const { roadmap } = importPrompts({ promptsDir: dir, roadmap: ROADMAP, imported: never, highestUsed: 20 });
    expect(roadmap).toContain('## 21. New item\n');
  });

  it('numbers a prompt imported after an uncommitted highest item was closed above that item, not with its number', () => {
    write('gmail-new.md', '# New item\n\nBody.\n');
    const closed = closeItem('# Roadmap\n\n## 1. First\n\nOne.\n\n## 2. Uncommitted\n\nTwo.\n', 2).markdown as string;
    const { roadmap } = importPrompts({ promptsDir: dir, roadmap: closed, imported: never });
    expect(roadmap.match(/^## .*$/gm)).toEqual(['## 1. First', '## 3. New item']);
  });

  it('refuses a prompt with no title line, naming the file', () => {
    write('gmail-untitled.md', 'No heading here.\n');
    expect(() => importPrompts({ promptsDir: dir, roadmap: ROADMAP, imported: never }))
      .toThrow(/gmail-untitled\.md/);
  });
});

describe('roadmap history read through a git log runner', () => {
  // A runner answering `git log -p` with the patch that closed item 2, the highest-numbered one,
  // and `git log -S` with a commit for the Source line that patch removed.
  const calls: string[][] = [];
  const gitLog = (repoRoot: string, options: string[]) => {
    calls.push([repoRoot, ...options]);
    if (options[0] === '-p') return '@@ -1,8 +1,5 @@\n # Roadmap\n \n ## 1. First\n-\n-## 2. Item\n-\n-Source: `gmail-old.md`\n';
    return options[1] === '-SSource: `gmail-old.md`' ? 'abc1234\n' : '';
  };

  it('asks git for the commits that added or removed the line, and reads any as the line once held', () => {
    expect(everInRoadmapHistory('/repo', 'Source: `gmail-old.md`', gitLog)).toBe(true);
    expect(everInRoadmapHistory('/repo', 'Source: `gmail-never.md`', gitLog)).toBe(false);
    expect(calls.slice(0, 2)).toEqual([
      ['/repo', '-F', '-SSource: `gmail-old.md`', '--format=%h'],
      ['/repo', '-F', '-SSource: `gmail-never.md`', '--format=%h'],
    ]);
  });

  it('numbers a prompt imported after the highest-numbered item was closed above that item, not with its number', () => {
    const prompts = fs.mkdtempSync(path.join(os.tmpdir(), 'import-prompts-'));
    try {
      fs.writeFileSync(path.join(prompts, 'gmail-new.md'), '# New item\n\nBody.\n');
      const { roadmap } = importPrompts({
        promptsDir: prompts,
        roadmap: '# Roadmap\n\n## 1. First\n',
        imported: (line: string) => everInRoadmapHistory('/repo', line, gitLog),
        highestUsed: highestNumberInRoadmapHistory('/repo', gitLog),
      });
      expect(roadmap.match(/^## .*$/gm)).toEqual(['## 1. First', '## 3. New item']);
    } finally {
      fs.rmSync(prompts, { recursive: true, force: true });
    }
  });
});

describe('roadmap history in a repository', () => {
  let repo: string;

  // One history shared by the tests: commit 1 adds items 1 and 2, the second holding the Source
  // line, and commit 2 closes item 2, the highest-numbered one, with roadmap:close.
  beforeAll(() => {
    repo = fixtureRepo('import-prompts-repo-');
    const git = gitIn(repo);
    const roadmap = '# Roadmap\n\n## 1. First\n\nOne.\n\n## 2. Item\n\nSource: `gmail-old.md`\n';
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), roadmap);
    git('add', 'ROADMAP.md');
    git('commit', '-q', '-m', 'add');
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), closeItem(roadmap, 2).markdown as string);
    git('commit', '-q', '-am', 'close');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('finds a Source line that a past version of ROADMAP.md held, and not one it never held, and the highest number it held', () => {
    expect(everInRoadmapHistory(repo, 'Source: `gmail-old.md`')).toBe(true);
    expect(everInRoadmapHistory(repo, 'Source: `gmail-never.md`')).toBe(false);
    expect(highestNumberInRoadmapHistory(repo)).toBe(2);
  });

  it('reads the history of the repository it is given even when GIT_DIR names another', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(os.tmpdir(), 'no-such-repository.git');
    try {
      expect(everInRoadmapHistory(repo, 'Source: `gmail-old.md`')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

});
