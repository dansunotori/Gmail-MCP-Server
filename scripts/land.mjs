#!/usr/bin/env node
// Lands a worktree branch on main, run from the main checkout (npm run land -- <branch>): on main
// with a clean tree, fetch, refuse a branch that is not a fast-forward of origin/main,
// fast-forward main to it, run npm ci when package-lock.json changed, then npm run verify, push
// and npm run ci:watch -- --quiet. Stops at the first failing step, naming it, with its exit code; a
// checkout with uncommitted changes, another session's included, is refused before anything
// moves.
import { spawnSync } from 'child_process';
import { runDirectly } from './script-support.mjs';

const USAGE = 'usage: npm run land -- <branch>';

const exited = status => (status === null ? 'with no exit code' : `with exit code ${status}`);

// run(command, args) runs a command in the main checkout and returns { status, stdout }; log
// prints a line. Returns the exit code.
export function land(branch, run, log) {
  if (!branch) {
    log(USAGE);
    return 2;
  }
  // Runs one step, returning its result, or logs its failure and returns undefined.
  let failure;
  const step = (command, args) => {
    const result = run(command, args);
    if (result.status !== 0) {
      log(`land: ${command} ${args.join(' ')} failed ${exited(result.status)}`);
      failure = result.status ?? 1;
      return undefined;
    }
    return result;
  };

  const current = step('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!current) return failure;
  if (current.stdout.trim() !== 'main') {
    log(`land: run it from the main checkout on main, not on ${current.stdout.trim()}`);
    return 1;
  }
  const status = step('git', ['status', '--porcelain']);
  if (!status) return failure;
  if (status.stdout.trim() !== '') {
    log(`land: the main checkout has uncommitted changes; land nothing until they are committed or moved:\n${status.stdout.trimEnd()}`);
    return 1;
  }
  if (!step('git', ['fetch', 'origin'])) return failure;

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
  if (!before) return failure;
  if (!step('git', ['merge', '--ff-only', '--quiet', branch])) return failure;
  const lockfile = run('git', ['diff', '--quiet', before.stdout.trim(), 'HEAD', '--', 'package-lock.json']);
  if (lockfile.status === 1 && !step('npm', ['ci'])) return failure;
  if (lockfile.status !== 0 && lockfile.status !== 1) {
    log(`land: git diff of package-lock.json failed ${exited(lockfile.status)}`);
    return lockfile.status ?? 1;
  }
  for (const [command, args] of [['npm', ['run', 'verify']], ['git', ['push', 'origin', 'main']], ['npm', ['run', 'ci:watch', '--', '--quiet']]]) {
    if (!step(command, args)) return failure;
  }
  log(`land: ${branch} is on origin/main and its CI passed`);
  return 0;
}

// git is read for its output; npm and git push stream theirs to the terminal.
const runCommand = (command, args) => {
  const capture = command === 'git' && args[0] !== 'push' && args[0] !== 'fetch';
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '' };
};

if (runDirectly(import.meta.url)) {
  process.exitCode = land(process.argv[2], runCommand, line => process.stderr.write(`${line}\n`));
}
