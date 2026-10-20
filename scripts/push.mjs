#!/usr/bin/env node
// Pushes main and watches its CI (npm run push): on main with a clean tree, git push origin main,
// then npm run ci:watch -- --quiet. Stops at the first failing step, naming it, with its exit
// code; a checkout with uncommitted changes, another session's included, is refused before
// anything is pushed.
import { mainSteps, runCommand } from './main-steps.mjs';
import { runDirectly } from './script-support.mjs';

const USAGE = 'usage: npm run push';

// run(command, args) runs a command in the main checkout and returns { status, stdout }; log
// prints a line. Returns the exit code.
export function push(args, run, log) {
  if (args.length !== 0) {
    log(USAGE);
    return 2;
  }
  const steps = mainSteps('push', run, log);
  const stopped = steps.onCleanMain() ?? steps.pushAndWatch();
  if (stopped !== undefined) return stopped;
  log('push: main is on origin/main and its CI passed');
  return 0;
}

if (runDirectly(import.meta.url)) {
  process.exitCode = push(process.argv.slice(2), runCommand, line => process.stderr.write(`${line}\n`));
}
