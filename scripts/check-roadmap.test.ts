import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations; its exports are typed by their use here.
import { applyToolEdit, findCompletionLanguage } from './check-roadmap.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-roadmap.mjs');
const phrases = (markdown: string) => findCompletionLanguage(markdown).map((finding: { phrase: string }) => finding.phrase);

describe('findCompletionLanguage', () => {
  it('finds each word that reports finished work, with its line', () => {
    for (const word of ['fixed', 'shipped', 'landed', 'merged', 'resolved', 'implemented', 'now', 'no longer', 'previously', 'Fixed']) {
      expect(phrases(`## 1. Item\n\nThis was ${word} last week.`), word).toEqual([word]);
    }
    expect(findCompletionLanguage('# Roadmap\n\nIt is fixed.')).toEqual([{ line: 3, phrase: 'fixed' }]);
  });

  it('finds ticked boxes, struck-through text and status markers', () => {
    expect(phrases('- [x] item\n- [X] item')).toEqual(['[x]', '[X]']);
    expect(phrases('~~old plan~~')).toEqual(['~~old plan~~']);
    expect(phrases('**Done:** yes ✅ COMPLETE')).toEqual(['**Done:**', '✅', 'COMPLETE']);
  });

  it('leaves open-work wording alone', () => {
    expect(phrases('Done when:\n\n- The tool is not yet implemented, and not implemented in the CLI.\n- Complete the flow for now and for later.')).toEqual([]);
    expect(phrases('Work for now.')).toEqual([]);
    expect(phrases('- The test must complete in CI.')).toEqual([]);
  });

  it('exempts fenced code blocks and inline code', () => {
    expect(phrases('Run `git log --grep fixed` first.\n\n```\nfixed in 1.2\n```\n\nAfter the fence it is fixed.')).toEqual(['fixed']);
  });

  it('closes a fence only on the same character at least as long, so a longer fence can quote a shorter one', () => {
    expect(phrases('````markdown\n```\nfixed\n```\n````\n\nAfter it, merged.')).toEqual(['merged']);
    expect(phrases('~~~\n```\nfixed\n~~~\n\nmerged')).toEqual(['merged']);
    expect(phrases('```\nfixed\n```js\nstill code: fixed\n```')).toEqual([]);
  });

  it('exempts a code span that crosses a line break within a paragraph, keeping line numbers', () => {
    expect(findCompletionLanguage('Run `git log --grep\nfixed` to inspect.\nIt merged.')).toEqual([{ line: 3, phrase: 'merged' }]);
    // A blank line ends the paragraph, so a backtick before it opens no span after it.
    expect(phrases('A stray ` here.\n\nfixed` after the break.')).toEqual(['fixed']);
  });

  it('reads a backtick line whose info string holds a backtick as inline code, not a fence', () => {
    expect(findCompletionLanguage('```git log --grep fixed```\n\nThis was shipped.')).toEqual([{ line: 3, phrase: 'shipped' }]);
    expect(phrases('~~~ a`b\nfixed\n~~~\nmerged')).toEqual(['merged']);
  });

  it('reads CRLF line endings like LF ones, so a CRLF fence both exempts its code and ends', () => {
    expect(phrases('~~~text\r\nfixed\r\n~~~\r\n')).toEqual([]);
    expect(phrases('~~~\nexample\n~~~\r\n\r\nThis is shipped.\r\n')).toEqual(['shipped']);
  });

  it('exempts a fence inside a block quote or a list item, and checks the prose after the container ends', () => {
    expect(phrases('> ~~~text\n> fixed\n> ~~~')).toEqual([]);
    expect(phrases('- Example:\n\n    ~~~text\n    fixed\n    ~~~')).toEqual([]);
    expect(phrases('- Example:\n\n  ~~~text\n  sample\n\nThis is shipped.\n')).toEqual(['shipped']);
  });

  it('still finds markers written with emphasis or brackets, and words in a quote or list', () => {
    expect(phrases('Status: **Done:** now?')).toEqual(['**Done:**', 'now']);
    expect(phrases('> It was merged.\n\n- [x] item\n- ~~struck~~')).toEqual(['merged', '[x]', '~~struck~~']);
  });

  it('matches an inline code span by its own delimiter length, so it may hold a shorter backtick run', () => {
    expect(phrases('Run ``fixed ` marker`` next.')).toEqual([]);
    expect(phrases('A ``span`` then fixed and `x`.')).toEqual(['fixed']);
    expect(phrases('An unmatched `` leaves fixed checked.')).toEqual(['fixed']);
  });
});

describe('applyToolEdit', () => {
  it('gives the file as a Write or an Edit would leave it, or null when the edit does not apply', () => {
    expect(applyToolEdit('old', 'Write', { content: 'new' })).toBe('new');
    expect(applyToolEdit('a b a', 'Edit', { old_string: 'a', new_string: 'c' })).toBe('c b a');
    expect(applyToolEdit('a b a', 'Edit', { old_string: 'a', new_string: 'c', replace_all: true })).toBe('c b c');
    expect(applyToolEdit('a', 'Edit', { old_string: 'z', new_string: 'c' })).toBeNull();
    expect(applyToolEdit('a', 'Read', {})).toBeNull();
  });
});

describe('check-roadmap.mjs', () => {
  let dir: string;
  // A run inside a Claude Code session inherits CLAUDE_PROJECT_DIR pointing at this repository;
  // the hook tests set it so, and must still check the fixture project they pass.
  let inherited: string | undefined;
  beforeAll(() => {
    inherited = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = path.join(path.dirname(script), '..');
  });
  afterAll(() => {
    if (inherited === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = inherited;
  });
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-roadmap-')));
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), '# Roadmap\n\n## 1. Open item\n\nDone when:\n\n- It works.\n');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The fixture directory is the project the hook sees, whatever CLAUDE_PROJECT_DIR the test
  // run itself inherits.
  const run = (args: string[], input?: string) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    try {
      return { code: 0, stdout: execFileSync('node', [script, ...args], { cwd: dir, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  const hook = (toolName: string, toolInput: Record<string, unknown>) =>
    run(['--hook'], JSON.stringify({ cwd: dir, tool_name: toolName, tool_input: toolInput }));

  it('passes a clean roadmap and fails one reporting finished work, naming the line and phrase', () => {
    expect(run([path.join(dir, 'ROADMAP.md')]).code).toBe(0);
    fs.appendFileSync(path.join(dir, 'ROADMAP.md'), '\nThis is shipped.\n');
    const failed = run([path.join(dir, 'ROADMAP.md')]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('ROADMAP.md:9: "shipped"');
  });

  it('as a hook, denies an edit to ROADMAP.md whose result reports finished work', () => {
    const denied = JSON.parse(hook('Edit', { file_path: path.join(dir, 'ROADMAP.md'), old_string: '- It works.', new_string: '- It works. Fixed.' }).stdout);
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('"Fixed"');
  });

  it('as a hook, allows a clean edit, an edit to another file, and an edit that does not apply', () => {
    expect(hook('Edit', { file_path: path.join(dir, 'ROADMAP.md'), old_string: '- It works.', new_string: '- It works offline.' }).stdout).toBe('');
    expect(hook('Write', { file_path: path.join(dir, 'README.md'), content: 'Fixed.' }).stdout).toBe('');
    expect(hook('Edit', { file_path: path.join(dir, 'ROADMAP.md'), old_string: 'missing', new_string: 'Fixed.' }).stdout).toBe('');
  });

  it('reads code spans across lines and inline triple backticks the same way from the command line and the hook', () => {
    const spanned = '# Roadmap\n\nRun `git log --grep\nfixed` to inspect.\n';
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), spanned);
    expect(run([path.join(dir, 'ROADMAP.md')]).code).toBe(0);
    expect(hook('Write', { file_path: path.join(dir, 'ROADMAP.md'), content: spanned }).stdout).toBe('');

    const inline = '# Roadmap\n\n```git log --grep fixed```\n\nThis was shipped.\n';
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), inline);
    expect(run([path.join(dir, 'ROADMAP.md')]).stderr).toContain('ROADMAP.md:5: "shipped"');
    expect(JSON.parse(hook('Write', { file_path: path.join(dir, 'ROADMAP.md'), content: inline }).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('as a hook, resolves a relative file path against the session directory', () => {
    const denied = hook('Write', { file_path: 'ROADMAP.md', content: '# Roadmap\n\nAll merged.\n' });
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('the repository roadmap', () => {
  it('reports no finished work', () => {
    const roadmap = fs.readFileSync(path.join(path.dirname(script), '..', 'ROADMAP.md'), 'utf8');
    expect(findCompletionLanguage(roadmap)).toEqual([]);
  });
});
