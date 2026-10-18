import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { STEPS, runSteps } from './verify.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('verify.mjs', () => {
  it('runs the checks every change needs, in order, ending with the CLI rebuild', () => {
    expect(STEPS).toEqual(['test', 'typecheck', 'lockfile:lint', 'roadmap:check', 'install-cli']);
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.verify).toBe('node scripts/verify.mjs');
    for (const step of STEPS) expect(packageJson.scripts[step], step).toBeDefined();
  });

  it('runs every step and exits 0 when all pass', () => {
    const ran: string[] = [];
    const logged: string[] = [];
    expect(runSteps(['a', 'b', 'c'], (step: string) => { ran.push(step); return 0; }, (line: string) => logged.push(line))).toBe(0);
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(logged).toEqual([]);
  });

  it('stops at the first failing step, names it and exits with its code', () => {
    const ran: string[] = [];
    const logged: string[] = [];
    const code = runSteps(['a', 'b', 'c'], (step: string) => { ran.push(step); return step === 'b' ? 3 : 0; }, (line: string) => logged.push(line));
    expect(code).toBe(3);
    expect(ran).toEqual(['a', 'b']);
    expect(logged).toEqual(['verify: npm run b failed with exit code 3; later steps not run: c']);
  });

  it('exits 1 for a step that ends without an exit code, as when a signal stops it', () => {
    const logged: string[] = [];
    expect(runSteps(['a'], () => null, (line: string) => logged.push(line))).toBe(1);
    expect(logged).toEqual(['verify: npm run a failed with no exit code']);
  });
});
