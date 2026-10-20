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
//                                                    a git commit while the files it stages hold
//                                                    a clone, listing every clone in the reason
//
// Either way jscpd's full JSON report is left at tmp/jscpd/jscpd-report.json under the
// repository root.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { commitContents, deny, readCommit, unreadableCommit } from './commit-hook.mjs';
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

// The in-scope files as git's index stages them, each regular file's blob written under its own
// path in dir, sorted: what a commit records, whatever the working copy holds. One
// `git cat-file --batch` reads every blob.
export function writeStagedFiles(root, inScope, dir) {
  const listed = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = listed.split('\0').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    const [mode, blob, stage] = meta.split(' ');
    return { mode, blob, stage, file };
  }).filter(entry => entry.stage === '0' && (entry.mode === '100644' || entry.mode === '100755') && inScope(entry.file));
  if (entries.length === 0) return [];
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root, input: `${entries.map(entry => entry.blob).join('\n')}\n`, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let offset = 0;
  for (const { file } of entries) {
    // Each blob is "<sha> blob <size>\n<content>\n".
    const headerEnd = blobs.indexOf(10, offset);
    const size = Number(blobs.subarray(offset, headerEnd).toString('utf8').split(' ')[2]);
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blobs.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return [...new Set(entries.map(entry => entry.file))].sort();
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

// The clones in the repository at root, sorted: in its working copy, or with staged set in the
// blobs its index stages, read from a temporary copy so the clones still name repository paths.
// The report is left under root either way. Throws when the config is unreadable or
// inconsistent, or jscpd cannot run or fails, so a check that did not run never passes. jscpd
// leaves a file with fewer tokens than minTokens out of its counts; such a file cannot hold a
// clone.
export function checkDuplicates(root, { staged = false } = {}) {
  const configPath = path.join(root, CONFIG);
  const inScope = scopeRule(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const reportPath = path.join(root, REPORT);
  fs.rmSync(reportPath, { force: true });
  const stagedDir = staged ? fs.mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-staged-')) : undefined;
  try {
    const files = stagedDir ? writeStagedFiles(root, inScope, stagedDir) : scopeFiles(root, inScope);
    if (files.length === 0) return [];
    const result = spawnSync(process.execPath, [JSCPD, '--config', configPath, '--workers', '1', '--output', path.dirname(reportPath), ...files], {
      cwd: stagedDir ?? root,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`jscpd exited ${result.status ?? `on ${result.signal}`}: ${(result.stderr || result.stdout).trim()}`);
    return clonesOf(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
  } finally {
    if (stagedDir) fs.rmSync(stagedDir, { recursive: true, force: true });
  }
}

// Claude Code PreToolUse hook on Bash (configured for git commands only): a git commit is
// denied while the files it records hold duplicated code. A plain commit records the index, so
// the staged blobs are checked (a file staged only in part as the commit records it); commit -a
// records the working copy of every tracked file, so that copy is checked. A commit naming paths
// or picking hunks records a mix neither copy is, so it is refused with a request to stage the
// change instead. A repository without .jscpd.json is not checked.
function runCommitHook() {
  const commit = readCommit();
  if (commit === null) return;
  if (commit === 'refuse') {
    deny(unreadableCommit('duplicate code'));
    return;
  }
  const { root, args } = commit;
  if (!fs.existsSync(path.join(root, CONFIG))) return;
  const contents = commitContents(args);
  if (contents === 'select') {
    deny('The duplicate-code check reads what a commit records from git\'s index, or with -a from the working copy; a commit that names paths, ' +
      'picks hunks (--include, --only, --patch, --interactive, --pathspec-from-file, --fixup=reword:) or uses an option the check does not read ' +
      '(an abbreviated one included) may record a mix it cannot read, so stage the change with git add, then run git commit without paths, ' +
      'or with -a, spelling options in full.');
    return;
  }
  let clones;
  try {
    clones = checkDuplicates(root, { staged: contents === 'index' });
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
