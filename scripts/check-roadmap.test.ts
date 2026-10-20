import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations; its exports are typed by their use here.
import { applyToolEdit, findCompletionLanguage } from './check-roadmap.mjs';
import { fixtureRepo, gitIn, isolatedEnv as isolated, runScript } from './git-fixture.js';

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
  const run = (args: string[], input?: string) => runScript(script, args, { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, input });
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

describe('check-roadmap.mjs --staged', () => {
  let repo: string;
  const git = (...args: string[]) => gitIn(repo)(...args);
  const staged = (cwd = repo) => {
    try {
      execFileSync('node', [script, '--staged'], { cwd, env: isolated, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, stderr: '' };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { code: failed.status, stderr: failed.stderr };
    }
  };

  beforeEach(() => {
    repo = fixtureRepo('check-roadmap-repo-');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('checks the staged ROADMAP.md, not the working copy, and refuses one reporting finished work', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nOpen work.\n');
    const failed = staged();
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('ROADMAP.md (staged):3: "shipped"');

    git('add', 'ROADMAP.md');
    expect(staged().code).toBe(0);
  });

  it('checks the root ROADMAP.md when run from a subdirectory of the repository', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    fs.mkdirSync(path.join(repo, 'sub'));
    const failed = staged(path.join(repo, 'sub'));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('ROADMAP.md (staged):3: "shipped"');
  });

  it('passes when no ROADMAP.md is staged', () => {
    expect(staged().code).toBe(0);
  });

  // The project's PreToolUse hook on Bash: a git commit is denied while the staged roadmap fails.
  const commitHook = (command: string) => execFileSync('node', [script, '--commit-hook'], {
    cwd: repo,
    env: isolated,
    input: JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });

  it('as a commit hook, denies a git commit whose staged ROADMAP.md reports finished work', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    fs.mkdirSync(path.join(repo, 'sub'));
    for (const command of ['git commit -m "Update"', 'git -C . commit -m x', 'git -C sub commit', 'git --no-pager -c user.name=x commit -m x']) {
      const denied = JSON.parse(commitHook(command)).hookSpecificOutput;
      expect(denied, command).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(denied.permissionDecisionReason).toContain('ROADMAP.md (staged):3: "shipped"');
    }
  });

  it('as a commit hook run from a subdirectory, checks the root ROADMAP.md', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    fs.mkdirSync(path.join(repo, 'sub'));
    const output = execFileSync('node', [script, '--commit-hook'], {
      cwd: repo,
      env: isolated,
      input: JSON.stringify({ cwd: path.join(repo, 'sub'), tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
      encoding: 'utf8',
    });
    expect(JSON.parse(output).hookSpecificOutput.permissionDecisionReason).toContain('ROADMAP.md (staged):3: "shipped"');
  });

  it('as a commit hook, checks the working copy too, which commit -a and a pathspec commit record', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nOpen work.\n');
    git('add', 'ROADMAP.md');
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nIt merged.\n');
    for (const command of ['git commit -am "Update"', 'git commit -m "Update" -- ROADMAP.md']) {
      const denied = JSON.parse(commitHook(command)).hookSpecificOutput;
      expect(denied.permissionDecisionReason, command).toContain('ROADMAP.md (working copy):3: "merged"');
    }
  });

  it('as a commit hook, checks the repository the commit targets through -C, resolved by git itself', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nOpen work.\n');
    git('add', 'ROADMAP.md');
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-roadmap-other-')));
    try {
      const spaced = path.join(other, 'my repo');
      fs.mkdirSync(path.join(spaced, 'inner'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: spaced, env: isolated });
      fs.writeFileSync(path.join(spaced, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
      execFileSync('git', ['add', 'ROADMAP.md'], { cwd: spaced, env: isolated });
      // A symlink's `..` is its target's parent, as git (chdir) reads it, not this repository.
      fs.symlinkSync(path.join(spaced, 'inner'), path.join(repo, 'link'));
      for (const command of [
        `git -C "${spaced}" commit -m x`,
        `git -c user.name=x -C '${spaced}' commit -m x`,
        `git -C "${other}" -C "my repo" commit -m x`,
        'git -C link/.. commit -m x',
        'git -C link -C .. commit -m x',
      ]) {
        const denied = JSON.parse(commitHook(command)).hookSpecificOutput;
        expect(denied.permissionDecisionReason, command).toContain('ROADMAP.md (staged):3: "shipped"');
      }
      expect(commitHook('git commit -m x')).toBe('');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('as a commit hook, refuses a commit in a command whose target it cannot read, however clean the roadmap', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nOpen work.\n');
    git('add', 'ROADMAP.md');
    for (const command of [
      'git status && git commit -m x',
      'git status; git commit -m x',
      'git status || git commit -m x',
      'git status\ngit commit -m x',
      '(git commit -m x)',
      'git -C $HOME commit -m x',
      'git -C "$HOME" commit -m x',
      'git -C ~ commit -m x',
      'git -C my\\ repo commit -m x',
      'git -C * commit -m x',
      'git -C {a,b} commit -m x',
      'git --git-dir=.git commit -m x',
      'git --work-tree . commit -m x',
      'git --unknown-option commit -m x',
    ]) {
      const denied = JSON.parse(commitHook(command)).hookSpecificOutput;
      expect(denied.permissionDecision, command).toBe('deny');
      expect(denied.permissionDecisionReason, command).toContain('single plain git command');
    }
  });

  it('as a commit hook, denies with the findings already collected when a roadmap cannot be read', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    fs.rmSync(path.join(repo, 'ROADMAP.md'));
    fs.mkdirSync(path.join(repo, 'ROADMAP.md'));
    const denied = JSON.parse(commitHook('git commit -m x')).hookSpecificOutput;
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('ROADMAP.md (staged):3: "shipped"');
    expect(denied.permissionDecisionReason).toContain('ROADMAP.md (working copy): cannot be read');
  });

  it('as a commit hook, allows a commit with a clean staged roadmap and ignores other commands', () => {
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nThis is shipped.\n');
    git('add', 'ROADMAP.md');
    expect(commitHook('git status')).toBe('');
    expect(commitHook('git log --grep commit')).toBe('');
    expect(commitHook('git log --grep "commit; x"')).toBe('');
    expect(commitHook('git status && git log | head')).toBe('');
    fs.writeFileSync(path.join(repo, 'ROADMAP.md'), '# Roadmap\n\nOpen work.\n');
    git('add', 'ROADMAP.md');
    expect(commitHook('git commit -m "Update"')).toBe('');
  });
});

describe('the project hook configuration', () => {
  it('runs the roadmap and duplicate-code commit hooks for every git command, so git -C and git -c commits reach them, and only for git', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', '.claude', 'settings.json'), 'utf8'));
    const bash = settings.hooks.PreToolUse.filter((entry: { matcher: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks: Array<{ if?: string; command: string }> }) => entry.hooks)
      .filter((hook: { command: string }) => hook.command.includes('--commit-hook'));
    expect(bash.map((hook: { if?: string; command: string }) => [hook.if, hook.command])).toEqual([
      ['Bash(git *)', 'node "$CLAUDE_PROJECT_DIR/scripts/check-roadmap.mjs" --commit-hook'],
      ['Bash(git *)', 'node "$CLAUDE_PROJECT_DIR/scripts/check-duplicates.mjs" --commit-hook'],
    ]);
  });
});

describe('the repository roadmap', () => {
  it('reports no finished work', () => {
    const roadmap = fs.readFileSync(path.join(path.dirname(script), '..', 'ROADMAP.md'), 'utf8');
    expect(findCompletionLanguage(roadmap)).toEqual([]);
  });
});
