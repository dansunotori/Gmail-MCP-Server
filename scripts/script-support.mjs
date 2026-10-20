// What the scripts in this directory share about being run.
import fs from 'fs';
import { fileURLToPath } from 'url';

// Whether the module at moduleUrl (its import.meta.url) is the script node was started with,
// rather than a module a test imported. Node reports the module by its real path, so the script
// path is resolved the same way; a script run from a symlinked checkout would otherwise do nothing.
export const runDirectly = moduleUrl =>
  Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);

// Blocks the thread for the given seconds: the hooks and watchers here run synchronously.
export const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
