import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutWithOrigin, gitIn, npmStubbed } from './git-fixture.js';
import { push } from './push.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A main checkout one commit ahead of its bare origin.
let fixture: ReturnType<typeof checkoutWithOrigin>;
beforeEach(() => {
  fixture = checkoutWithOrigin();
  fixture.commitFile('a.txt', 'a');
});
afterEach(() => fixture.remove());

const local = () => fixture.git('rev-parse', 'main').toString().trim();
const remote = () => gitIn(fixture.origin)('rev-parse', 'main').toString().trim();

const pushing = (args: string[] = [], npmStatus?: Record<string, number>) => {
  const { run, npm } = npmStubbed(fixture.checkout, npmStatus);
  const logged: string[] = [];
  return { code: push(args, run, (line: string) => logged.push(line)), npm, logged };
};

describe('push', () => {
  it('pushes main and watches its CI quietly', () => {
    const result = pushing();
    expect(result.code).toBe(0);
    expect(result.npm).toEqual(['ci:watch -- --quiet']);
    expect(remote()).toBe(local());
    expect(result.logged).toEqual(['push: main is on origin/main and its CI passed']);
  });

  it('refuses a checkout with uncommitted changes, pushing nothing', () => {
    const before = remote();
    fs.writeFileSync(path.join(fixture.checkout, 'b.txt'), 'other session');
    const result = pushing();
    expect(result.code).toBe(1);
    expect(result.npm).toEqual([]);
    expect(remote()).toBe(before);
    expect(result.logged).toEqual(['push: the main checkout has uncommitted changes; push nothing until they are committed or moved:\n?? b.txt']);
  });

  it('refuses to run anywhere but on main', () => {
    fixture.git('checkout', '-q', '-b', 'feature');
    expect(pushing()).toMatchObject({ code: 1, npm: [], logged: ['push: run it from the main checkout on main, not on feature'] });
  });

  it('stops at a failed push without watching CI', () => {
    fixture.git('remote', 'set-url', 'origin', path.join(fixture.origin, 'missing'));
    const result = pushing();
    expect(result.code).toBe(128);
    expect(result.npm).toEqual([]);
    expect(result.logged).toEqual(['push: git push origin main failed with exit code 128']);
  });

  it('exits with the code of a failed CI watch, naming it', () => {
    const result = pushing([], { 'ci:watch': 1 });
    expect(result.code).toBe(1);
    expect(remote()).toBe(local());
    expect(result.logged).toEqual(['push: npm run ci:watch -- --quiet failed with exit code 1']);
  });

  it('takes no arguments', () => {
    expect(pushing(['main'])).toMatchObject({ code: 2, npm: [], logged: ['usage: npm run push'] });
  });

  it('is the push npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.push).toBe('node scripts/push.mjs');
  });
});
