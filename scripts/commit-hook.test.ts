import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { commitContents, readCommit } from './commit-hook.mjs';
import { fixtureRepo, withoutInheritedGitEnv } from './git-fixture.js';

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

// The hook input is read from stdin (file descriptor 0): the spy answers it with the payload and
// leaves every other read alone. Inherited GIT_* variables are removed so a test run started by a
// git hook cannot redirect git.
describe('readCommit', () => {
  let outside: string;
  let repo: string;
  withoutInheritedGitEnv();

  function read(cwd: string, command: string) {
    const original = fs.readFileSync;
    const payload = JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === 0 ? payload : (original as (...args: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync);
    return readCommit();
  }

  beforeAll(() => {
    repo = fixtureRepo('commit-hook repo ');
    fs.mkdirSync(path.join(repo, 'inner'));
    fs.mkdirSync(path.join(repo, 'sub'));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-hook-outside-')));
    fs.symlinkSync(path.join(repo, 'inner'), path.join(outside, 'link'));
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
  ])('refuses %j, whose target repository is not in its text', command => {
    expect(read(outside, command)).toBe('refuse');
  });

  it.each([
    'git status',
    'git log --grep commit',
    'git log --grep "commit; x"',
    'git status && git log | head',
  ])('ignores %j, which is not a commit', command => {
    expect(read(outside, command)).toBeNull();
  });

  // [where the session runs, the command, the commit's arguments]
  it.each([
    ['the work tree', () => repo, () => 'git commit -m x', ['-m', 'x']],
    ['the work tree with global options', () => repo, () => 'git --no-pager -c user.name=x commit -m x', ['-m', 'x']],
    ['a directory outside, -C in double quotes', () => outside, () => `git -C "${repo}" commit -m x`, ['-m', 'x']],
    ['a directory outside, -C in single quotes', () => outside, () => `git -c user.name=x -C '${repo}' commit -m x`, ['-m', 'x']],
    ['a directory outside, chained -C', () => outside, () => `git -C "${path.dirname(repo)}" -C "${path.basename(repo)}" commit -m x`, ['-m', 'x']],
    ['a directory outside, -C through a symlink', () => outside, () => 'git -C link/.. commit -m x', ['-m', 'x']],
    ['the work tree, quoted arguments', () => repo, () => 'git commit --author "A <a@b>" -m "a -- b"', ['--author', 'A <a@b>', '-m', 'a -- b']],
  ] as [string, () => string, () => string, string[]][])('finds the work tree and arguments of a commit from %s', (_name, cwd, command, args) => {
    expect(read(cwd(), command())).toEqual({ root: repo, args });
  });
});
