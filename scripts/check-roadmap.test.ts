import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyToolEdit, findCompletionLanguage, main, runCommitHook, runHook } from './check-roadmap.mjs';
import { answeringRun, isolatedEnv as isolated, runMain, runScript } from './git-fixture.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-roadmap.mjs');
const phrases = (markdown: string) => findCompletionLanguage(markdown).map((finding: { phrase: string }) => finding.phrase);

describe('findCompletionLanguage', () => {
  it.each(['fixed', 'shipped', 'landed', 'merged', 'resolved', 'implemented', 'now', 'no longer', 'previously', 'Fixed'])('finds %s', (word) => {
    expect(phrases(`## 1. Item\n\nThis was ${word} last week.`)).toEqual([word]);
  });

  it('gives the line of a finding', () => {
    expect(findCompletionLanguage('# Roadmap\n\nIt is fixed.')).toEqual([{ line: 3, phrase: 'fixed' }]);
  });

  it('finds ticked boxes, struck-through text and status markers', () => {
    expect(phrases('- [x] item\n- [X] item')).toEqual(['[x]', '[X]']);
    expect(phrases('~~old plan~~')).toEqual(['~~old plan~~']);
    expect(phrases('**Done:** yes ✅ COMPLETE')).toEqual(['**Done:**', '✅', 'COMPLETE']);
  });

  it('leaves open-work wording alone', () => {
    expect(phrases('Done when:\n\n- The tool is not yet implemented, and not implemented in the CLI.\n- Complete the flow for now and for later.')).toEqual([]);
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
  });

  it('a tilde fence whose info string holds a backtick is still a fence', () => {
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

  it('finds words in a block quote and markers in a list', () => {
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

// A project directory on disk holding the working ROADMAP.md the tests write; git is a stub.
describe('check-roadmap.mjs', () => {
  const clean = '# Roadmap\n\n## 1. Open item\n\nDone when:\n\n- It works.\n';
  const finished = '# Roadmap\n\nThis is shipped.\n';
  const open = '# Roadmap\n\nOpen work.\n';
  const merged = '# Roadmap\n\nIt merged.\n';
  const staged = 'ROADMAP.md (staged):3: "shipped"';
  let dir: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-roadmap-')));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const roadmap = () => path.join(dir, 'ROADMAP.md');
  const setWorking = (content: string) => {
    fs.rmSync(roadmap(), { recursive: true, force: true });
    fs.writeFileSync(roadmap(), content);
  };
  // git's answers for a staged ROADMAP.md (none when null), its work tree being dir.
  const gitWithStaged = (content: string | null) => answeringRun({
    'git rev-parse --show-toplevel': `${dir}\n`,
    'git ls-files --stage -- :(top)ROADMAP.md': content === null ? '' : '100644 0123456789abcdef0123456789abcdef01234567 0\tROADMAP.md\n',
    ...(content === null ? {} : { 'git show :ROADMAP.md': content }),
  });
  const cli = (args: string[], git = answeringRun(), cwd = dir) => runMain(main, args, git.run, cwd);
  // The hook reads the project from CLAUDE_PROJECT_DIR, which a run inside a Claude Code session
  // inherits pointing at this repository; it is passed as dir here.
  const hook = (toolName: string, toolInput: Record<string, unknown>, cwd = dir) =>
    runHook({ cwd, tool_name: toolName, tool_input: toolInput }, { CLAUDE_PROJECT_DIR: dir });
  const commitHook = (command: string, git: ReturnType<typeof answeringRun>, cwd = dir) =>
    runCommitHook({ cwd, tool_name: 'Bash', tool_input: { command } }, git.run);

  it('passes a clean roadmap and fails one reporting finished work, naming the line and phrase', () => {
    setWorking(clean);
    expect(cli([roadmap()]).code).toBe(0);
    fs.appendFileSync(roadmap(), '\nThis is shipped.\n');
    const failed = cli([roadmap()]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('ROADMAP.md:9: "shipped"');
  });

  it('as a hook, denies an edit to ROADMAP.md whose result reports finished work', () => {
    setWorking(clean);
    expect(hook('Edit', { file_path: roadmap(), old_string: '- It works.', new_string: '- It works. Fixed.' })).toContain('"Fixed"');
  });

  it('as a hook, allows a clean edit, a write to another file and an edit that does not apply', () => {
    setWorking(clean);
    expect(hook('Edit', { file_path: roadmap(), old_string: '- It works.', new_string: '- It works offline.' })).toBeUndefined();
    expect(hook('Write', { file_path: path.join(dir, 'README.md'), content: 'Fixed.' })).toBeUndefined();
    expect(hook('Edit', { file_path: roadmap(), old_string: 'missing', new_string: 'Fixed.' })).toBeUndefined();
  });

  it('as a hook, resolves a relative file path against the session directory in the payload', () => {
    expect(hook('Write', { file_path: '../ROADMAP.md', content: '# Roadmap\n\nAll merged.\n' }, path.join(dir, 'sub'))).toContain('"merged"');
  });

  it('--staged checks the staged ROADMAP.md, not the working copy, naming it at the root from any directory', () => {
    setWorking(open);
    const git = gitWithStaged(finished);
    const failed = cli(['--staged'], git, path.join(dir, 'sub'));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(staged);
    expect(git.calls.map(call => call.cwd)).toEqual([path.join(dir, 'sub'), path.join(dir, 'sub')]);

    setWorking(merged);
    expect(cli(['--staged'], gitWithStaged(open)).code).toBe(0);
  });

  it('--staged passes when no ROADMAP.md is staged', () => {
    setWorking(finished);
    const git = gitWithStaged(null);
    expect(cli(['--staged'], git).code).toBe(0);
    expect(git.calls.map(call => call.line)).toEqual(['git ls-files --stage -- :(top)ROADMAP.md']);
  });

  it('as a commit hook, denies a git commit whose staged ROADMAP.md reports finished work, reading it at the work tree root', () => {
    setWorking(open);
    const git = gitWithStaged(finished);
    expect(commitHook('git commit -m "Update"', git, path.join(dir, 'sub'))).toContain(staged);
    expect(git.calls.slice(1).map(call => call.cwd)).toEqual([dir, dir]);
  });

  it('as a commit hook, checks the working copy too, which commit -a records', () => {
    setWorking(merged);
    expect(commitHook('git commit -am "Update"', gitWithStaged(open))).toContain('ROADMAP.md (working copy):3: "merged"');
  });

  it('allows a commit when staged and working copies are clean', () => {
    setWorking(open);
    expect(commitHook('git commit -m x', gitWithStaged(open))).toBeUndefined();
  });

  it('as a commit hook, denies with the findings already collected when a roadmap cannot be read', () => {
    fs.rmSync(roadmap(), { recursive: true, force: true });
    fs.mkdirSync(roadmap());
    const reason = commitHook('git commit -m x', gitWithStaged(finished));
    expect(reason).toContain(staged);
    expect(reason).toContain('ROADMAP.md (working copy): cannot be read');
  });

  it('as a commit hook, denies a commit whose target repository is not in its text, and ignores a command that is not a commit', () => {
    expect(commitHook('git status && git commit -m x', answeringRun())).toContain('cannot be checked against ROADMAP.md');
    expect(commitHook('git status', answeringRun())).toBeUndefined();
  });
});

// The script as Claude Code runs it, a node process reading the payload on stdin.
describe('check-roadmap.mjs commit hook wiring', () => {
  it.each([
    ['git status', undefined],
    ['git status && git commit -m x', 'deny'],
  ])('answers %s with %s', (command, decision) => {
    const output = runScript(script, ['--commit-hook'], {
      cwd: os.tmpdir(),
      env: isolated,
      input: JSON.stringify({ cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command } }),
    }).stdout;
    if (decision === undefined) expect(output).toBe('');
    else expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe(decision);
  });
});

describe('the project hook configuration', () => {
  it('runs the roadmap and duplicate-code commit hooks for every git command, so git -C and git -c commits reach them', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', '.claude', 'settings.json'), 'utf8'));
    const bash = settings.hooks.PreToolUse.filter((entry: { matcher: string }) => entry.matcher === 'Bash')
      .flatMap((entry: { hooks: Array<{ if?: string; command: string }> }) => entry.hooks);
    for (const name of ['check-roadmap.mjs', 'check-duplicates.mjs']) {
      const hooks = bash.filter((hook: { command: string }) => hook.command.includes(name) && hook.command.includes('--commit-hook'));
      expect(hooks.map((hook: { if?: string }) => hook.if), name).toEqual(['Bash(git *)']);
    }
  });
});
