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

// The cypher command's answer to a flow's steps query: the JSON with its markdown table, or the
// bare [] it prints when no row matches.
const flowSteps = (rows: [number, string, string][]): Result => ({
  status: 0,
  stdout: rows.length === 0
    ? '[]'
    : JSON.stringify({
      markdown: ['| r.step | s.id | s.filePath |', '| --- | --- | --- |', ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n'),
      row_count: rows.length,
      staleness: { status: 'current' },
    }, null, 2),
  stderr: '\n  GitNexus Cypher (1.6.12)',
});

const REFRESH = ['analyze', '--index-only'];
const COUNT = ['cypher', "MATCH (n) WHERE n.id = '' RETURN count(n)", '--repo', '.'];
const REBUILD = ['analyze', '--index-only', '--force', '--no-parse-cache'];
const DETECT = ['detect-changes', '--scope', 'all', '--repo', '.'];
const STEPS = (quotedLabel: string) => [
  'cypher',
  `MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.label = '${quotedLabel}' RETURN r.step, s.id, s.filePath ORDER BY r.step`,
  '--repo',
  '.',
];

// A runner that answers both index builds with analyze, detect-changes with detect, each
// cypher count with the next of counts, the last one repeating, and each other cypher query
// with its answer in steps; it records every call.
function runner(
  detect: Result,
  analyze: Result = { status: 0, stdout: 'indexed', stderr: 'analyzer warning' },
  counts: Result[] = [emptyIds(0)],
  steps: Record<string, Result> = {},
) {
  const calls: string[][] = [];
  const remaining = [...counts];
  const run: Run = args => {
    calls.push(args);
    if (args[0] === 'cypher' && args[1] !== COUNT[1]) return steps[args[1]] ?? { status: 9, stdout: '', stderr: `unexpected query ${args[1]}` };
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

// detect-changes' answer for a change that reaches flows, rated risk, listing two of them.
const reachingFlows = (risk: string, affected: number) => [
  'Changes: 1 files, 2 symbols',
  `Affected processes: ${affected}`,
  `Risk level: ${risk}`,
  '',
  'Changed symbols:',
  '  Function runGraphCheck → scripts/graph-check.mjs',
  '  Function step → scripts/graph-check.mjs',
  '',
  'Affected execution flows:',
  '  • RunGraphCheck → Step (2 steps) — changed: runGraphCheck, step',
  "  • It's → Done (1 step) — changed: runGraphCheck",
  ...(affected > 2 ? [`... and ${affected - 2} more`] : []),
].join('\n');

const STEP_FLOW = STEPS('RunGraphCheck → Step');
const QUOTED_FLOW = STEPS("It\\'s → Done");
const STEP_FLOW_ROWS = flowSteps([
  [1, 'Function:scripts/graph-check.mjs:runGraphCheck', 'scripts/graph-check.mjs'],
  [2, 'Function:scripts/graph-check.mjs:runGraphCheck.step@65:2', 'scripts/graph-check.mjs'],
]);
const QUOTED_FLOW_ROWS = flowSteps([[1, 'Function:src/done.ts:done', 'src/done.ts']]);
const STEP_FLOW_LINES = [
  'graph:check: steps of flow RunGraphCheck → Step:',
  '  1. Function:scripts/graph-check.mjs:runGraphCheck (scripts/graph-check.mjs)',
  '  2. Function:scripts/graph-check.mjs:runGraphCheck.step@65:2 (scripts/graph-check.mjs)',
];

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

  it('prints no flow steps on a low or medium rating', () => {
    for (const detect of [CHANGED, reachingFlows('medium', 2)]) {
      const { run, calls } = runner({ status: 0, stdout: detect });
      const { code, logged } = check(run);
      expect(calls, detect).toEqual([REFRESH, COUNT, DETECT]);
      expect(code).toBe(0);
      expect(logged).toEqual([detect.trimEnd()]);
    }
  });

  it('prints the steps of each listed flow in order, with their files, on a high or critical rating', () => {
    for (const [risk, affected] of [['high', 7], ['critical', 16]] as const) {
      const detect = reachingFlows(risk, affected);
      const { run, calls } = runner({ status: 0, stdout: detect }, undefined, undefined, { [STEP_FLOW[1]]: STEP_FLOW_ROWS, [QUOTED_FLOW[1]]: QUOTED_FLOW_ROWS });
      const { code, logged } = check(run);
      expect(calls, risk).toEqual([REFRESH, COUNT, DETECT, STEP_FLOW, QUOTED_FLOW]);
      expect(code).toBe(0);
      expect(logged).toEqual([detect, ...STEP_FLOW_LINES, "graph:check: steps of flow It's → Done:", '  1. Function:src/done.ts:done (src/done.ts)']);
    }
  });

  it('names a flow the steps query does not find as not found', () => {
    const detect = reachingFlows('high', 7);
    const { run } = runner({ status: 0, stdout: detect }, undefined, undefined, { [STEP_FLOW[1]]: STEP_FLOW_ROWS, [QUOTED_FLOW[1]]: flowSteps([]) });
    const { code, logged } = check(run);
    expect(code).toBe(0);
    expect(logged).toEqual([detect, ...STEP_FLOW_LINES, "graph:check: flow It's → Done not found"]);
  });

  it("keeps detect-changes' exit code when a steps query fails or answers unrecognisably, naming each", () => {
    const detect = reachingFlows('high', 7);
    const failed = { status: 5, stdout: '{\n  "error": "Prepare failed"\n}', stderr: 'cypher banner' };
    const { run, calls } = runner({ status: 0, stdout: detect }, undefined, undefined, { [STEP_FLOW[1]]: failed, [QUOTED_FLOW[1]]: { status: 0, stdout: 'not json' } });
    const { code, logged } = check(run);
    expect(calls).toEqual([REFRESH, COUNT, DETECT, STEP_FLOW, QUOTED_FLOW]);
    expect(code).toBe(0);
    expect(logged).toEqual([
      detect,
      'cypher banner',
      '{\n  "error": "Prepare failed"\n}',
      'graph:check: cypher failed with exit code 5',
      'not json',
      "graph:check: unrecognised cypher output for the steps of flow It's → Done",
    ]);
  });

  it('prints the listed flows of a capped high rating before failing it as incomplete', () => {
    const detect = `LISTING CAPPED: the changed-symbol list was capped.\n\n${reachingFlows('high', 7)}`;
    const { run } = runner({ status: 0, stdout: detect }, undefined, undefined, { [STEP_FLOW[1]]: STEP_FLOW_ROWS, [QUOTED_FLOW[1]]: QUOTED_FLOW_ROWS });
    const { code, logged } = check(run);
    expect(code).toBe(1);
    expect(logged.slice(1, 4)).toEqual(STEP_FLOW_LINES);
    expect(logged.at(-1)).toBe('graph:check: not a complete check: truncated: the changed-symbol list was capped');
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
