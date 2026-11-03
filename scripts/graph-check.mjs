#!/usr/bin/env node
// The GitNexus check every commit needs (npm run graph:check, part of npm run verify): refresh
// the index, then map every change in the working tree and index to its symbols and flows with
// detect-changes. detect-changes reads hunks against the index, so without the refresh it names
// symbols at stale line numbers. A partial or capped result is not a complete check and fails,
// as does output this script does not recognise, so a changed tool can never pass silently. On a
// HIGH or CRITICAL rating it prints the ordered steps of each flow detect-changes lists.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { mainCheckoutOf, runDirectly } from './script-support.mjs';

export const RUNNER = '.gitnexus/run.cjs';

// The runner to use: this checkout's, or from a linked worktree the main checkout's, since the
// runner is untracked and only the main checkout has one. It runs against the current directory.
export const runnerFor = mainCheckout => (mainCheckout ? path.join(mainCheckout, RUNNER) : RUNNER);

// The opening of each complete answer detect-changes gives, and the marker of each incomplete one.
const COMPLETE = ['No changes detected.', 'Changes:', 'Diff touched'];
const INCOMPLETE = [
  ['PARTIAL RESULT:', 'partial: a graph query failed, so changed symbols may be missing'],
  ['LISTING CAPPED:', 'truncated: the changed-symbol list was capped'],
];

// Why the detect-changes output is not a complete check, one reason each; none when it is.
export function judgeDetectChanges(output) {
  const reasons = INCOMPLETE.filter(([marker]) => output.includes(marker)).map(([, reason]) => reason);
  if (reasons.length === 0 && !COMPLETE.some(opening => output.includes(opening))) {
    reasons.push('unrecognised detect-changes output');
  }
  return reasons;
}

// An incremental refresh keeps the rows of unchanged files, and those can hold nodes whose id is
// empty; impact on any of them walks upstream from all of them at once, so detect-changes rates
// an unrelated change CRITICAL. Only a forced rebuild without the parse cache clears them.
const REFRESH = ['analyze', '--index-only'];
const REBUILD = ['analyze', '--index-only', '--force', '--no-parse-cache'];
const COUNT_EMPTY_IDS = ['cypher', "MATCH (n) WHERE n.id = '' RETURN count(n)", '--repo', '.'];
const DETECT = ['detect-changes', '--scope', 'all', '--repo', '.'];

// The cells of each row in a cypher answer, or null when it is not one: stdout is JSON whose
// markdown is a table of header, separator and rows, or a bare [] when no row matched.
function parseRows(output) {
  if (output.trim() === '[]') return [];
  try {
    const lines = JSON.parse(output).markdown.trim().split('\n');
    if (lines.length < 2) return null;
    const rows = lines.slice(2).map(line => /^\|(.*)\|$/.exec(line.trim())?.[1].split('|').map(cell => cell.trim()));
    return rows.every(Boolean) ? rows : null;
  } catch {
    return null;
  }
}

// The count in cypher's answer to COUNT_EMPTY_IDS, or null when it holds none.
function parseCount(output) {
  const rows = parseRows(output);
  return rows?.length === 1 && rows[0].length === 1 && /^\d+$/.test(rows[0][0]) ? Number(rows[0][0]) : null;
}

// A HIGH or CRITICAL rating has to be traced flow by flow before a commit, so each flow
// detect-changes lists under such a rating is printed as its steps.
const TRACED_RISKS = ['high', 'critical'];
const FLOW_LINE = /^ {2}• (.+) \(\d+ steps?\) — changed: /;

const stepsQuery = label => [
  'cypher',
  `MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.label = '${label.replace(/[\\']/g, '\\$&')}' RETURN r.step, s.id, s.filePath ORDER BY r.step`,
  '--repo',
  '.',
];

// The labels of the flows detect-changes lists, when it rates the risk HIGH or CRITICAL; none otherwise.
function tracedFlows(output) {
  const risk = /^Risk level: (\w+)$/m.exec(output)?.[1].toLowerCase();
  if (!TRACED_RISKS.includes(risk)) return [];
  return output.split('\n').flatMap(line => FLOW_LINE.exec(line)?.[1] ?? []);
}

// run(args) runs the GitNexus runner with args and returns { status, stdout, stderr }; log prints
// a line; runnerExists tells whether the runner at runner is there. Returns the exit code. The
// output of the index builds and the empty-id counts (banner, index statistics, warnings) is
// printed only when one fails, so a passing check ends in detect-changes' risk level, changed
// symbols and affected flows, then the steps of those flows on a HIGH or CRITICAL rating.
export function runGraphCheck(run, log, runnerExists, runner = RUNNER) {
  if (!runnerExists()) {
    log(`graph:check: ${runner} is missing; create it with npx gitnexus@latest analyze, then run npm run graph:check again`);
    return 1;
  }
  // Runs args, printing its output when shown or failing; returns { code, stdout }, code 0 on success.
  const step = (args, shown = false) => {
    const { status, stdout, stderr } = run(args);
    if (shown || status !== 0) {
      for (const text of [stderr, stdout]) if (text) log(text.trimEnd());
    }
    if (status === 0) return { code: 0, stdout };
    log(`graph:check: ${args[0]} failed ${status === null ? 'with no exit code' : `with exit code ${status}`}`);
    return { code: status ?? 1, stdout };
  };
  // Returns { code, count }: the number of nodes with an empty id, code 0 when it was read.
  const countEmptyIds = () => {
    const { code, stdout } = step(COUNT_EMPTY_IDS);
    if (code !== 0) return { code };
    const count = parseCount(stdout);
    if (count !== null) return { code: 0, count };
    log(stdout.trimEnd());
    log('graph:check: unrecognised cypher output for the count of nodes with an empty id');
    return { code: 1 };
  };

  const refresh = step(REFRESH);
  if (refresh.code !== 0) return refresh.code;
  let empty = countEmptyIds();
  if (empty.code !== 0) return empty.code;
  if (empty.count > 0) {
    log(`graph:check: ${empty.count} nodes have an empty id; rebuilding the index with ${REBUILD.join(' ')}`);
    const rebuild = step(REBUILD);
    if (rebuild.code !== 0) return rebuild.code;
    empty = countEmptyIds();
    if (empty.code !== 0) return empty.code;
    if (empty.count > 0) {
      log(`graph:check: ${empty.count} nodes still have an empty id after ${REBUILD.join(' ')}`);
      return 1;
    }
  }
  const detect = step(DETECT, true);
  if (detect.code !== 0) return detect.code;
  // The steps only inform the commit; a query that fails or answers unrecognisably is named and
  // leaves the exit code to detect-changes' answer.
  for (const label of tracedFlows(detect.stdout)) {
    const { code, stdout } = step(stepsQuery(label));
    if (code !== 0) continue;
    const rows = parseRows(stdout);
    if (rows === null || rows.some(cells => cells.length !== 3)) {
      log(stdout.trimEnd());
      log(`graph:check: unrecognised cypher output for the steps of flow ${label}`);
    } else if (rows.length === 0) {
      log(`graph:check: flow ${label} not found`);
    } else {
      log(`graph:check: steps of flow ${label}:`);
      for (const [index, id, file] of rows) log(`  ${index}. ${id} (${file})`);
    }
  }
  const reasons = judgeDetectChanges(detect.stdout);
  if (reasons.length > 0) {
    log(`graph:check: not a complete check: ${reasons.join('; ')}`);
    return 1;
  }
  return 0;
}

if (runDirectly(import.meta.url)) {
  const runner = runnerFor(mainCheckoutOf(process.cwd()));
  const runRunner = args => {
    const result = spawnSync('node', [runner, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  process.exitCode = runGraphCheck(runRunner, line => process.stdout.write(`${line}\n`), () => fs.existsSync(runner), runner);
}
