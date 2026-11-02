import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { RUNNER, judgeDetectChanges, runGraphCheck, runnerFor } from './graph-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

type Result = { status: number | null; stdout: string; stderr?: string };
type Run = (args: string[]) => Result;

// The cypher command's answer to the empty-id count, as it prints it: the banner on stderr, the
// JSON with its markdown table on stdout.
const emptyIds = (count: number): Result => ({
  status: 0,
  stdout: JSON.stringify({ markdown: `| COUNT(n._ID) |\n| --- |\n| ${count} |`, row_count: 1, staleness: { status: 'current' } }, null, 2),
  stderr: '\n  GitNexus Cypher (1.6.12)',
});

const REFRESH = ['analyze', '--index-only'];
const COUNT = ['cypher', "MATCH (n) WHERE n.id = '' RETURN count(n)", '--repo', '.'];
const REBUILD = ['analyze', '--index-only', '--force', '--no-parse-cache'];
const DETECT = ['detect-changes', '--scope', 'all', '--repo', '.'];

// A runner that answers both index builds with analyze, detect-changes with detect, and each
// cypher count with the next of counts, the last one repeating; it records every call.
function runner(detect: Result, analyze: Result = { status: 0, stdout: 'indexed', stderr: 'analyzer warning' }, counts: Result[] = [emptyIds(0)]) {
  const calls: string[][] = [];
  const remaining = [...counts];
  const run: Run = args => {
    calls.push(args);
    if (args[0] === 'cypher') return remaining.length > 1 ? remaining.shift()! : remaining[0];
    return args[0] === 'analyze' ? analyze : detect;
  };
  return { run, calls };
}

const check = (run: Run, runnerExists = true, runnerPath?: string) => {
  const logged: string[] = [];
  const code = runGraphCheck(run, (line: string) => logged.push(line), () => runnerExists, runnerPath);
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
  it('refreshes the index, finds no node with an empty id, then checks every change against it, and exits 0 on a complete result', () => {
    const { run, calls } = runner({ status: 0, stdout: CHANGED });
    const { code, logged } = check(run);
    expect(calls).toEqual([REFRESH, COUNT, DETECT]);
    expect(code).toBe(0);
    expect(logged.join('\n')).toContain('Risk level: low');
  });

  it('rebuilds the index once when nodes have an empty id, and passes when the rebuild clears them', () => {
    const { run, calls } = runner({ status: 0, stdout: CHANGED, stderr: 'detect banner' }, undefined, [emptyIds(837), emptyIds(0)]);
    const { code, logged } = check(run);
    expect(calls).toEqual([REFRESH, COUNT, REBUILD, COUNT, DETECT]);
    expect(code).toBe(0);
    expect(logged).toEqual([
      'graph:check: 837 nodes have an empty id; rebuilding the index with analyze --index-only --force --no-parse-cache',
      'detect banner',
      CHANGED.trimEnd(),
    ]);
  });

  it('fails naming the count when nodes with an empty id survive the rebuild, without running detect-changes', () => {
    const { run, calls } = runner({ status: 0, stdout: CHANGED }, undefined, [emptyIds(837), emptyIds(12)]);
    const { code, logged } = check(run);
    expect(calls).toEqual([REFRESH, COUNT, REBUILD, COUNT]);
    expect(code).toBe(1);
    expect(logged.at(-1)).toBe('graph:check: 12 nodes still have an empty id after analyze --index-only --force --no-parse-cache');
  });

  it("fails with the cypher command's exit code and output when the count query fails", () => {
    const failed = { status: 5, stdout: '{\n  "error": "Prepare failed"\n}', stderr: 'cypher banner' };
    const { run, calls } = runner({ status: 0, stdout: CHANGED }, undefined, [failed]);
    const { code, logged } = check(run);
    expect(calls).toEqual([REFRESH, COUNT]);
    expect(code).toBe(5);
    expect(logged).toEqual(['cypher banner', '{\n  "error": "Prepare failed"\n}', 'graph:check: cypher failed with exit code 5']);
  });

  it('fails on a count answer it does not recognise rather than reading it as zero', () => {
    const noRow = { status: 0, stdout: JSON.stringify({ markdown: '| COUNT(n._ID) |\n| --- |', row_count: 0 }) };
    for (const answer of [noRow, { status: 0, stdout: 'not json' }, { status: 0, stdout: '{"rows": []}' }]) {
      const { run, calls } = runner({ status: 0, stdout: CHANGED }, undefined, [answer]);
      const { code, logged } = check(run);
      expect(calls, answer.stdout).toEqual([REFRESH, COUNT]);
      expect(code).toBe(1);
      expect(logged.at(-1)).toBe('graph:check: unrecognised cypher output for the count of nodes with an empty id');
    }
  });

  it("prints only detect-changes' answer when the index refresh succeeds, leaving out the analyzer's output", () => {
    const { logged } = check(runner({ status: 0, stdout: CHANGED, stderr: 'detect banner' }).run);
    expect(logged).toEqual(['detect banner', CHANGED.trimEnd()]);
  });

  it("prints the analyzer's output and stderr when the index refresh fails", () => {
    const { code, logged } = check(runner({ status: 0, stdout: CHANGED }, { status: 3, stdout: 'progress', stderr: 'boom' }).run);
    expect(code).toBe(3);
    expect(logged).toEqual(['boom', 'progress', 'graph:check: analyze failed with exit code 3']);
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

  it("from a linked worktree, uses the main checkout's runner, which is what it names when missing", () => {
    expect(runnerFor(null)).toBe(RUNNER);
    expect(runnerFor('/repos/main')).toBe(path.join('/repos/main', RUNNER));
    const { logged } = check(runner({ status: 0, stdout: CHANGED }).run, false, runnerFor('/repos/main'));
    expect(logged[0]).toContain(`graph:check: ${path.join('/repos/main', RUNNER)} is missing`);
  });

  it('is the graph:check npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['graph:check']).toBe('node scripts/graph-check.mjs');
  });
});
