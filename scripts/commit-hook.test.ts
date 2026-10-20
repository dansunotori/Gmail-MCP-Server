import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitContents } from './commit-hook.mjs';
import { fixtureRepo, gitIn } from './git-fixture.js';

// git itself decides which copy of each file a commit records: in a repository whose two tracked
// files each hold one copy at HEAD, another staged and a third in the working copy, the porcelain
// status of git commit --dry-run shows a file recorded from the index as MM (its working copy
// still differs) and one recorded from the working copy as "M ".
describe('commitContents against git commit --dry-run', () => {
  let repo: string;
  const git = (...args: string[]) => gitIn(repo)(...args).toString();
  const write = (file: string, content: string) => fs.writeFileSync(path.join(repo, file), content);
  const FILES = ['a.txt', 'b.txt'];

  beforeAll(() => {
    repo = fixtureRepo('commit-hook-repo-');
    for (const file of FILES) write(file, 'head\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    write('c.txt', 'second\n');
    git('add', 'c.txt');
    git('commit', '-q', '-m', 'second');
    for (const file of FILES) write(file, 'staged\n');
    git('add', ...FILES);
    for (const file of FILES) write(file, 'working\n');
    write('list', 'a.txt\n');
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // What git would record with these arguments: 'index', 'working' or 'select', as commitContents
  // names them. A dry run that would record no change exits 1 and still prints the status.
  function recorded(args: string[]): string {
    let output: string;
    try {
      output = git('commit', '--dry-run', '--porcelain', ...args);
    } catch (error) {
      const failed = error as { status: number; stdout: Buffer };
      if (failed.status !== 1) throw error;
      output = failed.stdout.toString();
    }
    const status = output.split('\n');
    const codes = FILES.map(file => status.find(line => line.endsWith(` ${file}`))?.slice(0, 2));
    if (codes.every(code => code === 'MM')) return 'index';
    if (codes.every(code => code === 'M ')) return 'working';
    return 'select';
  }

  it.each(([
    [],
    ['-m', 'x'],
    ['-a'],
    ['--all', '-m', 'x'],
    ['-am', 'x'],
    ['-a', '--no-all'],
    ['--all', '--no-all', '-a'],
    ['-uall'],
    ['-u', '-m', 'x'],
    ['--untracked-files=no'],
    ['-Skey'],
    ['-aSkey'],
    ['--amend'],
    ['--amend', '-a', '--no-edit'],
    ['-s', '-q', '-v'],
    ['-m', '-a'],
    ['-m', 'x', '--'],
    ['-a', '--'],
    ['--author', 'A <a@b>', '-m', 'x'],
    ['--only', 'a.txt'],
    ['-o', 'a.txt'],
    ['-i', 'a.txt'],
    ['--include', 'b.txt'],
    ['a.txt'],
    ['--', 'a.txt'],
    ['--fixup=reword:HEAD'],
    ['--fixup', 'reword:HEAD'],
    ['--pathspec-from-file=list'],
    ['--pathspec-from-fil=list'],
  ] as string[][]).map(args => ({ command: `git commit ${args.join(' ')}`, args })))('classifies $command as git records it', ({ command, args }) => {
    expect(commitContents(args), command).toBe(recorded(args));
  });
});
