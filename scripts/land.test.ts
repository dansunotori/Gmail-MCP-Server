import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { cleanMain, scriptedRun } from './git-fixture.js';
import { land } from './land.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Lands a branch against a scripted runner that answers cleanMain, the sha of HEAD and the given
// answers; returns the exit code, what was logged and the commands the runner was asked for.
const landing = (branch: string | undefined, answers: Parameters<typeof scriptedRun>[0] = {}) => {
  const { run, calls } = scriptedRun({ ...cleanMain, 'git rev-parse HEAD': { stdout: 'abc123\n' }, ...answers });
  const logged: string[] = [];
  const code = land(branch, run, (line: string) => logged.push(line));
  return { code, logged, calls };
};

const checkedMain = [
  ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
  ['git', 'status', '--porcelain'],
  ['git', 'fetch', 'origin'],
];

describe('land', () => {
  it('lands a branch that holds origin/main and reports its CI passed', () => {
    const { code, logged, calls } = landing('feature');
    expect(code).toBe(0);
    expect(calls).toEqual([
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['git', 'status', '--porcelain'],
      ['git', 'fetch', 'origin'],
      ['git', 'merge-base', '--is-ancestor', 'origin/main', 'feature'],
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'merge', '--ff-only', '--quiet', 'feature'],
      ['git', 'diff', '--quiet', 'abc123', 'HEAD', '--', 'package-lock.json'],
      ['npm', 'run', 'verify'],
      ['git', 'push', 'origin', 'main'],
      ['npm', 'run', 'ci:watch', '--', '--quiet'],
    ]);
    expect(logged.at(-1)).toContain('feature');
    expect(logged.at(-1)).toContain('CI passed');
  });

  it('installs dependencies after fast-forwarding and before verifying when package-lock.json changed', () => {
    const { code, calls } = landing('feature', { 'git diff --quiet abc123 HEAD -- package-lock.json': { status: 1 } });
    expect(code).toBe(0);
    expect(calls.slice(5)).toEqual([
      ['git', 'merge', '--ff-only', '--quiet', 'feature'],
      ['git', 'diff', '--quiet', 'abc123', 'HEAD', '--', 'package-lock.json'],
      ['npm', 'ci'],
      ['npm', 'run', 'verify'],
      ['git', 'push', 'origin', 'main'],
      ['npm', 'run', 'ci:watch', '--', '--quiet'],
    ]);
  });

  it('refuses a dirty main checkout and runs nothing further', () => {
    const { code, logged, calls } = landing('feature', { 'git status --porcelain': { stdout: '?? b.txt\n' } });
    expect(code).toBe(1);
    expect(calls).toEqual([
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['git', 'status', '--porcelain'],
    ]);
    expect(logged.some(line => line.includes('b.txt'))).toBe(true);
  });

  it('refuses a branch that does not hold origin/main and tells the user to rebase', () => {
    const { code, logged, calls } = landing('feature', { 'git merge-base --is-ancestor origin/main feature': { status: 1 } });
    expect(code).toBe(1);
    expect(calls).toEqual([...checkedMain, ['git', 'merge-base', '--is-ancestor', 'origin/main', 'feature']]);
    expect(logged.some(line => line.includes('git rebase origin/main') && line.includes('feature'))).toBe(true);
  });

  it('exits with the code of a failed verify and never pushes', () => {
    const { code, logged, calls } = landing('feature', { 'npm run verify': { status: 3 } });
    expect(code).toBe(3);
    expect(calls.slice(5)).toEqual([
      ['git', 'merge', '--ff-only', '--quiet', 'feature'],
      ['git', 'diff', '--quiet', 'abc123', 'HEAD', '--', 'package-lock.json'],
      ['npm', 'run', 'verify'],
    ]);
    expect(logged.some(line => line.includes('verify') && line.includes('3'))).toBe(true);
  });

  it("reports git failing to compare an unknown branch and exits with git's code", () => {
    const { code, logged, calls } = landing('missing', { 'git merge-base --is-ancestor origin/main missing': { status: 128 } });
    expect(code).toBe(128);
    expect(calls).toEqual([...checkedMain, ['git', 'merge-base', '--is-ancestor', 'origin/main', 'missing']]);
    expect(logged.some(line => line.includes('missing') && line.includes('128'))).toBe(true);
  });

  it('asks for a branch when none is given', () => {
    const logged: string[] = [];
    const run = () => {
      throw new Error('no command may run without a branch');
    };
    expect(land(undefined, run, (line: string) => logged.push(line))).toBe(2);
    expect(logged).toEqual(['usage: npm run land -- <branch>']);
  });

  it.each(['-', '--upload-pack=touch x', '-q'])('refuses the branch name %j, which git would read as an option, before running anything', branch => {
    const { code, logged, calls } = landing(branch);
    expect(code).toBe(2);
    expect(logged).toEqual(['usage: npm run land -- <branch>']);
    expect(calls).toEqual([]);
  });

  it('is the land npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.land).toBe('node scripts/land.mjs');
  });
});
