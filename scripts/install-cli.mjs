#!/usr/bin/env node
// Links every package.json `bin` into ~/.local/bin (on PATH, independent of
// the Node version), so removing an nvm version never loses the CLIs.
// Run `npm run build` first; re-run after adding a CLI. Idempotent.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { mainCheckoutOf, runDirectly } from './script-support.mjs';

// Links each bin into binDir and returns true when every one was linked. A link is replaced
// only when it already points into this checkout; a link to another checkout or installation,
// or a file that is not a link, is left alone and reported. From a linked worktree (mainRoot
// set) the links stay with the main checkout: each is checked, none is made or replaced, and
// one line says so.
export function linkBins({ root, bin, binDir, mainRoot, log = console.log, error = console.error }) {
  fs.mkdirSync(binDir, { recursive: true });
  let ok = true;
  const within = (dir, file) => file.startsWith(dir + path.sep);
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
      if (!within(root, current) && !(mainRoot && within(mainRoot, current))) {
        error(`${name}: ${link} points to ${current}, outside this checkout; left alone`);
        ok = false;
        continue;
      }
      if (mainRoot) continue;
      fs.unlinkSync(link);
    }
    if (mainRoot) continue;
    fs.symlinkSync(target, link);
    log(`${name} -> ${target}`);
  }
  if (mainRoot && ok) log(`the CLIs stay linked from the main checkout ${mainRoot}`);
  return ok;
}

if (runDirectly(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { bin } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const mainRoot = mainCheckoutOf(root) ?? undefined;
  process.exit(linkBins({ root, bin, binDir: path.join(os.homedir(), '.local', 'bin'), mainRoot }) ? 0 : 1);
}
