import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareMessage, compareWindow, exitCode, parseArgs, windowFiles } from './window-compare.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A message file as batch_fetch_window writes it, and the same message as gmail-get-message prints it.
const fileFor = (id: string, extra: Record<string, unknown> = {}) => ({
  id, messageIdHeader: `<${id}@example.com>`, body: 'Plain', bodySource: 'text', htmlBody: `<p>${id}</p>`, ...extra,
});
const readFor = (id: string, extra: Record<string, unknown> = {}) => ({
  id, messageIdHeader: `<${id}@example.com>`, body: '\r\nPlain\r\n', bodySource: 'text', htmlBody: `<p>${id}</p>`, ...extra,
});

describe('compareMessage', () => {
  it('finds no difference when the fields agree and body differs only by surrounding whitespace', () => {
    expect(compareMessage(readFor('a'), fileFor('a'))).toEqual([]);
  });

  it('names every field that differs, and a side without htmlBody', () => {
    expect(compareMessage(
      readFor('a', { bodySource: 'html-over-stub', htmlBody: '<p>other</p>', htmlBodyError: 'body-part-fetch: 404', plainBodyError: 'body-part-fetch: 404', calendarMethod: 'REQUEST', body: 'Else' }),
      fileFor('a'),
    )).toEqual(['bodySource', 'htmlBody', 'htmlBodyError', 'plainBodyError', 'calendarMethod', 'body']);
    const { htmlBody: _dropped, ...withoutHtml } = fileFor('a');
    expect(compareMessage(readFor('a'), withoutHtml)).toEqual(['htmlBody', 'htmlBody missing']);
  });

  it('compares calendarReply by value', () => {
    const reply = { calendarMethod: 'REPLY', calendarReply: { attendee: 'x@example.com', partstat: 'ACCEPTED' } };
    expect(compareMessage(readFor('a', reply), fileFor('a', structuredClone(reply)))).toEqual([]);
    expect(compareMessage(readFor('a', reply), fileFor('a', { ...reply, calendarReply: { attendee: 'x@example.com', partstat: 'DECLINED' } }))).toEqual(['calendarReply']);
  });

  it('skips body for an HTML-only message, which read_email keeps as HTML and the window converts to text', () => {
    expect(compareMessage(
      readFor('h', { bodySource: 'html', body: '<p>h</p>' }),
      fileFor('h', { bodySource: 'html', body: 'h' }),
    )).toEqual([]);
  });
});

describe('windowFiles and compareWindow', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-compare-'));
    fs.mkdirSync(path.join(dir, 'messages'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeFile = (name: string, content: unknown) =>
    fs.writeFileSync(path.join(dir, 'messages', name), JSON.stringify(content));

  it('lists the numbered message files in order, without the marker or publish temporaries', () => {
    writeFile('002.json', fileFor('b'));
    writeFile('001.json', fileFor('a'));
    writeFile('.batch-fetch-window', {});
    writeFile('.publish-manifest.json', {});
    expect(windowFiles(dir)).toEqual([path.join(dir, 'messages', '001.json'), path.join(dir, 'messages', '002.json')]);
  });

  it('refuses a directory without messages/', () => {
    expect(() => windowFiles(path.join(dir, 'nowhere'))).toThrow(/no messages\/ directory/);
  });

  it('reads each message once and reports counts and differences', async () => {
    writeFile('001.json', fileFor('a'));
    writeFile('002.json', fileFor('b', { htmlBody: null }));
    writeFile('003.json', fileFor('c', { bodySource: 'html', body: 'c' }));
    writeFile('004.json', fileFor('d', { htmlBody: null, htmlBodyError: 'body-part-fetch: 404' }));
    const reads: Record<string, unknown> = {
      a: readFor('a'),
      b: readFor('b', { htmlBody: null }),
      c: readFor('c', { bodySource: 'html', body: '<p>c</p>' }),
      d: readFor('d', { htmlBody: '<p>d</p>' }),
    };
    const asked: string[] = [];
    const report = await compareWindow({ outputDir: dir, readMessage: async (id: string) => { asked.push(id); return reads[id]; } });
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
    expect(report).toEqual({
      outputDir: dir,
      files: 4,
      compared: 4,
      bySource: { text: 3, html: 1 },
      withHtmlBody: 2,
      withoutHtmlBody: 2,
      withHtmlBodyError: 1,
      differences: [{ file: path.join(dir, 'messages', '004.json'), id: 'd', fields: ['htmlBody', 'htmlBodyError'] }],
      errors: [],
    });
    expect(exitCode(report)).toBe(1);
  });

  it('compares only the first N files with a limit, and records a failed read as an error', async () => {
    writeFile('001.json', fileFor('a'));
    writeFile('002.json', fileFor('b'));
    writeFile('003.json', fileFor('c'));
    const report = await compareWindow({
      outputDir: dir,
      limit: 2,
      readMessage: async (id: string) => {
        if (id === 'b') throw new Error('Failed to get message: Requested entity was not found. (HTTP 404)');
        return readFor(id);
      },
    });
    expect(report).toMatchObject({ files: 3, compared: 1, differences: [] });
    expect(report.errors).toEqual([{ file: path.join(dir, 'messages', '002.json'), id: 'b', error: 'Failed to get message: Requested entity was not found. (HTTP 404)' }]);
    expect(exitCode(report)).toBe(2);
  });

  it('exits 0 when every compared message agrees', async () => {
    writeFile('001.json', fileFor('a'));
    const report = await compareWindow({ outputDir: dir, readMessage: async (id: string) => readFor(id) });
    expect(exitCode(report)).toBe(0);
  });
});

describe('parseArgs', () => {
  it('takes an output directory and an optional positive --limit', () => {
    expect(parseArgs(['/tmp/w'])).toEqual({ outputDir: '/tmp/w', limit: undefined });
    expect(parseArgs(['/tmp/w', '--limit', '5'])).toEqual({ outputDir: '/tmp/w', limit: 5 });
  });

  it('refuses a missing directory, an extra argument and a limit that is not a positive integer', () => {
    for (const argv of [[], ['/a', '/b'], ['/a', '--limit', '0'], ['/a', '--limit', 'x'], ['/a', '--limit'], ['/a', '--other']]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(/usage: npm run window:compare/);
    }
  });

  it('is the window:compare npm script', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['window:compare']).toBe('node scripts/window-compare.mjs');
  });
});
