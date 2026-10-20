import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutWithOrigin, gitIn, npmStubbed } from './git-fixture.js';
import { land } from './land.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A main checkout on main with a bare origin, and a branch "feature" one commit ahead of it.
let fixture: ReturnType<typeof checkoutWithOrigin>;
let checkout: string;
let origin: string;
let git: (...args: string[]) => Buffer;
let commitFile: (file: string, content: string) => void;

const head = (ref: string) => git('rev-parse', ref).toString().trim();

beforeEach(() => {
  fixture = checkoutWithOrigin();
  ({ checkout, origin, git, commitFile } = fixture);
  git('checkout', '-q', '-b', 'feature');
  commitFile('a.txt', 'a');
  git('checkout', '-q', 'main');
});

afterEach(() => {
  fixture.remove();
});

const landing = (branch: string | undefined, npmStatus?: Record<string, number>) => {
  const { run, npm } = npmStubbed(checkout, npmStatus);
  const logged: string[] = [];
  const code = land(branch, run, (line: string) => logged.push(line));
  return { code, npm, logged };
};

// Lands feature expecting a refusal that leaves main where it was and runs no npm script; returns
// what was logged.
const refusedWithNothingMoved = () => {
  const before = head('main');
  const { code, npm, logged } = landing('feature');
  expect(code).toBe(1);
  expect(npm).toEqual([]);
  expect(head('main')).toBe(before);
  return logged;
};

describe('land', () => {
  it('fast-forwards main to the branch, verifies, pushes and watches CI', () => {
    const { code, npm, logged } = landing('feature');
    expect(code).toBe(0);
    expect(npm).toEqual(['verify', 'ci:watch -- --quiet']);
    expect(head('main')).toBe(head('feature'));
    expect(gitIn(origin)('rev-parse', 'main').toString().trim()).toBe(head('feature'));
    expect(logged.at(-1)).toBe('land: feature is on origin/main and its CI passed');
  });

  it('runs npm ci first when package-lock.json changes', () => {
    git('checkout', '-q', 'feature');
    commitFile('package-lock.json', '{"lockfileVersion":3}');
    git('checkout', '-q', 'main');
    expect(landing('feature').npm).toEqual(['ci', 'verify', 'ci:watch -- --quiet']);
  });

  it('refuses a checkout with uncommitted changes before anything moves', () => {
    fs.writeFileSync(path.join(checkout, 'b.txt'), 'other session');
    const logged = refusedWithNothingMoved();
    expect(logged[0]).toContain('land: the main checkout has uncommitted changes');
    expect(logged[0]).toContain('b.txt');
  });

  it('refuses to run anywhere but on main', () => {
    git('checkout', '-q', 'feature');
    const { code, logged } = landing('feature');
    expect(code).toBe(1);
    expect(logged).toEqual(['land: run it from the main checkout on main, not on feature']);
  });

  it('refuses a branch that is not a fast-forward of origin/main, naming the rebase', () => {
    commitFile('c.txt', 'c');
    git('push', '-q', 'origin', 'main');
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(refusedWithNothingMoved()).toEqual(['land: feature is not a fast-forward of origin/main; run git rebase origin/main in its worktree, then land it again']);
  });

  it('stops at the first failing step, names it and exits with its code, pushing nothing after a failed verify', () => {
    const { code, npm, logged } = landing('feature', { verify: 3 });
    expect(code).toBe(3);
    expect(npm).toEqual(['verify']);
    expect(gitIn(origin)('rev-parse', 'main').toString().trim()).not.toBe(head('feature'));
    expect(logged.at(-1)).toBe('land: npm run verify failed with exit code 3');
  });

  it('names a branch git does not know, and asks for one when none is given', () => {
    expect(landing('missing').logged.at(-1)).toBe('land: git merge-base --is-ancestor origin/main missing failed with exit code 128');
    const usage = landing(undefined);
    expect(usage.code).toBe(2);
    expect(usage.logged).toEqual(['usage: npm run land -- <branch>']);
  });

  it('is the land npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.land).toBe('node scripts/land.mjs');
  });
});
