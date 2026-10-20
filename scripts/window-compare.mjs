#!/usr/bin/env node
// Checks live that batch_fetch_window and read_email agree on each message of a fetched window:
// reads every messages/NNN.json under the window's output directory (or the first N), runs
// gmail-get-message for its id, and prints one JSON report of counts, differences and failed
// reads. Exit 0 when every compared message agrees, 1 when one differs, 2 on a usage error or a
// read that failed.
//
//   npm run window:compare -- <output-dir> [--limit N]
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual, promisify } from 'util';
import { runDirectly } from './script-support.mjs';

const USAGE = 'usage: npm run window:compare -- <output-dir> [--limit N]';

// The fields both tools give each message by the same rule.
const FIELDS = ['bodySource', 'htmlBody', 'htmlBodyError', 'messageIdHeader', 'calendarMethod', 'calendarReply'];

// The numbered files batch_fetch_window writes; its marker and publish temporaries are not messages.
const MESSAGE_FILE = /^\d{3,}\.json$/;

export function parseArgs(argv) {
  const positionals = [];
  let limit;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit') {
      const value = argv[index + 1];
      if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`${USAGE} (--limit takes a positive integer)`);
      limit = Number(value);
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`${USAGE} (unknown option ${arg})`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error(USAGE);
  return { outputDir: positionals[0], limit };
}

export function windowFiles(outputDir) {
  const messagesDir = path.join(outputDir, 'messages');
  if (!fs.existsSync(messagesDir)) throw new Error(`${outputDir} has no messages/ directory`);
  return fs.readdirSync(messagesDir).filter(name => MESSAGE_FILE.test(name)).sort().map(name => path.join(messagesDir, name));
}

// The names of the fields that differ between the message as gmail-get-message prints it and as
// the window file holds it. body is compared with surrounding whitespace ignored, since the
// window trims the plain part, and not at all for an HTML-only message, which read_email keeps as
// HTML and the window converts to text.
export function compareMessage(read, file) {
  const fields = FIELDS.filter(field => !isDeepStrictEqual(read[field], file[field]));
  if (!('htmlBody' in read) || !('htmlBody' in file)) fields.push('htmlBody missing');
  if (file.bodySource !== 'html' && String(read.body ?? '').trim() !== String(file.body ?? '').trim()) fields.push('body');
  return fields;
}

export async function compareWindow({ outputDir, limit, readMessage }) {
  const files = windowFiles(outputDir);
  const report = {
    outputDir,
    files: files.length,
    compared: 0,
    bySource: {},
    withHtmlBody: 0,
    withoutHtmlBody: 0,
    withHtmlBodyError: 0,
    differences: [],
    errors: [],
  };
  for (const file of files.slice(0, limit ?? files.length)) {
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    let read;
    try {
      read = await readMessage(content.id);
    } catch (error) {
      report.errors.push({ file, id: content.id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    report.compared += 1;
    report.bySource[content.bodySource] = (report.bySource[content.bodySource] ?? 0) + 1;
    if (typeof content.htmlBody === 'string') report.withHtmlBody += 1;
    else report.withoutHtmlBody += 1;
    if ('htmlBodyError' in content) report.withHtmlBodyError += 1;
    const fields = compareMessage(read, content);
    if (fields.length > 0) report.differences.push({ file, id: content.id, fields });
  }
  return report;
}

export function exitCode(report) {
  if (report.errors.length > 0) return 2;
  return report.differences.length > 0 ? 1 : 0;
}

// gmail-get-message as installed, its JSON parsed; a failed read throws with the command's stderr.
async function getMessage(id) {
  try {
    const { stdout } = await promisify(execFile)('gmail-get-message', [id], { maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

if (runDirectly(import.meta.url)) {
  try {
    const { outputDir, limit } = parseArgs(process.argv.slice(2));
    const report = await compareWindow({ outputDir, limit, readMessage: getMessage });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report);
  } catch (error) {
    process.stderr.write(`window:compare: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
