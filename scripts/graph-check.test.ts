import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { RUNNER, judgeDetectChanges, runGraphCheck } from './graph-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

type Run = (args: string[]) => { status: number | null; stdout: string };

// A runner that answers the index refresh and detect-changes with the given results, recording
// every call.
function runner(detect: { status: number | null; stdout: string }, analyze = { status: 0 as number | null, stdout: 'indexed' }) {
  const calls: string[][] = [];
  const run: Run = args => {
    calls.push(args);
    return args[0] === 'analyze' ? analyze : detect;
  };
  return { run, calls };
}

const check = (run: Run, runnerExists = true) => {
  const logged: string[] = [];
  const code = runGraphCheck(run, (line: string) => logged.push(line), () => runnerExists);
  return { code, logged };
};

const CHANGED = 'Changes: 2 files, 1 symbols\nAffected processes: 0\nRisk level: low\n\nChanged symbols:\n  Const STEPS → scripts/verify.mjs\n';

describe('judgeDetectChanges', () => {
  it('passes a clean tree, a complete change list and hunks that touch no indexed symbol', () => {
    for (const output of ['No changes detected.', CHANGED, 'Diff touched 1 file(s) but no indexed symbols overlap those hunks — not a clean tree.']) {
      expect(judgeDetectChanges(output), output).toEqual([]);
    }
  });

  it('fails a partial result and a capped listing, naming each', () => {
    expect(judgeDetectChanges(`PARTIAL RESULT: a graph query failed.\n${CHANGED}`)).toEqual(['partial: a graph query failed, so changed symbols may be missing']);
    expect(judgeDetectChanges(`LISTING CAPPED: the changed-symbol list was capped.\n${CHANGED}`)).toEqual(['truncated: the changed-symbol list was capped']);
  });

  it('fails output it does not recognise rather than passing it', () => {
    expect(judgeDetectChanges('')).toEqual(['unrecognised detect-changes output']);
    expect(judgeDetectChanges('Something else entirely')).toEqual(['unrecognised detect-changes output']);
  });
});

describe('runGraphCheck', () => {
  it('refreshes the index, then checks every change against it, and exits 0 on a complete result', () => {
    const { run, calls } = runner({ status: 0, stdout: CHANGED });
    const { code, logged } = check(run);
    expect(calls).toEqual([['analyze', '--index-only'], ['detect-changes', '--scope', 'all', '--repo', '.']]);
    expect(code).toBe(0);
    expect(logged.join('\n')).toContain('Risk level: low');
  });

  it('exits 1 naming the reason when the result is partial or capped', () => {
    const { code, logged } = check(runner({ status: 0, stdout: `PARTIAL RESULT: x\n${CHANGED}` }).run);
    expect(code).toBe(1);
    expect(logged.at(-1)).toBe('graph:check: not a complete check: partial: a graph query failed, so changed symbols may be missing');
  });

  it('stops with the failing command\'s exit code when the index refresh or detect-changes fails', () => {
    const analyzeFails = runner({ status: 0, stdout: CHANGED }, { status: 4, stdout: '' });
    expect(check(analyzeFails.run).code).toBe(4);
    expect(analyzeFails.calls).toEqual([['analyze', '--index-only']]);
    expect(check(runner({ status: 2, stdout: '' }).run).code).toBe(2);
    expect(check(runner({ status: null, stdout: '' }).run).code).toBe(1);
  });

  it('exits 1 with the bootstrap command when the local GitNexus runner is missing', () => {
    const { run, calls } = runner({ status: 0, stdout: CHANGED });
    const { code, logged } = check(run, false);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(logged).toEqual([`graph:check: ${RUNNER} is missing; create it with npx gitnexus@latest analyze, then run npm run graph:check again`]);
  });

  it('is the graph:check npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['graph:check']).toBe('node scripts/graph-check.mjs');
  });
});
