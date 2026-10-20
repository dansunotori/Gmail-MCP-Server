#!/usr/bin/env node
// Lands a worktree branch on main, run from the main checkout (npm run land -- <branch>): on main
// with a clean tree, fetch, refuse a branch that is not a fast-forward of origin/main,
// fast-forward main to it, run npm ci when package-lock.json changed, then npm run verify, push
// and npm run ci:watch -- --quiet. Stops at the first failing step, naming it, with its exit code; a
// checkout with uncommitted changes, another session's included, is refused before anything
// moves.
import { exited, mainSteps, runCommand } from './main-steps.mjs';
import { runDirectly } from './script-support.mjs';

const USAGE = 'usage: npm run land -- <branch>';

// run(command, args) runs a command in the main checkout and returns { status, stdout }; log
// prints a line. Returns the exit code.
export function land(branch, run, log) {
  if (!branch) {
    log(USAGE);
    return 2;
  }
  const steps = mainSteps('land', run, log);
  const { step } = steps;
  const refused = steps.onCleanMain();
  if (refused !== undefined) return refused;
  if (!step('git', ['fetch', 'origin'])) return steps.failure;

  // 0: the branch holds origin/main; 1: it does not; anything else is git failing.
  const ancestry = run('git', ['merge-base', '--is-ancestor', 'origin/main', branch]);
  if (ancestry.status === 1) {
    log(`land: ${branch} is not a fast-forward of origin/main; run git rebase origin/main in its worktree, then land it again`);
    return 1;
  }
  if (ancestry.status !== 0) {
    log(`land: git merge-base --is-ancestor origin/main ${branch} failed ${exited(ancestry.status)}`);
    return ancestry.status ?? 1;
  }

  const before = step('git', ['rev-parse', 'HEAD']);
  if (!before) return steps.failure;
  if (!step('git', ['merge', '--ff-only', '--quiet', branch])) return steps.failure;
  const lockfile = run('git', ['diff', '--quiet', before.stdout.trim(), 'HEAD', '--', 'package-lock.json']);
  if (lockfile.status === 1 && !step('npm', ['ci'])) return steps.failure;
  if (lockfile.status !== 0 && lockfile.status !== 1) {
    log(`land: git diff of package-lock.json failed ${exited(lockfile.status)}`);
    return lockfile.status ?? 1;
  }
  if (!step('npm', ['run', 'verify'])) return steps.failure;
  const unwatched = steps.pushAndWatch();
  if (unwatched !== undefined) return unwatched;
  log(`land: ${branch} is on origin/main and its CI passed`);
  return 0;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = land(process.argv[2], runCommand, line => process.stderr.write(`${line}\n`));
}
