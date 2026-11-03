// What the scripts in this directory share about being run.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Runs a command and returns its stdout, as text unless options.encoding is 'buffer', with stdin
// fed from options.input and stderr captured; throws as execFileSync does when the command
// cannot start or exits non-zero. The scripts here take it as their runner, so a test can pass
// one that answers by command line instead.
/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ encoding?: 'utf8' | 'buffer', cwd?: string, env?: NodeJS.ProcessEnv, input?: string, maxBuffer?: number }} [options]
 * @returns {any}
 */
export const runCaptured =(command, args, { encoding = 'utf8', ...options } = {}) =>
  execFileSync(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options, ...(encoding === 'buffer' ? {} : { encoding }) });

// The process a script runs as, for a main(args, io) that takes it: stdin read whole, stdout
// and stderr written, the runner, the environment and the working directory.
export const processIo = {
  stdin: () => fs.readFileSync(0, 'utf8'),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  run: runCaptured,
  env: process.env,
  cwd: process.cwd(),
};

// The directory holding the common git dir, from the output of `git rev-parse
// --path-format=absolute --git-dir --git-common-dir`, when the two differ, as in a linked
// worktree, whose common dir sits in the main checkout; null when they are the same.
export function checkoutOfGitDirs(output) {
  const [gitDir, commonDir] = output.trim().split('\n');
  return gitDir === commonDir ? null : path.dirname(commonDir);
}

// The main checkout, by its real path, when cwd is in a linked worktree, or null in the main
// checkout itself.
export function mainCheckoutOf(cwd, env = process.env) {
  const checkout = checkoutOfGitDirs(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, env, encoding: 'utf8' }));
  return checkout === null ? null : fs.realpathSync(checkout);
}

// Whether the module at moduleUrl (its import.meta.url) is the script node was started with,
// rather than a module a test imported. Node reports the module by its real path, so the script
// path is resolved the same way; a script run from a symlinked checkout would otherwise do nothing.
export const runDirectly = moduleUrl =>
  Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);

// Blocks the thread for the given seconds: the hooks and watchers here run synchronously.
export const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
