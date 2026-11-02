#!/usr/bin/env node
// The GitNexus check every commit needs (npm run graph:check, part of npm run verify): refresh
// the index, then map every change in the working tree and index to its symbols and flows with
// detect-changes. detect-changes reads hunks against the index, so without the refresh it names
// symbols at stale line numbers. A partial or capped result is not a complete check and fails,
// as does output this script does not recognise, so a changed tool can never pass silently.
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

// The count in cypher's answer to COUNT_EMPTY_IDS, or null when it holds none: stdout is JSON
// whose markdown is a one-column table of header, separator and the count's row.
function parseCount(output) {
  try {
    const rows = JSON.parse(output).markdown.trim().split('\n');
    const match = /^\|\s*(\d+)\s*\|$/.exec(rows.at(-1).trim());
    return rows.length === 3 && match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// run(args) runs the GitNexus runner with args and returns { status, stdout, stderr }; log prints
// a line; runnerExists tells whether the runner at runner is there. Returns the exit code. The
// output of the index builds and the empty-id counts (banner, index statistics, warnings) is
// printed only when one fails, so a passing check ends in detect-changes' risk level and changed
// symbols.
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
