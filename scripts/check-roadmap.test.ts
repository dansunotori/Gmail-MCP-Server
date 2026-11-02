import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyToolEdit, findCompletionLanguage } from './check-roadmap.mjs';
import { fixtureRepo, gitIn, isolatedEnv as isolated, runScript } from './git-fixture.js';

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

describe('check-roadmap.mjs', () => {
  const clean = '# Roadmap\n\n## 1. Open item\n\nDone when:\n\n- It works.\n';
  let dir: string;
  // A run inside a Claude Code session inherits CLAUDE_PROJECT_DIR pointing at this repository;
  // the hook tests set it so, and must still check the fixture project they pass.
  let inherited: string | undefined;
  beforeAll(() => {
    inherited = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = path.join(path.dirname(script), '..');
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-roadmap-')));
  });
  afterAll(() => {
    if (inherited === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = inherited;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const roadmap = () => path.join(dir, 'ROADMAP.md');
  // The fixture directory is the project the hook sees, whatever CLAUDE_PROJECT_DIR the test
  // run itself inherits.
  const run = (args: string[], input?: string) => runScript(script, args, { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, input });
  const hook = (toolName: string, toolInput: Record<string, unknown>) =>
    run(['--hook'], JSON.stringify({ cwd: dir, tool_name: toolName, tool_input: toolInput }));

  it('passes a clean roadmap and fails one reporting finished work, naming the line and phrase', () => {
    fs.writeFileSync(roadmap(), clean);
    expect(run([roadmap()]).code).toBe(0);
    fs.appendFileSync(roadmap(), '\nThis is shipped.\n');
    const failed = run([roadmap()]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('ROADMAP.md:9: "shipped"');
  });

  it('as a hook, denies an edit to ROADMAP.md whose result reports finished work', () => {
    fs.writeFileSync(roadmap(), clean);
    const denied = JSON.parse(hook('Edit', { file_path: roadmap(), old_string: '- It works.', new_string: '- It works. Fixed.' }).stdout);
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('"Fixed"');
  });

  it('as a hook, allows a clean edit', () => {
    fs.writeFileSync(roadmap(), clean);
    expect(hook('Edit', { file_path: roadmap(), old_string: '- It works.', new_string: '- It works offline.' }).stdout).toBe('');
  });

  it('as a hook, allows a write to another file', () => {
    fs.writeFileSync(roadmap(), clean);
    expect(hook('Write', { file_path: path.join(dir, 'README.md'), content: 'Fixed.' }).stdout).toBe('');
  });

  it('as a hook, allows an edit that does not apply', () => {
    fs.writeFileSync(roadmap(), clean);
    expect(hook('Edit', { file_path: roadmap(), old_string: 'missing', new_string: 'Fixed.' }).stdout).toBe('');
  });

  it('as a hook, resolves a relative file path against the session directory in the payload', () => {
    // The process runs elsewhere and the project is dir, so only the payload directory leads
    // ../ROADMAP.md to dir/ROADMAP.md.
    const denied = runScript(script, ['--hook'], {
      cwd: os.tmpdir(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ cwd: path.join(dir, 'sub'), tool_name: 'Write', tool_input: { file_path: '../ROADMAP.md', content: '# Roadmap\n\nAll merged.\n' } }),
    });
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('check-roadmap.mjs in a repository', () => {
  const finished = '# Roadmap\n\nThis is shipped.\n';
  const open = '# Roadmap\n\nOpen work.\n';
  const merged = '# Roadmap\n\nIt merged.\n';
  const staged = 'ROADMAP.md (staged):3: "shipped"';
  let repo: string;
  beforeAll(() => {
    repo = fixtureRepo('check-roadmap-repo-');
    fs.mkdirSync(path.join(repo, 'sub'));
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // The staged ROADMAP.md (none when null) and the working copy a test starts from.
  const setRoadmap = (stagedContent: string | null, working: string) => {
    const file = path.join(repo, 'ROADMAP.md');
    fs.rmSync(file, { recursive: true, force: true });
    if (stagedContent === null) gitIn(repo)('rm', '-q', '--cached', '--ignore-unmatch', 'ROADMAP.md');
    else {
      fs.writeFileSync(file, stagedContent);
      gitIn(repo)('add', 'ROADMAP.md');
    }
    fs.writeFileSync(file, working);
  };
  const checkStaged = (cwd = repo) => runScript(script, ['--staged'], { cwd, env: isolated });
  // The project's PreToolUse hook on Bash: the process runs outside the repository, so the
  // repository comes from the payload directory.
  const commitHook = (command: string, cwd = repo) =>
    runScript(script, ['--commit-hook'], { cwd: os.tmpdir(), env: isolated, input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }) }).stdout;

  it('--staged checks the staged ROADMAP.md, not the working copy', () => {
    setRoadmap(finished, open);
    const failed = checkStaged();
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(staged);

    setRoadmap(open, merged);
    expect(checkStaged().code).toBe(0);
  });

  it('--staged checks the root ROADMAP.md when run from a subdirectory of the repository', () => {
    setRoadmap(finished, open);
    const failed = checkStaged(path.join(repo, 'sub'));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(staged);
  });

  it('--staged passes when no ROADMAP.md is staged', () => {
    setRoadmap(null, open);
    expect(checkStaged().code).toBe(0);
  });

  it('as a commit hook, denies a git commit whose staged ROADMAP.md reports finished work', () => {
    setRoadmap(finished, open);
    const denied = JSON.parse(commitHook('git commit -m "Update"')).hookSpecificOutput;
    expect(denied).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.permissionDecisionReason).toContain(staged);
  });

  it('as a commit hook run from a subdirectory, checks the root ROADMAP.md', () => {
    setRoadmap(finished, open);
    const denied = JSON.parse(commitHook('git commit -m x', path.join(repo, 'sub'))).hookSpecificOutput;
    expect(denied.permissionDecisionReason).toContain(staged);
  });

  it('as a commit hook, checks the working copy too, which commit -a records', () => {
    setRoadmap(open, merged);
    const denied = JSON.parse(commitHook('git commit -am "Update"')).hookSpecificOutput;
    expect(denied.permissionDecisionReason).toContain('ROADMAP.md (working copy):3: "merged"');
  });

  it('allows a commit when staged and working copies are clean', () => {
    setRoadmap(open, open);
    expect(commitHook('git commit -m x')).toBe('');
  });

  it('as a commit hook, denies with the findings already collected when a roadmap cannot be read', () => {
    setRoadmap(finished, open);
    fs.rmSync(path.join(repo, 'ROADMAP.md'));
    fs.mkdirSync(path.join(repo, 'ROADMAP.md'));
    const denied = JSON.parse(commitHook('git commit -m x')).hookSpecificOutput;
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain(staged);
    expect(denied.permissionDecisionReason).toContain('ROADMAP.md (working copy)');
  });
});

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
