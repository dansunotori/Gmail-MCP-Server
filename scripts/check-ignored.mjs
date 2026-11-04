#!/usr/bin/env node
// Refuses a tracked file that .gitignore matches: a file committed before its rule stays tracked,
// so the rule does nothing for it. Also refuses a non-comment line the root .gitignore repeats.
//
//   node scripts/check-ignored.mjs   check the repository of the current directory: each finding
//                                    on stderr; exit 0 when there is none, 1 when there is, 2
//                                    when git cannot answer
import fs from 'fs';
import path from 'path';
import { processIo, runDirectly } from './script-support.mjs';

// The paths of a `git ls-files -ci --exclude-standard -z` listing: tracked, and matched by an
// ignore rule.
export const trackedIgnored = listed => listed.split('\0').filter(Boolean);

// The lines of a .gitignore that repeat an earlier line, blank lines and comments left out, each
// with its line number and the number of the line it repeats. Trailing spaces, which git drops
// from a pattern, are not compared.
export function repeatedLines(gitignore) {
  const seen = new Map();
  const found = [];
  for (const [index, raw] of gitignore.split(/\r?\n/).entries()) {
    const text = raw.trimEnd();
    if (text === '' || text.startsWith('#')) continue;
    if (seen.has(text)) found.push({ line: index + 1, text, first: seen.get(text) });
    else seen.set(text, index + 1);
  }
  return found;
}

// The command line with io (processIo in script-support.mjs); returns the exit code.
export function main(args, io) {
  try {
    const root = io.run('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd }).trim();
    const gitignore = path.join(root, '.gitignore');
    const findings = [
      ...trackedIgnored(io.run('git', ['ls-files', '-ci', '--exclude-standard', '-z'], { cwd: root }))
        .map(file => `${file} is tracked although .gitignore matches it; untrack it with git rm --cached ${file}`),
      ...repeatedLines(fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '')
        .map(({ line, text, first }) => `.gitignore:${line}: "${text}" repeats line ${first}; delete one of them`),
    ];
    if (findings.length === 0) return 0;
    io.stderr(`${findings.join('\n')}\n`);
    return 1;
  } catch (error) {
    io.stderr(`check-ignored: ${error.message}\n`);
    return 2;
  }
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), processIo);
}
