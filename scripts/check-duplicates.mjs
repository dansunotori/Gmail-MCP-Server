#!/usr/bin/env node
// Refuses duplicated code. jscpd, the version package.json pins, reads every file of git's index
// in scope (code, tests, scripts, configuration and shell; documents are left out) with the
// settings in .jscpd.json at the repository root. The files come from git, so untracked files,
// worktrees and node_modules never change the answer, and the clones are sorted, so one tree
// always gives the same report.
//
//   node scripts/check-duplicates.mjs                check the repository of the current
//                                                    directory: each clone on stderr; exit 0
//                                                    when there is none, 1 when there is, 2 when
//                                                    the check cannot run
//   node scripts/check-duplicates.mjs --commit-hook  Claude Code PreToolUse hook on Bash: denies
//                                                    a git commit while its repository holds a
//                                                    clone, listing every clone in the reason
//
// Either way jscpd's full JSON report is left at tmp/jscpd/jscpd-report.json under the
// repository root.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { deny, readCommit, unreadableCommit } from './commit-hook.mjs';
import { runDirectly } from './script-support.mjs';

export const CONFIG = '.jscpd.json';
export const REPORT = path.join('tmp', 'jscpd', 'jscpd-report.json');

// jscpd as installed beside this script, so a hook run for any checkout uses the pinned version.
const JSCPD = createRequire(import.meta.url).resolve('jscpd/run-jscpd.js');

// Which files the check reads, from the config jscpd reads too, so the two never disagree: a
// file whose extension formatsExts maps, or whose name formatsNames maps, to one of the formats
// listed, and that no ignore glob matches. A config whose format list is not exactly the formats
// those maps name is refused, since jscpd would then skip files in scope or read none of some.
export function scopeRule(config) {
  const byExtension = Object.entries(config.formatsExts ?? {});
  const byName = Object.entries(config.formatsNames ?? {});
  const mapped = [...new Set([...byExtension, ...byName].map(([format]) => format))].sort();
  const listed = [...new Set(config.format ?? [])].sort();
  if (mapped.join(',') !== listed.join(',')) {
    throw new Error(`${CONFIG} lists the formats ${listed.join(', ') || 'none'} but maps files to ${mapped.join(', ') || 'none'}; make "format" name exactly the formats of "formatsExts" and "formatsNames"`);
  }
  const extensions = new Set(byExtension.flatMap(([, exts]) => exts.map(ext => `.${ext}`)));
  const names = new Set(byName.flatMap(([, list]) => list));
  const ignore = config.ignore ?? [];
  return file => (extensions.has(path.extname(file)) || names.has(path.basename(file)))
    && !ignore.some(glob => path.matchesGlob(file, glob));
}

// The paths in git's index under root that the rule takes and that are regular files on disk,
// sorted.
export function scopeFiles(root, inScope) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return [...new Set(listed.split('\0').filter(file => file !== '' && inScope(file)))]
    .filter(file => fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())
    .sort();
}

// A report entry's file: its path, without the `:format` jscpd appends to some names.
const fileOf = (side, format) => ({
  file: side.name.endsWith(`:${format}`) ? side.name.slice(0, -format.length - 1) : side.name,
  start: side.start,
  end: side.end,
});

const order = (a, b) => a.file.localeCompare(b.file) || a.start - b.start;

// The clones of a jscpd JSON report, each with its two ranges in path order, sorted.
export function clonesOf(report) {
  return (report.duplicates ?? [])
    .map(clone => {
      const [first, second] = [fileOf(clone.firstFile, clone.format), fileOf(clone.secondFile, clone.format)].sort(order);
      return { first, second, lines: clone.lines, tokens: clone.tokens };
    })
    .sort((a, b) => order(a.first, b.first) || order(a.second, b.second));
}

export const formatClone = ({ first, second, lines, tokens }) =>
  `${first.file}:${first.start}-${first.end} duplicates ${second.file}:${second.start}-${second.end} (${lines} lines, ${tokens} tokens)`;

// The clones in the repository at root, sorted. Throws when the config is unreadable or
// inconsistent, or jscpd cannot run or fails, so a check that did not run never passes. jscpd
// leaves a file with fewer tokens than minTokens out of its counts; such a file cannot hold a
// clone.
export function checkDuplicates(root) {
  const configPath = path.join(root, CONFIG);
  const files = scopeFiles(root, scopeRule(JSON.parse(fs.readFileSync(configPath, 'utf8'))));
  const reportPath = path.join(root, REPORT);
  fs.rmSync(reportPath, { force: true });
  if (files.length === 0) return [];
  const result = spawnSync(process.execPath, [JSCPD, '--config', configPath, '--workers', '1', '--output', path.dirname(REPORT), ...files], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`jscpd exited ${result.status ?? `on ${result.signal}`}: ${(result.stderr || result.stdout).trim()}`);
  return clonesOf(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
}

// Claude Code PreToolUse hook on Bash (configured for git commands only): a git commit is
// denied while the repository it records into holds duplicated code. The check reads the
// working copy of the files git's index lists, which is what the commit records unless a file
// is staged only in part; CI checks the commit itself. A repository without .jscpd.json is not
// checked.
function runCommitHook() {
  const commit = readCommit();
  if (commit === null) return;
  if (commit === 'refuse') {
    deny(unreadableCommit('duplicate code'));
    return;
  }
  const { root } = commit;
  if (!fs.existsSync(path.join(root, CONFIG))) return;
  let clones;
  try {
    clones = checkDuplicates(root);
  } catch (error) {
    deny(`The duplicate-code check could not run, so the commit is refused: ${error.message}`);
    return;
  }
  if (clones.length === 0) return;
  deny(`Duplicate code: ${clones.length} clone${clones.length === 1 ? '' : 's'} in the files this commit records. ` +
    'Move each duplicated block into one place both sides use, stage the change and commit again. ' +
    `jscpd's full report is ${path.join(root, REPORT)}.\n${clones.map(formatClone).join('\n')}`);
}

function main(args) {
  if (args[0] === '--commit-hook') {
    runCommitHook();
    return 0;
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const clones = checkDuplicates(root);
    if (clones.length === 0) return 0;
    process.stderr.write(`${clones.map(formatClone).join('\n')}\n${clones.length} clone${clones.length === 1 ? '' : 's'}; full report: ${path.join(root, REPORT)}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`check-duplicates: ${error.message}\n`);
    return 2;
  }
}

if (runDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
