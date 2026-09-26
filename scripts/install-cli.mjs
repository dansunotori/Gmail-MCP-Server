#!/usr/bin/env node
// Links every package.json `bin` into ~/.local/bin (on PATH, independent of
// the Node version), so removing an nvm version never loses the CLIs.
// Run `npm run build` first; re-run after adding a CLI. Idempotent.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Links each bin into binDir and returns true when every one was linked. A link is replaced
// only when it already points into this checkout; a link to another checkout or installation,
// or a file that is not a link, is left alone and reported.
export function linkBins({ root, bin, binDir, log = console.log, error = console.error }) {
  fs.mkdirSync(binDir, { recursive: true });
  let ok = true;
  for (const [name, rel] of Object.entries(bin)) {
    const target = path.join(root, rel);
    const link = path.join(binDir, name);
    if (!fs.existsSync(target)) {
      error(`${name}: ${rel} missing (run npm run build)`);
      ok = false;
      continue;
    }
    fs.chmodSync(target, 0o755);
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      error(`${name}: ${link} exists and is not a symlink; left alone`);
      ok = false;
      continue;
    }
    if (existing) {
      const current = path.resolve(binDir, fs.readlinkSync(link));
      if (!current.startsWith(root + path.sep)) {
        error(`${name}: ${link} points to ${current}, outside this checkout; left alone`);
        ok = false;
        continue;
      }
      fs.unlinkSync(link);
    }
    fs.symlinkSync(target, link);
    log(`${name} -> ${target}`);
  }
  return ok;
}

// Run directly (not imported by the tests). Node reports the module by its real path, so the
// script path is resolved the same way; a symlinked checkout would otherwise do nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { bin } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  process.exit(linkBins({ root, bin, binDir: path.join(os.homedir(), '.local', 'bin') }) ? 0 : 1);
}
