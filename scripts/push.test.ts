import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { cleanMain, scriptedRun } from './git-fixture.js';
import { push } from './push.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// push run against scripted git and npm answers: its exit code, the commands it issued and the lines it logged.
const pushing = (args: string[], answers: Parameters<typeof scriptedRun>[0]) => {
  const { run, calls } = scriptedRun(answers);
  const logged: string[] = [];
  const code = push(args, run, (line: string) => logged.push(line));
  return { code, calls, logged };
};

const branchRead = ['git', 'rev-parse', '--abbrev-ref', 'HEAD'];
const statusRead = ['git', 'status', '--porcelain'];

describe('push', () => {
  it('pushes main, then watches CI quietly, and succeeds', () => {
    const result = pushing([], cleanMain);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([branchRead, statusRead, ['git', 'push', 'origin', 'main'], ['npm', 'run', 'ci:watch', '--', '--quiet']]);
  });

  it('refuses a dirty main checkout and runs neither push nor CI watch', () => {
    const result = pushing([], { ...cleanMain, 'git status --porcelain': { stdout: '?? b.txt\n' } });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([branchRead, statusRead]);
    expect(result.logged.join('\n')).toContain('?? b.txt');
  });

  it('refuses a branch other than main and runs nothing further', () => {
    const result = pushing([], { ...cleanMain, 'git rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' } });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([branchRead]);
    expect(result.logged.join('\n')).toContain('feature');
  });

  it('a failed git push returns its exit code and skips the CI watch', () => {
    const result = pushing([], { ...cleanMain, 'git push origin main': { status: 128 } });
    expect(result.code).toBe(128);
    expect(result.calls.some(([command]) => command === 'npm')).toBe(false);
    expect(result.logged.join('\n')).toContain('git push origin main');
  });

  it("a failed CI watch makes push exit with the watch's code", () => {
    const result = pushing([], { ...cleanMain, 'npm run ci:watch -- --quiet': { status: 7 } });
    expect(result.code).toBe(7);
    expect(result.logged.join('\n')).toContain('ci:watch');
  });

  it('rejects any argument with exit code 2 and runs no command', () => {
    const result = pushing(['main'], cleanMain);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.logged).toHaveLength(1);
  });

  it('is the push npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.push).toBe('node scripts/push.mjs');
  });
});
