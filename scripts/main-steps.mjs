// What npm run land and npm run push share: steps run in the main checkout, each stopping at the
// first failure, naming it, with its exit code.
import { spawnSync } from 'child_process';

export const exited = status => (status === null ? 'with no exit code' : `with exit code ${status}`);

// run(command, args) runs a command in the main checkout and returns { status, stdout }; log
// prints a line, prefixed with the script's name. Each check returns undefined when the script
// may go on, or the exit code to stop with.
export function mainSteps(name, run, log) {
  let failure;
  // Runs one step, returning its result, or logs its failure and returns undefined.
  const step = (command, args) => {
    const result = run(command, args);
    if (result.status !== 0) {
      log(`${name}: ${command} ${args.join(' ')} failed ${exited(result.status)}`);
      failure = result.status ?? 1;
      return undefined;
    }
    return result;
  };
  return {
    step,
    get failure() {
      return failure;
    },
    // Refuses anywhere but on main, and with uncommitted changes, another session's included.
    onCleanMain() {
      const current = step('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!current) return failure;
      if (current.stdout.trim() !== 'main') {
        log(`${name}: run it from the main checkout on main, not on ${current.stdout.trim()}`);
        return 1;
      }
      const status = step('git', ['status', '--porcelain']);
      if (!status) return failure;
      if (status.stdout.trim() !== '') {
        log(`${name}: the main checkout has uncommitted changes; ${name} nothing until they are committed or moved:\n${status.stdout.trimEnd()}`);
        return 1;
      }
      return undefined;
    },
    // Pushes main and watches its CI to the end.
    pushAndWatch() {
      for (const [command, args] of [['git', ['push', 'origin', 'main']], ['npm', ['run', 'ci:watch', '--', '--quiet']]]) {
        if (!step(command, args)) return failure;
      }
      return undefined;
    },
  };
}

// git is read for its output; npm and git push stream theirs to the terminal.
export const runCommand = (command, args) => {
  const capture = command === 'git' && args[0] !== 'push' && args[0] !== 'fetch';
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '' };
};
