import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from './check-ignored.mjs';
import { answeringRun, runMain } from './git-fixture.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The check run in a directory holding gitignore as its .gitignore, with git answering as if it
// were the work tree root and its index listed the tracked ignored paths.
function check(gitignore: string, ignored: string[] = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-ignored-')));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  const git = answeringRun({
    'git rev-parse --show-toplevel': `${dir}\n`,
    'git ls-files -ci --exclude-standard -z': ignored.map(file => `${file}\0`).join(''),
  });
  return runMain(main, [], git.run, dir);
}

describe('check-ignored.mjs', () => {
  it('fails on a tracked path that .gitignore matches, naming it and the command that untracks it', () => {
    const failed = check('tmp/\n', ['tmp/report.json']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe('tmp/report.json is tracked although .gitignore matches it; untrack it with git rm --cached tmp/report.json\n');
  });

  it('fails on a .gitignore line repeated in the file, naming it and the line it repeats, comments and blank lines aside', () => {
    const failed = check('# Build\ndist/\n\n# Build\n\ndist/ \n');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe('.gitignore:6: "dist/" repeats line 2; delete one of them\n');
  });

  it('passes a clean listing and a .gitignore without repeats', () => {
    expect(check('node_modules/\ndist/\n')).toEqual({ code: 0, stderr: '' });
  });

  it('exits 2 naming the failure when git cannot answer', () => {
    const git = answeringRun({ 'git rev-parse --show-toplevel': new Error('not a git repository') });
    expect(runMain(main, [], git.run, os.tmpdir())).toEqual({ code: 2, stderr: 'check-ignored: not a git repository\n' });
  });
});
