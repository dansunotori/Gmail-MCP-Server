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

// run(args) runs the GitNexus runner with args and returns { status, stdout, stderr }; log prints
// a line; runnerExists tells whether the runner at runner is there. Returns the exit code. The
// analyzer's output (banner, index statistics, warnings) is printed only when the refresh fails,
// so a passing check ends in detect-changes' risk level and changed symbols.
export function runGraphCheck(run, log, runnerExists, runner = RUNNER) {
  if (!runnerExists()) {
    log(`graph:check: ${runner} is missing; create it with npx gitnexus@latest analyze, then run npm run graph:check again`);
    return 1;
  }
  for (const args of [['analyze', '--index-only'], ['detect-changes', '--scope', 'all', '--repo', '.']]) {
    const { status, stdout, stderr } = run(args);
    if (args[0] !== 'analyze' || status !== 0) {
      for (const text of [stderr, stdout]) if (text) log(text.trimEnd());
    }
    if (status !== 0) {
      log(`graph:check: ${args[0]} failed ${status === null ? 'with no exit code' : `with exit code ${status}`}`);
      return status ?? 1;
    }
    if (args[0] === 'detect-changes') {
      const reasons = judgeDetectChanges(stdout);
      if (reasons.length > 0) {
        log(`graph:check: not a complete check: ${reasons.join('; ')}`);
        return 1;
      }
    }
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
