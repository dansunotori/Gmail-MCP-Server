// What the scripts in this directory share about being run.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The main checkout when cwd is in a linked worktree (its git dir differs from the common one,
// which sits in the main checkout), or null in the main checkout itself.
export function mainCheckoutOf(cwd, env = process.env) {
  const [gitDir, commonDir] = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, env, encoding: 'utf8' })
    .trim().split('\n');
  return gitDir === commonDir ? null : fs.realpathSync(path.dirname(commonDir));
}

// Whether the module at moduleUrl (its import.meta.url) is the script node was started with,
// rather than a module a test imported. Node reports the module by its real path, so the script
// path is resolved the same way; a script run from a symlinked checkout would otherwise do nothing.
export const runDirectly = moduleUrl =>
  Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);

// Blocks the thread for the given seconds: the hooks and watchers here run synchronously.
export const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
