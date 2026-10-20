#!/usr/bin/env node
// The checks every change runs before it is committed, as one command (npm run verify): each
// npm script in order, stopping at the first that fails with its exit code. The CLI rebuild
// comes last, since the CLIs are links into dist and a change not rebuilt is not what they run.
import { spawnSync } from 'child_process';
import { runDirectly } from './script-support.mjs';

export const STEPS = ['test', 'typecheck', 'lockfile:lint', 'roadmap:check', 'install-cli'];

// Runs each step through run(step), which returns its exit code (null when it ended without
// one, as when a signal stops it). Returns 0 when every step passes, else the failing step's
// exit code (1 without one), after logging which step failed and which were not run.
export function runSteps(steps, run, log) {
  for (const [index, step] of steps.entries()) {
    const status = run(step);
    if (status === 0) continue;
    const rest = steps.slice(index + 1);
    const outcome = status === null ? 'with no exit code' : `with exit code ${status}`;
    log(`verify: npm run ${step} failed ${outcome}${rest.length > 0 ? `; later steps not run: ${rest.join(', ')}` : ''}`);
    return status ?? 1;
  }
  return 0;
}

const npmRun = step => {
  const result = spawnSync('npm', ['run', step], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status;
};

if (runDirectly(import.meta.url)) {
  process.exitCode = runSteps(STEPS, npmRun, line => process.stderr.write(`${line}\n`));
}
