import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { STEPS, runSteps } from './verify.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The steps AGENTS.md's sentence on npm run verify names, in its order: each `npm test` or
// `npm run <step>` between "it runs" and "in that order".
function documentedSteps(agents: string): string[] {
  const sentence = agents.match(/Before each commit run `npm run verify`: it runs (.*?) in that order/)?.[1] ?? '';
  return [...sentence.matchAll(/`npm (?:run )?([\w:-]+)`/g)].map(match => match[1]);
}

describe('verify.mjs', () => {
  it('runs the checks every change needs, in order, ending with the CLI rebuild', () => {
    expect(STEPS).toEqual(['test', 'typecheck', 'lockfile:lint', 'roadmap:check', 'duplicates:check', 'graph:check', 'install-cli']);
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts.verify).toBe('node scripts/verify.mjs');
    for (const step of STEPS) expect(packageJson.scripts[step], step).toBeDefined();
  });

  it('is described in AGENTS.md by the same steps in the same order, and a step out of step there is caught', () => {
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(documentedSteps(agents)).toEqual(STEPS);
    const step = '`npm run graph:check` and ';
    expect(agents).toContain(step);
    expect(documentedSteps(agents.replace(step, 'and '))).toEqual(STEPS.filter(name => name !== 'graph:check'));
    expect(documentedSteps(agents.replace(step, '`npm run graph:check`, `npm run extra` and '))).not.toEqual(STEPS);
    expect(documentedSteps('')).toEqual([]);
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
