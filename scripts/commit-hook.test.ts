import { describe, expect, it } from 'vitest';
import { answerHook, commitContents, commitTarget, readCommit } from './commit-hook.mjs';
import { answeringRun, exitError } from './git-fixture.js';

// What a commit with these arguments records: the index as staged, the working copy of every
// tracked file (-a / --all), or a selection of paths, hunks or HEAD.
describe('commitContents', () => {
  it.each([
    [[], 'index'],
    [['-m', 'x'], 'index'],
    [['-a'], 'working'],
    [['--all'], 'working'],
    [['-am', 'x'], 'working'],
    [['-a', '--no-all'], 'index'],
    [['--all', '--no-all', '-a'], 'working'],
    [['-uall'], 'index'],
    [['--untracked-files=no'], 'index'],
    [['-aSkey'], 'working'],
    [['--amend', '-a', '--no-edit'], 'working'],
    [['-s', '-q', '-v'], 'index'],
    [['-m', '-a'], 'index'],
    [['-m', 'x', '--'], 'index'],
    [['-a', '--'], 'working'],
    [['--author', 'A <a@b>', '-m', 'a -- b'], 'index'],
    [['--only', '-m', 'x'], 'select'],
    [['-o', '-m', 'x'], 'select'],
    [['a.txt'], 'select'],
    [['--', 'a.txt'], 'select'],
    [['--fixup=reword:HEAD'], 'select'],
    [['--fixup', 'reword:HEAD'], 'select'],
    [['--pathspec-from-file=list'], 'select'],
    [['--pathspec-from-fil=list'], 'select'],
  ] as [string[], string][])('classifies git commit %j as %s', (args, expected) => {
    expect(commitContents(args)).toBe(expected);
  });
});

// git is answered by a stub: the work tree of a commit is whatever `git rev-parse --show-toplevel`
// prints from the session directory with the command's -C options, which is git's own to resolve.
describe('commitTarget', () => {
  const repo = '/work/my repo';
  const read = (cwd: string, command: string, answers: Record<string, string | Error> = {}) => {
    const git = answeringRun(answers);
    return { target: commitTarget(command, cwd, git.run), calls: git.calls };
  };

  it.each([
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
  ])('refuses %j, whose target repository is not in its text, without running git', command => {
    const { target, calls } = read('/outside', command);
    expect(target).toBe('refuse');
    expect(calls).toEqual([]);
  });

  it.each([
    'git status',
    'git log --grep commit',
    'git log --grep "commit; x"',
    'git status && git log | head',
  ])('ignores %j, which is not a commit, without running git', command => {
    const { target, calls } = read('/outside', command);
    expect(target).toBeNull();
    expect(calls).toEqual([]);
  });

  // [the command, the git command line that finds its work tree, the commit's arguments]
  it.each([
    ['git commit -m x', 'git rev-parse --show-toplevel', ['-m', 'x']],
    ['git --no-pager -c user.name=x commit -m x', 'git rev-parse --show-toplevel', ['-m', 'x']],
    [`git -C "${repo}" commit -m x`, `git -C ${repo} rev-parse --show-toplevel`, ['-m', 'x']],
    [`git -c user.name=x -C '${repo}' commit -m x`, `git -C ${repo} rev-parse --show-toplevel`, ['-m', 'x']],
    ['git -C "/work" -C "my repo" commit -m x', 'git -C /work -C my repo rev-parse --show-toplevel', ['-m', 'x']],
    ['git -C link/.. commit -m x', 'git -C link/.. rev-parse --show-toplevel', ['-m', 'x']],
    ['git commit --author "A <a@b>" -m "a -- b"', 'git rev-parse --show-toplevel', ['--author', 'A <a@b>', '-m', 'a -- b']],
  ])('finds the work tree and arguments of %j from the session directory, with its -C options in order', (command, line, args) => {
    const { target, calls } = read('/outside', command, { [line]: `${repo}\n` });
    expect(target).toEqual({ root: repo, args });
    expect(calls).toEqual([{ line, cwd: '/outside' }]);
  });

  it('reads a commit git finds no work tree for, or cannot run for, as no commit, and throws on any other failure', () => {
    expect(read('/outside', 'git commit -m x', { 'git rev-parse --show-toplevel': exitError(128, 'not a git repository') }).target).toBeNull();
    expect(read('/outside', 'git commit -m x', { 'git rev-parse --show-toplevel': Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }).target).toBeNull();
    expect(() => read('/outside', 'git commit -m x', { 'git rev-parse --show-toplevel': new Error('EPIPE') })).toThrow('EPIPE');
  });
});

describe('readCommit', () => {
  it("reads the command of a hook payload from the session directory it names", () => {
    const git = answeringRun({ 'git rev-parse --show-toplevel': '/work/repo\n' });
    expect(readCommit({ cwd: '/work/repo/sub', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, git.run)).toEqual({ root: '/work/repo', args: ['-m', 'x'] });
    expect(git.calls).toEqual([{ line: 'git rev-parse --show-toplevel', cwd: '/work/repo/sub' }]);
  });
});

describe('answerHook', () => {
  const answer = (reason: string | undefined) => {
    const written: string[] = [];
    const seen: unknown[] = [];
    const io = { stdin: () => '{"tool_name":"Bash"}', stdout: (text: string) => written.push(text) };
    const code = answerHook(io, (payload: unknown) => { seen.push(payload); return reason; });
    return { code, written, seen };
  };

  it('writes the deny of the reason the decision gives for the payload on stdin', () => {
    const { code, written, seen } = answer('no');
    expect(code).toBe(0);
    expect(seen).toEqual([{ tool_name: 'Bash' }]);
    expect(written.map(text => JSON.parse(text))).toEqual([{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }]);
  });

  it('writes nothing when the decision allows the call', () => {
    expect(answer(undefined)).toMatchObject({ code: 0, written: [] });
  });
});
