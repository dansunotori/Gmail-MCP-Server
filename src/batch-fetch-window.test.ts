import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MESSAGES_DIR_MARKER, batchFetchWindow, handleBatchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';
import { GMAIL_RETRY_MAX_ATTEMPTS } from './gmail-sync.js';
import { httpError } from './gmail-test-fakes.js';
import { readEmail } from './read-tools.js';
import { hasScope } from './scopes.js';
import {
  BatchFetchWindowOutputSchema,
  BatchFetchWindowSchema,
  getToolByName,
  toMcpTools,
  toolDefinitions,
} from './tools.js';

const WATERMARK = '2026-09-07T12:00:00Z';
const BOUNDARY = Date.parse(WATERMARK);
const EPOCH = Math.floor(BOUNDARY / 1000);
const WINDOW_QUERY = `after:${EPOCH - 1} -in:spam -in:trash`;
const SPAM_QUERY = `after:${EPOCH - 1} in:spam`;
const TRASH_QUERY = `after:${EPOCH - 1} in:trash`;
const ANYWHERE_QUERY = `after:${EPOCH - 1} in:anywhere`;
const FIXED_NOW = () => new Date('2026-09-11T12:00:00.000Z');

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

type FakeMessage = Record<string, unknown>;
// An array is consumed one entry per call, so a fixture can fail and then succeed.
type Sequenced<T> = T | Error | Array<T | Error>;
type Page = Sequenced<{ ids: string[] }>;

function nextOutcome<T>(found: Sequenced<T>): T | Error {
  if (!Array.isArray(found)) return found;
  return found.length > 1 ? (found.shift() as T | Error) : found[0];
}

function message(id: string, internalDate: number, extra: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(internalDate),
    labelIds: ['INBOX'],
    snippet: `snippet ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `${id}@example.com` },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
        { name: 'X-Other', value: 'dropped from metadata' },
      ],
      body: { data: b64(`body of ${id}`) },
    },
    ...extra,
  };
}

function fakeGmail(config: {
  lists: Record<string, Page[]>;
  messages?: Record<string, Sequenced<FakeMessage>>;
  attachments?: Record<string, Sequenced<string>>;
}) {
  const list = vi.fn(async (params: { q: string; pageToken?: string }) => {
    const pages = config.lists[params.q];
    if (!pages) throw new Error(`unexpected query ${params.q}`);
    const index = params.pageToken ? Number(params.pageToken.slice('page-'.length)) : 0;
    const page = nextOutcome(pages[index]);
    if (page instanceof Error) throw page;
    const next = index + 1 < pages.length ? `page-${index + 1}` : undefined;
    return { data: { messages: page.ids.map(id => ({ id })), ...(next ? { nextPageToken: next } : {}) } };
  });
  const get = vi.fn(async ({ id }: { id: string }) => {
    const configured = config.messages?.[id];
    if (configured === undefined) throw new Error(`unexpected message ${id}`);
    const found = nextOutcome(configured);
    if (found instanceof Error) throw found;
    return { data: found };
  });
  const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
    const configured = config.attachments?.[id];
    if (configured === undefined) throw new Error(`unexpected attachment ${id}`);
    const found = nextOutcome(configured);
    if (found instanceof Error) throw found;
    return { data: { data: found } };
  });
  const getProfile = vi.fn(async () => ({ data: { emailAddress: 'me@example.com' } }));
  return {
    users: { getProfile, messages: { list, get, attachments: { get: attachmentsGet } } },
    list,
    get,
    attachmentsGet,
  };
}

function windowOnly(ids: string[], extra: Record<string, Page[]> = {}): Record<string, Page[]> {
  return {
    [WINDOW_QUERY]: [{ ids }],
    [SPAM_QUERY]: [{ ids: [] }],
    [TRASH_QUERY]: [{ ids: [] }],
    [ANYWHERE_QUERY]: [{ ids }],
    ...extra,
  };
}

// Retries back off for real by default; tests skip the wait so a fixture that fails every
// attempt (429 on a body part, 500 on a message) still exercises the full budget instantly.
const NO_SLEEP = { sleep: async () => {} };

function run(gmail: ReturnType<typeof fakeGmail>, dir: string, overrides: Partial<BatchFetchWindowInput> = {}) {
  return batchFetchWindow(gmail as never, {
    watermark: WATERMARK,
    output_dir: dir,
    cross_check: true,
    max_messages: 2000,
    ...overrides,
  }, FIXED_NOW, NO_SLEEP);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const MARKER = MESSAGES_DIR_MARKER;

// The message files of a run, sorted, without the ownership marker.
const messageFiles = (dir: string) =>
  fs.readdirSync(path.join(dir, 'messages')).filter(name => name !== MARKER).sort();

// The message files of a run, parsed, in file order.
const messageContents = (dir: string) => messageFiles(dir).map(name => readJson(path.join(dir, 'messages', name)));

// Every regular file under a directory with its exact bytes, so a test can prove a run
// touched nothing.
function snapshotDir(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, String(entry.name));
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full), fs.readFileSync(full, 'latin1'));
    }
  };
  walk(root);
  return files;
}

// Each test gets a fresh output directory, removed after it.
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// A window of one unread inbox message, a, fetched into dir: the run's result and the path of
// the message file it wrote.
async function runOneUnread() {
  const gmail = fakeGmail({
    lists: windowOnly(['a']),
    messages: { a: message('a', BOUNDARY + 1000, { labelIds: ['INBOX', 'UNREAD'] }) },
  });
  return { result: await run(gmail, dir), file: path.join(dir, 'messages', '001.json') };
}

// A window of one message, a, with the listings in extra in place of the default ones.
function windowOfA(extra: Record<string, Page[]> = {}) {
  return fakeGmail({ lists: windowOnly(['a'], extra), messages: { a: message('a', BOUNDARY + 1) } });
}

// The cross-check counts as a result carries them: under counts and again at the top level.
const withCounts = (counts: { window: number; spam: number; trash: number; anywhere: number }) => ({ counts, ...counts });

// An earlier run's message file, which a run that writes nothing leaves as the only file.
const writeEarlierMessage = () => {
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
};
const expectOnlyEarlierMessage = () => {
  expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['009.json']);
};

// A window of one message, a, whose plain body Gmail defers to the attachment big, which
// fetches as given.
function deferredBody(big: Sequenced<string>, extra: Partial<FakeMessage> = {}) {
  return fakeGmail({
    lists: windowOnly(['a']),
    messages: { a: message('a', BOUNDARY + 1, { ...extra, payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'big' } } }) },
    attachments: { big },
  });
}

describe('batchFetchWindow: listing, fetching and output files', () => {
  it('lists three pages, deduplicates, fetches each ID once, and writes ordered files', async () => {
    const gmail = fakeGmail({
      lists: {
        [WINDOW_QUERY]: [{ ids: ['b', 'a'] }, { ids: ['a', 'c'] }, { ids: [] }],
      },
      messages: {
        a: message('a', BOUNDARY + 1000),
        b: message('b', BOUNDARY + 3000),
        c: message('c', BOUNDARY + 2000),
      },
    });
    const result = await run(gmail, dir, { cross_check: false });

    expect(result.pages).toBe(3);
    expect(result.listed).toBe(3);
    expect(result.inWindow).toBe(3);
    expect(gmail.get).toHaveBeenCalledTimes(3);
    expect(gmail.get).toHaveBeenCalledWith({ userId: 'me', id: 'a', format: 'full' });
    expect(messageFiles(dir)).toEqual(['001.json', '002.json', '003.json']);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('a');
    expect(readJson(path.join(dir, 'messages', '002.json')).id).toBe('c');
    expect(readJson(path.join(dir, 'messages', '003.json')).id).toBe('b');
    expect(result.triage).toEqual([
      `${path.join(dir, 'messages', '001.json')} | a@example.com | Subject a | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '002.json')} | c@example.com | Subject c | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '003.json')} | b@example.com | Subject b | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
    ]);
  });

  it('writes the converted HTML part as the body when the plain part is a stub, and records where each body came from', async () => {
    const alternative = (plain: string, html: string) => ({
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: 'shop@example.com' }, { name: 'Subject', value: 'Order' }],
      parts: [
        ...(plain === '' ? [] : [{ mimeType: 'text/plain', body: { data: b64(plain) } }]),
        { mimeType: 'text/html', body: { data: b64(html) } },
      ],
    });
    const gmail = fakeGmail({
      lists: windowOnly(['stub', 'real', 'htmlonly']),
      messages: {
        stub: message('stub', BOUNDARY + 1000, { payload: alternative('This is an HTML message; reading this requires an HTML-capable mail reader.', '<p>Your order has <b>shipped</b>.</p>') }),
        real: message('real', BOUNDARY + 2000, { payload: alternative('Your order has shipped.', '<p>Your order has <b>shipped</b>.</p>') }),
        htmlonly: message('htmlonly', BOUNDARY + 3000, { payload: alternative('', '<p>Only <i>HTML</i></p>') }),
      },
    });
    await run(gmail, dir);
    const files = messageContents(dir);
    expect(files.map(file => [file.id, file.bodySource, file.body, file.htmlBody])).toEqual([
      ['stub', 'html-over-stub', 'Your order has shipped .', '<p>Your order has <b>shipped</b>.</p>'],
      ['real', 'text', 'Your order has shipped.', '<p>Your order has <b>shipped</b>.</p>'],
      ['htmlonly', 'html', 'Only HTML', '<p>Only <i>HTML</i></p>'],
    ]);
  });

  it('writes the same bodySource and htmlBody for each kind of message as read_email returns for it', async () => {
    const parts = (plain: string, html: string) => ({
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: 'x@example.com' }],
      parts: [
        ...(plain === '' ? [] : [{ mimeType: 'text/plain', body: { data: b64(plain) } }]),
        ...(html === '' ? [] : [{ mimeType: 'text/html', body: { data: b64(html) } }]),
      ],
    });
    const gmail = fakeGmail({
      lists: windowOnly(['both', 'text', 'html']),
      messages: {
        both: message('both', BOUNDARY + 1000, { payload: parts('Stale reminder', '<p>Real content</p>') }),
        text: message('text', BOUNDARY + 2000, { payload: parts('Only text', '') }),
        html: message('html', BOUNDARY + 3000, { payload: parts('', '<p>Only HTML</p>') }),
      },
    });
    await run(gmail, dir);
    const files = messageContents(dir);
    for (const file of files) {
      const read = await readEmail(gmail as never, { messageId: file.id });
      expect({ bodySource: file.bodySource, htmlBody: file.htmlBody }, file.id).toEqual({ bodySource: read.bodySource, htmlBody: read.htmlBody });
    }
    expect(files.map(file => file.htmlBody)).toEqual(['<p>Real content</p>', null, '<p>Only HTML</p>']);
  });

  it.each([
    {
      failing: 'HTML',
      parts: [{ mimeType: 'text/plain', body: { data: b64('Stale reminder') } }, { mimeType: 'text/html', body: { attachmentId: 'part-a' } }],
      written: { body: 'Stale reminder', bodySource: 'text', htmlBody: null, htmlBodyError: 'body-part-fetch: 404' },
      absent: 'plainBodyError',
    },
    {
      failing: 'plain',
      parts: [{ mimeType: 'text/plain', body: { attachmentId: 'part-a' } }, { mimeType: 'text/html', body: { data: b64('<p>Here</p>') } }],
      written: { htmlBody: '<p>Here</p>', plainBodyError: 'body-part-fetch: 404' },
      absent: 'htmlBodyError',
    },
  ])('writes the reason in the message file and in failures when the $failing part cannot be fetched', async ({ parts, written, absent }) => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1000, { payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: 'a@example.com' }],
        parts,
      } }) },
      attachments: { 'part-a': httpError(404) },
    });
    const result = await run(gmail, dir);
    const file = readJson(path.join(dir, 'messages', '001.json'));
    expect(file).toMatchObject(written);
    expect(file).not.toHaveProperty(absent);
    expect(result.failures).toEqual([{ id: 'a', error: 'body-part-fetch: 404', operation: 'body-part-fetch', status: 404, attempts: 1 }]);
  });

  it('writes the calendar method and reply fields of meeting messages, and neither field for ordinary mail', async () => {
    const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', ...lines, 'BEGIN:VEVENT', 'UID:u1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const withCalendar = (id: string, at: number, calendar: string) => message(id, at, { payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: `${id}@example.com` }, { name: 'Subject', value: id }],
      parts: [
        { mimeType: 'text/plain', body: { data: b64(`body of ${id}`) } },
        { mimeType: 'text/calendar', filename: 'invite.ics', body: { attachmentId: `ics-${id}`, size: calendar.length } },
      ],
    } });
    const calendars: Record<string, string> = {
      invite: ics('METHOD:REQUEST'),
      cancel: ics('METHOD:CANCEL'),
      accept: ics('METHOD:REPLY', 'ATTENDEE;CN=Nadia;PARTSTAT=ACCEPTED:mailto:nadia@example.com'),
      decline: ics('METHOD:REPLY', 'ATTENDEE;PARTSTAT=DECLINED:mailto:chris@example.com'),
      broken: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    };
    const ids = ['invite', 'cancel', 'accept', 'decline', 'broken', 'plain'];
    const gmail = fakeGmail({
      lists: windowOnly(ids),
      messages: Object.fromEntries(ids.map((id, index) => [
        id,
        id === 'plain' ? message(id, BOUNDARY + 1000 * (index + 1)) : withCalendar(id, BOUNDARY + 1000 * (index + 1), calendars[id]),
      ])),
      attachments: Object.fromEntries(Object.entries(calendars).map(([id, text]) => [`ics-${id}`, b64(text)])),
    });
    const result = await run(gmail, dir);
    const files = messageContents(dir);
    const fields = (id: string) => {
      const file = files.find(entry => entry.id === id);
      return { calendarMethod: file.calendarMethod, calendarReply: file.calendarReply };
    };
    expect(fields('invite')).toEqual({ calendarMethod: 'REQUEST', calendarReply: undefined });
    expect(fields('cancel')).toEqual({ calendarMethod: 'CANCEL', calendarReply: undefined });
    expect(fields('accept')).toEqual({ calendarMethod: 'REPLY', calendarReply: { attendee: 'nadia@example.com', partstat: 'ACCEPTED' } });
    expect(fields('decline')).toEqual({ calendarMethod: 'REPLY', calendarReply: { attendee: 'chris@example.com', partstat: 'DECLINED' } });
    const plain = files.find(entry => entry.id === 'plain');
    expect(plain).not.toHaveProperty('calendarMethod');
    expect(plain).not.toHaveProperty('calendarReply');
    const broken = files.find(entry => entry.id === 'broken');
    expect(broken).not.toHaveProperty('calendarMethod');
    expect(result.failures).toEqual([{
      id: 'broken',
      error: 'calendar-part: no METHOD property',
      operation: 'calendar-part',
      status: 'unparseable',
      attempts: 1,
    }]);
    expect(result.status).toBe('incomplete');
  });

  it('gives both copies of a self-addressed message their own id and the same Message-ID header', async () => {
    const header = (value: string) => ({ name: 'Message-Id', value });
    const withMessageId = (id: string, internalDate: number, labelIds: string[]) => {
      const base = message(id, internalDate, { labelIds });
      const payload = base.payload as { headers: Array<{ name: string; value: string }> };
      return { ...base, payload: { ...payload, headers: [...payload.headers, header('<self.1@mail.example.com>')] } };
    };
    const gmail = fakeGmail({
      lists: windowOnly(['sent', 'received']),
      messages: {
        sent: withMessageId('sent', BOUNDARY + 1000, ['SENT']),
        received: withMessageId('received', BOUNDARY + 2000, ['INBOX']),
      },
    });
    await run(gmail, dir);
    const files = messageContents(dir);
    expect(files.map(file => [file.id, file.messageIdHeader])).toEqual([
      ['sent', '<self.1@mail.example.com>'],
      ['received', '<self.1@mail.example.com>'],
    ]);
    const manifest = readJson(path.join(dir, 'manifest.json'));
    expect(manifest.messages.map((entry: { id: string; messageIdHeader: string }) => [entry.id, entry.messageIdHeader])).toEqual([
      ['sent', '<self.1@mail.example.com>'],
      ['received', '<self.1@mail.example.com>'],
    ]);
  });

  it('writes the documented shapes for the message file and window metadata, and lists the file in the manifest', async () => {
    const { result, file } = await runOneUnread();
    const raw = fs.readFileSync(file, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
    expect(JSON.parse(raw)).toEqual({
      id: 'a',
      threadId: 't-a',
      internalDate: String(BOUNDARY + 1000),
      labelIds: ['INBOX', 'UNREAD'],
      from: 'a@example.com',
      to: 'me@example.com',
      cc: '',
      subject: 'Subject a',
      dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
      messageIdHeader: null,
      snippet: 'snippet a',
      attachments: [],
      body: 'body of a',
      bodySource: 'text',
      htmlBody: null,
    });

    expect(readJson(path.join(dir, 'window-metadata.json'))).toEqual({
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      messages: [{
        id: 'a',
        internalDate: String(BOUNDARY + 1000),
        labelIds: ['INBOX', 'UNREAD'],
        headers: [
          { name: 'From', value: 'a@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Subject', value: 'Subject a' },
          { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
        ],
      }],
    });

    const manifest = readJson(path.join(dir, 'manifest.json'));
    expect(manifest.messages).toEqual([{
      file,
      id: 'a',
      internalDate: String(BOUNDARY + 1000),
      labelIds: ['INBOX', 'UNREAD'],
      from: 'a@example.com',
      subject: 'Subject a',
      dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
      messageIdHeader: null,
      attachments: 0,
    }]);
    expect(path.isAbsolute(manifest.messages[0].file)).toBe(true);
    const summary = {
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      query: WINDOW_QUERY,
      pages: 1,
      listed: 1,
      inWindow: 1,
    };
    expect(manifest).toMatchObject(summary);
    expect(result).toMatchObject(summary);
  });

  it('handles an empty window with empty files', async () => {
    const gmail = fakeGmail({ lists: windowOnly([]) });
    const result = await run(gmail, dir);

    expect(result.listed).toBe(0);
    expect(result.inWindow).toBe(0);
    expect(result.triage).toEqual([]);
    expect(messageFiles(dir)).toEqual([]);
    expect(readJson(path.join(dir, 'manifest.json')).messages).toEqual([]);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toEqual([]);
  });

  it('rejects when the first window page fails, naming the query, page and status, and writes nothing', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [httpError(404)] } });
    await expect(run(gmail, dir)).rejects.toThrow(`window listing failed: query "${WINDOW_QUERY}" page 1 status 404 after 1 attempt`);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps window-metadata headers case-insensitively while preserving their original casing', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'from', value: 'a@example.com' },
              { name: 'SUBJECT', value: 'Subject a' },
              { name: 'X-Other', value: 'dropped' },
            ],
            body: { data: b64('body of a') },
          },
        }),
      },
    });
    const result = await run(gmail, dir);

    expect(readJson(path.join(dir, 'window-metadata.json')).messages[0].headers).toEqual([
      { name: 'from', value: 'a@example.com' },
      { name: 'SUBJECT', value: 'Subject a' },
    ]);
    const written = readJson(path.join(dir, 'messages', '001.json'));
    expect(written.from).toBe('a@example.com');
    expect(written.subject).toBe('Subject a');
    expect(result.inWindow).toBe(1);
  });

});

describe('batchFetchWindow: owned paths and atomic publication', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes an ownership marker into messages/ on every run', async () => {
    const gmail = windowOfA();
    await run(gmail, dir);

    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual([MARKER, '001.json']);
    expect(fs.statSync(path.join(dir, 'messages', MARKER)).isFile()).toBe(true);
  });

  it('replaces the files of a previous run completely on rerun, including a stale higher-numbered file', async () => {
    const first = fakeGmail({ lists: windowOnly(['x', 'y']), messages: { x: message('x', BOUNDARY + 1), y: message('y', BOUNDARY + 2) } });
    await run(first, dir);
    expect(messageFiles(dir)).toEqual(['001.json', '002.json']);

    const second = windowOfA();
    await run(second, dir);

    expect(messageFiles(dir)).toEqual(['001.json']);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('a');
    expect(readJson(path.join(dir, 'manifest.json')).messages.map((entry: { id: string }) => entry.id)).toEqual(['a']);
  });

  it('refuses to delete a messages/ that holds files the tool did not write, before touching anything', async () => {
    const first = fakeGmail({ lists: windowOnly(['old']), messages: { old: message('old', BOUNDARY + 1) } });
    await run(first, dir);
    fs.writeFileSync(path.join(dir, 'messages', 'photo.jpg'), 'not ours');
    fs.mkdirSync(path.join(dir, 'messages', 'archive'));
    const before = snapshotDir(dir);

    const second = windowOfA();
    await expect(run(second, dir)).rejects.toThrow(/refusing to delete .*messages.*archive, photo\.jpg/);

    expect(second.get).not.toHaveBeenCalled();
    expect(snapshotDir(dir)).toEqual(before);
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual([MARKER, '001.json', 'archive', 'photo.jpg']);
    expect(readJson(path.join(dir, 'manifest.json')).messages[0].id).toBe('old');
    expect(readJson(path.join(dir, 'window-metadata.json')).messages[0].id).toBe('old');
  });

  // A manifest.json beside messages/ proves nothing: only the marker does, so a directory
  // that merely looks like the tool's output is refused whatever the manifest says.
  it('refuses a messages/ without the ownership marker even when its files match the naming pattern and a manifest lists them', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '001.json'), '{"id":"old1"}');
    fs.writeFileSync(path.join(dir, 'messages', '.publish-manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ messages: [{ file: path.join(dir, 'messages', '001.json'), id: 'old1' }] }));
    const before = snapshotDir(dir);

    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow(new RegExp(`refusing to delete .*messages: it has no ${MARKER} marker`));

    expect(gmail.get).not.toHaveBeenCalled();
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('refuses a messages/ without the marker when there is no manifest beside it at all', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '001.json'), '{}');
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow(/refusing to delete .*messages: it has no .* marker/);
    expect(fs.readFileSync(path.join(dir, 'messages', '001.json'), 'utf8')).toBe('{}');
  });

  it('proceeds when messages/ exists but is empty, since deleting it loses nothing', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    const gmail = windowOfA();
    const result = await run(gmail, dir);

    expect(result.inWindow).toBe(1);
    expect(messageFiles(dir)).toEqual(['001.json']);
  });

  it('refuses when an owned name is a directory or a symlink rather than a regular file', async () => {
    fs.mkdirSync(path.join(dir, 'messages', '001.json'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '001.json', 'inside.txt'), 'caller data');
    fs.writeFileSync(path.join(dir, 'elsewhere.json'), '{}');
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'messages', '.publish-link'));
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow(/refusing to delete .*messages.*\.publish-link, 001\.json/);

    expect(fs.readFileSync(path.join(dir, 'messages', '001.json', 'inside.txt'), 'utf8')).toBe('caller data');
    expect(fs.lstatSync(path.join(dir, 'messages', '.publish-link')).isSymbolicLink()).toBe(true);
  });

  it('refuses when messages/ exists but is not a directory', async () => {
    fs.writeFileSync(path.join(dir, 'messages'), 'a file');
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow(/refusing to delete .*messages.*not a directory/);
    expect(fs.readFileSync(path.join(dir, 'messages'), 'utf8')).toBe('a file');
  });

  // Every Gmail call (message fetches, body parts, cross-check listings) completes before the
  // previous outputs are deleted, so a rerun that fails on any of them leaves them untouched.
  const failingReruns: Array<[string, (unauthorised: Error) => ReturnType<typeof fakeGmail>]> = [
    ['a messages.get auth error', unauthorised => fakeGmail({
      lists: windowOnly(['a', 'b']),
      messages: { a: message('a', BOUNDARY + 1), b: unauthorised },
    })],
    ['a body-part auth error', unauthorised => deferredBody(unauthorised)],
    ['a cross-check auth error', unauthorised => windowOfA({ [SPAM_QUERY]: [unauthorised] })],
  ];
  for (const [failure, rerun] of failingReruns) {
    it(`leaves the previous outputs byte-for-byte untouched when a rerun fails on ${failure}`, async () => {
      const first = fakeGmail({ lists: windowOnly(['old']), messages: { old: message('old', BOUNDARY + 1) } });
      await run(first, dir);
      const before = snapshotDir(dir);
      expect(before.has('manifest.json')).toBe(true);

      const unauthorised = httpError(401);
      await expect(run(rerun(unauthorised), dir)).rejects.toBe(unauthorised);

      expect(snapshotDir(dir)).toEqual(before);
    });
  }

  it('refuses a foreign messages/ before downloading anything', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', 'photo.jpg'), 'not ours');
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow(/refusing to delete/);
    expect(gmail.get).not.toHaveBeenCalled();
  });

  // Every write to a file whose name ends with suffix fails as on a full disk.
  const failWritesTo = (suffix: string) => {
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith(suffix)) throw new Error('disk full');
      return original(file, data, options);
    });
  };

  it('leaves window-metadata but no manifest when the manifest publish fails', async () => {
    failWritesTo('.publish-manifest.json');
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(true);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['messages', 'window-metadata.json']);

    vi.restoreAllMocks();
    const again = windowOfA();
    const result = await run(again, dir);
    expect(result.inWindow).toBe(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });

  it('leaves neither metadata file when the window-metadata publish fails', async () => {
    failWritesTo('.publish-window-metadata.json');
    const gmail = windowOfA();
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // The tool deletes only the three paths it owns; this pins that property.
  it('leaves no publish temporaries and never touches unrelated caller files', async () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp-123'), 'also keep me');
    const gmail = windowOfA();
    await run(gmail, dir);

    expect(fs.readdirSync(dir).sort()).toEqual(['manifest.json', 'manifest.json.tmp-123', 'messages', 'notes.txt', 'window-metadata.json']);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(dir, 'manifest.json.tmp-123'), 'utf8')).toBe('also keep me');
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });
});

describe('batchFetchWindow: boundary and label filtering', () => {
  it('includes the exact boundary and excludes one millisecond before it', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['on', 'before']),
      messages: { on: message('on', BOUNDARY), before: message('before', BOUNDARY - 1) },
    });
    const result = await run(gmail, dir);

    expect(result.inWindow).toBe(1);
    expect(result.belowBoundaryOrExcluded).toBe(1);
    expect(readJson(path.join(dir, 'manifest.json')).belowBoundaryOrExcluded).toBe(1);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('on');
  });

  // The kept-message filter excludes TRASH alongside SPAM.
  for (const label of ['SPAM', 'TRASH']) {
    it(`skips a listed message labelled ${label}`, async () => {
      const gmail = fakeGmail({
        lists: windowOnly(['x', 'a']),
        messages: {
          x: message('x', BOUNDARY + 1, { labelIds: [label] }),
          a: message('a', BOUNDARY + 2),
        },
      });
      const result = await run(gmail, dir);

      expect(result.inWindow).toBe(1);
      expect(result.belowBoundaryOrExcluded).toBe(1);
      expect(messageFiles(dir)).toEqual(['001.json']);
    });
  }
});

describe('batchFetchWindow: body resolution', () => {
  it('fetches a large body delivered through attachmentId', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@example.com' }],
            body: { attachmentId: 'big', size: 9 },
          },
        }),
      },
      attachments: { big: b64('the large body') },
    });
    await run(gmail, dir);

    expect(gmail.attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'a', id: 'big' });
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('the large body');
  });

  it('converts an HTML-only message to plain text with the documented rules', async () => {
    const html = '<style>p{}</style><p>Hello<br>there</p><a href="https://x.test">link</a>&amp;&nbsp;done';
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'From', value: 'a@example.com' }],
            body: { data: b64(html) },
          },
        }),
      },
    });
    await run(gmail, dir);

    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('Hello\nthere\nlink [https://x.test]& done');
  });
});

describe('batchFetchWindow: numbering width', () => {
  it('widens padding to four digits when more than 999 messages survive', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `m${index}`);
    const messages = Object.fromEntries(ids.map((id, index) => [id, message(id, BOUNDARY + index)]));
    const gmail = fakeGmail({ lists: windowOnly(ids), messages });
    await run(gmail, dir);

    const files = messageFiles(dir);
    expect(files).toHaveLength(1000);
    expect(files[0]).toBe('0001.json');
    expect(files[999]).toBe('1000.json');
  });
});

describe('batchFetchWindow: per-message failures', () => {
  it('records a messages.get failure that exhausts its retries with status and attempts, and still writes the rest', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'bad', 'c']),
      messages: { a: message('a', BOUNDARY + 1), bad: httpError(503), c: message('c', BOUNDARY + 2) },
    });
    const result = await run(gmail, dir);

    const failure = { id: 'bad', error: '503', operation: 'messages.get', status: 503, attempts: GMAIL_RETRY_MAX_ATTEMPTS };
    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([failure]);
    expect(result.inWindow).toBe(2);
    expect(result.belowBoundaryOrExcluded).toBe(0);
    expect(readJson(path.join(dir, 'manifest.json')).failures).toEqual([failure]);
    expect(messageFiles(dir)).toEqual(['001.json', '002.json']);
    expect(result.crossCheck).toMatchObject({ window: 3, spam: 0, trash: 0, anywhere: 3, unexplainedIds: [], complete: true, consistent: true });
    expect(gmail.get.mock.calls.filter(([params]) => params.id === 'bad')).toHaveLength(GMAIL_RETRY_MAX_ATTEMPTS);
  });

  it('downloads a message whose messages.get returns 429 twice then succeeds, with no failure recorded', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: [httpError(429), httpError(429), message('a', BOUNDARY + 1)] },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
    expect(result.inWindow).toBe(1);
    expect(readJson(path.join(dir, 'manifest.json')).messages.map((entry: { id: string }) => entry.id)).toEqual(['a']);
    expect(gmail.get).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 from messages.get and records a single attempt', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['gone']), messages: { gone: httpError(404) } });
    const result = await run(gmail, dir);

    expect(result.failures).toEqual([{ id: 'gone', error: '404', operation: 'messages.get', status: 404, attempts: 1 }]);
    expect(gmail.get).toHaveBeenCalledTimes(1);
  });

  it('retries the profile lookup on a transient error and fails the call when it is exhausted', async () => {
    const gmail = windowOfA();
    gmail.users.getProfile
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ data: { emailAddress: 'me@example.com' } });
    const result = await run(gmail, dir);
    expect(result.emailAddress).toBe('me@example.com');
    expect(gmail.users.getProfile).toHaveBeenCalledTimes(3);

    const exhausted = windowOfA();
    const outage = httpError(503);
    exhausted.users.getProfile.mockRejectedValue(outage);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-'));
    try {
      await expect(run(exhausted, other)).rejects.toBe(outage);
      expect(exhausted.users.getProfile).toHaveBeenCalledTimes(GMAIL_RETRY_MAX_ATTEMPTS);
      expect(exhausted.list).not.toHaveBeenCalled();
      expect(fs.readdirSync(other)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('records a network error code as the status of a messages.get failure', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: reset } });
    const result = await run(gmail, dir);

    expect(result.failures).toEqual([{ id: 'a', error: 'ECONNRESET', operation: 'messages.get', status: 'ECONNRESET', attempts: GMAIL_RETRY_MAX_ATTEMPTS }]);
  });

  it('waits the Retry-After seconds before retrying a 429 on messages.get', async () => {
    vi.useFakeTimers();
    try {
      const throttled = Object.assign(httpError(429), { response: { status: 429, headers: new Headers({ 'Retry-After': '2' }) } });
      const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: [throttled, message('a', BOUNDARY + 1)] } });
      // Real timers drive the wait here, so the fixture must not substitute the sleep.
      const pending = batchFetchWindow(gmail as never, { watermark: WATERMARK, output_dir: dir, cross_check: true, max_messages: 2000 }, FIXED_NOW);
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(1999);
      expect(gmail.get).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(gmail.get).toHaveBeenCalledTimes(2);
      expect(result.failures).toEqual([]);
      expect(result.inWindow).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports status ok with no failures for a clean run', async () => {
    const gmail = windowOfA();
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
  });

  it('rejects on a 401 from messages.get and leaves no files', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'b']),
      messages: { a: message('a', BOUNDARY + 1), b: unauthorised },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects on a 403 insufficientPermissions from messages.get', async () => {
    const forbidden = httpError(403, 'insufficientPermissions');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: forbidden } });
    await expect(run(gmail, dir)).rejects.toBe(forbidden);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // listAllGmailMessageIds rethrows auth errors on any page, so the run aborts.
  it('rejects on a 401 on window page two and writes nothing', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a'] }, unauthorised] } });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('batchFetchWindow: body-part failures', () => {
  it('records a body-part failure by code and still writes the message', async () => {
    const gmail = deferredBody(httpError(429));
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: 'a', error: 'body-part-fetch: 429', operation: 'body-part-fetch', status: 429, attempts: GMAIL_RETRY_MAX_ATTEMPTS }]);
    // A written message with a body-part failure is still in the window; a derived count
    // (listed - inWindow - failures.length) would give -1 here, so the direct count is pinned.
    expect(result.inWindow).toBe(1);
    expect(result.belowBoundaryOrExcluded).toBe(0);
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('');
    expect(gmail.attachmentsGet).toHaveBeenCalledTimes(GMAIL_RETRY_MAX_ATTEMPTS);
  });

  it('recovers a body part whose fetch fails once with 429', async () => {
    const gmail = deferredBody([httpError(429), b64('recovered body')]);
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('recovered body');
    expect(gmail.attachmentsGet).toHaveBeenCalledTimes(2);
  });

  it('uses the listed ID for a body-part failure even when the fetched message omits id', async () => {
    const gmail = deferredBody(httpError(429), { id: undefined });
    const result = await run(gmail, dir);

    expect(result.failures).toMatchObject([{ id: 'a', error: 'body-part-fetch: 429' }]);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('a');
    expect(readJson(path.join(dir, 'manifest.json')).messages[0].id).toBe('a');
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  // resolveMessageBody rethrows auth errors instead of recording them as failures.
  it('rejects on a 401 from a deferred body fetch', async () => {
    const unauthorised = httpError(401);
    await expect(run(deferredBody(unauthorised), dir)).rejects.toBe(unauthorised);
  });
});

describe('batchFetchWindow: truncation', () => {
  it('truncates across three pages without fetching or writing anything', async () => {
    writeEarlierMessage();
    const gmail = fakeGmail({
      lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }, { ids: ['c', 'd'] }, { ids: ['e'] }] },
    });
    const result = await run(gmail, dir, { max_messages: 4 });

    expect(result.status).toBe('truncated');
    expect(result.truncated).toBe(true);
    expect(result.maxMessages).toBe(4);
    expect(result.listed).toBe(5);
    expect(result.pages).toBe(3);
    expect(result.inWindow).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.triage).toEqual([]);
    // No cross-check listing runs for a truncated window, and the result says so.
    expect(result.crossCheck).toEqual({ status: 'skipped', consistent: false, complete: false, unexplainedIds: [], errors: [] });
    expect(gmail.get).not.toHaveBeenCalled();
    expect(gmail.list).toHaveBeenCalledTimes(3);
    expectOnlyEarlierMessage();
  });

  it('leaves all three previous outputs untouched on a truncated rerun', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '001.json'), 'old message');
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'old manifest');
    fs.writeFileSync(path.join(dir, 'window-metadata.json'), 'old metadata');
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }] } });
    await run(gmail, dir, { max_messages: 1 });

    expect(fs.readFileSync(path.join(dir, 'messages', '001.json'), 'utf8')).toBe('old message');
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe('old manifest');
    expect(fs.readFileSync(path.join(dir, 'window-metadata.json'), 'utf8')).toBe('old metadata');
  });

  it('reports truncated false and the cap in the result and the manifest when under the cap', async () => {
    const gmail = windowOfA();
    const result = await run(gmail, dir, { max_messages: 1 });

    expect(result.truncated).toBe(false);
    expect(result.maxMessages).toBe(1);
    expect(readJson(path.join(dir, 'manifest.json'))).toMatchObject({ truncated: false, maxMessages: 1 });
  });
});

describe('batchFetchWindow: cross-check', () => {
  it('lists spam, trash and anywhere and reports a consistent cross-check in the result and the manifest', async () => {
    const gmail = windowOfA();
    const result = await run(gmail, dir);

    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: SPAM_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: TRASH_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: ANYWHERE_QUERY, includeSpamTrash: true }));
    const expected = {
      status: 'consistent',
      consistent: true,
      complete: true,
      unexplainedIds: [],
      errors: [],
      ...withCounts({ window: 1, spam: 0, trash: 0, anywhere: 1 }),
    };
    expect(result.status).toBe('ok');
    expect(result.crossCheck).toEqual(expected);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toEqual(expected);
  });

  // With cross_check disabled the spam, trash and anywhere listings must not run at all.
  it('reports the cross-check as skipped and not consistent when disabled, without listing spam, trash or anywhere', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: [] }] } });
    const result = await run(gmail, dir, { cross_check: false });

    const skipped = { status: 'skipped', consistent: false, complete: false, unexplainedIds: [], errors: [] };
    expect(result.status).toBe('ok');
    expect(result.crossCheck).toEqual(skipped);
    expect(gmail.list).toHaveBeenCalledTimes(1);
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: WINDOW_QUERY }));
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toEqual(skipped);
  });
});

describe('batchFetchWindow: cross-check outcomes', () => {
  it('flags an anywhere ID absent from window, spam and trash as inconsistent and lists exactly that ID', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], {
        [SPAM_QUERY]: [{ ids: ['s1'] }],
        [TRASH_QUERY]: [{ ids: ['t1'] }],
        [ANYWHERE_QUERY]: [{ ids: ['a', 's1', 't1', 'ghost'] }],
      }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.crossCheck).toEqual({
      status: 'inconsistent',
      consistent: false,
      complete: true,
      unexplainedIds: ['ghost'],
      errors: [],
      ...withCounts({ window: 1, spam: 1, trash: 1, anywhere: 4 }),
    });
    expect(result.failures).toEqual([]);
  });

  it('records a cross-check listing failure and keeps the message files', async () => {
    const gmail = windowOfA({ [SPAM_QUERY]: [httpError(503)] });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: `cross-check:${SPAM_QUERY}`, error: '503', operation: 'cross-check', status: 503, attempts: GMAIL_RETRY_MAX_ATTEMPTS }]);
    expect(result.crossCheck).toMatchObject({ spam: 0 });
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  // A listing that failed cannot vouch for anything: an empty spam set explains no IDs, and an
  // empty anywhere set would hide every unexplained ID, so `consistent` must not read true.
  it('reports the cross-check as incomplete and inconsistent when a listing fails, even with no unexplained IDs', async () => {
    const gmail = windowOfA({ [SPAM_QUERY]: [httpError(503)] });
    const result = await run(gmail, dir);

    expect(result.crossCheck).toEqual({
      status: 'failed',
      consistent: false,
      complete: false,
      unexplainedIds: [],
      errors: [{ query: SPAM_QUERY, page: 1, status: 503, attempts: GMAIL_RETRY_MAX_ATTEMPTS }],
      ...withCounts({ window: 1, spam: 0, trash: 0, anywhere: 1 }),
    });
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck.consistent).toBe(false);
  });

  it('writes the window and reports the cross-check as failed, naming the query, when the anywhere listing exhausts its retries', async () => {
    const gmail = windowOfA({ [ANYWHERE_QUERY]: [httpError(503)] });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.crossCheck).toMatchObject({
      status: 'failed',
      consistent: false,
      complete: false,
      anywhere: 0,
      unexplainedIds: [],
      errors: [{ query: ANYWHERE_QUERY, page: 1, status: 503, attempts: GMAIL_RETRY_MAX_ATTEMPTS }],
    });
    expect(gmail.list.mock.calls.filter(([params]) => params.q === ANYWHERE_QUERY)).toHaveLength(GMAIL_RETRY_MAX_ATTEMPTS);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck.status).toBe('failed');
  });

  it('lists every failed listing in errors and still reports unexplained IDs from the listings that completed', async () => {
    const gmail = windowOfA({ [SPAM_QUERY]: [httpError(500)], [TRASH_QUERY]: [httpError(502)], [ANYWHERE_QUERY]: [{ ids: ['a', 'ghost'] }] });
    const result = await run(gmail, dir);

    expect(result.crossCheck).toMatchObject({
      status: 'failed',
      consistent: false,
      unexplainedIds: ['ghost'],
      errors: [
        { query: SPAM_QUERY, page: 1, status: 500, attempts: GMAIL_RETRY_MAX_ATTEMPTS },
        { query: TRASH_QUERY, page: 1, status: 502, attempts: GMAIL_RETRY_MAX_ATTEMPTS },
      ],
    });
  });

  it('reports the network error code for a later cross-check page failure after retrying it', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = windowOfA({ [TRASH_QUERY]: [{ ids: [] }, reset] });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{
      id: `cross-check:${TRASH_QUERY}`,
      error: 'ECONNRESET',
      operation: 'cross-check',
      status: 'ECONNRESET',
      attempts: GMAIL_RETRY_MAX_ATTEMPTS,
    }]);
    // A partial listing (page one succeeded, page two failed) is incomplete too.
    expect(result.crossCheck).toMatchObject({ complete: false, consistent: false });
  });

  // The cross-check listings catch non-auth failures and report them as incomplete; this pins
  // that a 401 is rethrown through the isAuthError check rather than swallowed by that catch.
  it('rejects on a 401 from the spam cross-check and writes nothing', async () => {
    const unauthorised = httpError(401);
    await expect(run(windowOfA({ [SPAM_QUERY]: [unauthorised] }), dir)).rejects.toBe(unauthorised);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('batchFetchWindow: window listing failures', () => {
  it('retries a window page that fails transiently and lists the window in full', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'b'], { [WINDOW_QUERY]: [{ ids: ['a'] }, [httpError(503), httpError(500), { ids: ['b'] }]] }),
      messages: { a: message('a', BOUNDARY + 1), b: message('b', BOUNDARY + 2) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.listed).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.listingComplete).toBe(true);
    expect(result.failures).toEqual([]);
    expect(gmail.list.mock.calls.filter(([params]) => params.q === WINDOW_QUERY)).toHaveLength(4);
  });

  it('rejects when window page two fails on every attempt, naming the page, and leaves earlier outputs byte-for-byte unchanged', async () => {
    const first = fakeGmail({ lists: windowOnly(['old']), messages: { old: message('old', BOUNDARY + 1) } });
    await run(first, dir);
    const before = snapshotDir(dir);
    expect(before.size).toBeGreaterThan(0);

    const gmail = windowOfA({ [WINDOW_QUERY]: [{ ids: ['a'] }, httpError(500)] });
    await expect(run(gmail, dir)).rejects.toThrow(
      `window listing failed: query "${WINDOW_QUERY}" page 2 status 500 after ${GMAIL_RETRY_MAX_ATTEMPTS} attempts`,
    );

    expect(gmail.get).not.toHaveBeenCalled();
    expect(gmail.list.mock.calls.filter(([params]) => params.q === WINDOW_QUERY)).toHaveLength(1 + GMAIL_RETRY_MAX_ATTEMPTS);
    expect(snapshotDir(dir)).toEqual(before);
    expect(readJson(path.join(dir, 'manifest.json')).messages[0].id).toBe('old');
  });

  it('names the network error code when a later window page fails after retries', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = windowOfA({ [WINDOW_QUERY]: [{ ids: ['a'] }, reset] });
    await expect(run(gmail, dir)).rejects.toThrow(
      `window listing failed: query "${WINDOW_QUERY}" page 2 status ECONNRESET after ${GMAIL_RETRY_MAX_ATTEMPTS} attempts`,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes the complete manifest summary and returns it with status and triage', async () => {
    const { result, file } = await runOneUnread();

    const manifest = readJson(path.join(dir, 'manifest.json'));
    expect(manifest).toEqual({
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      query: WINDOW_QUERY,
      pages: 1,
      listed: 1,
      inWindow: 1,
      belowBoundaryOrExcluded: 0,
      truncated: false,
      listingComplete: true,
      maxMessages: 2000,
      failures: [],
      crossCheck: {
        status: 'consistent',
        consistent: true,
        complete: true,
        unexplainedIds: [],
        errors: [],
        ...withCounts({ window: 1, spam: 0, trash: 0, anywhere: 1 }),
      },
      messages: [{
        file,
        id: 'a',
        internalDate: String(BOUNDARY + 1000),
        labelIds: ['INBOX', 'UNREAD'],
        from: 'a@example.com',
        subject: 'Subject a',
        dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
        messageIdHeader: null,
        attachments: 0,
      }],
    });
    const { messages, ...summary } = manifest;
    expect(messages).toHaveLength(1);
    expect(result).toEqual({ ...summary, status: 'ok', triage: result.triage });
  });
});

describe('batchFetchWindow: listing failure takes precedence over truncation', () => {
  it('rejects when the listing fails after exceeding the cap and leaves earlier outputs in place', async () => {
    writeEarlierMessage();
    const gmail = fakeGmail({
      lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }, { ids: ['c'] }, httpError(503)] },
    });
    await expect(run(gmail, dir, { max_messages: 2 })).rejects.toThrow(/window listing failed: .* page 3 status 503/);
    expectOnlyEarlierMessage();
  });
});

describe('BatchFetchWindowSchema', () => {
  it('accepts a zoned watermark and an absolute directory, applying defaults', () => {
    expect(BatchFetchWindowSchema.parse({
      watermark: '2026-09-10T14:03:22Z',
      output_dir: '/tmp/out',
    })).toEqual({
      watermark: '2026-09-10T14:03:22Z',
      output_dir: '/tmp/out',
      max_messages: 2000,
      cross_check: true,
    });
    expect(BatchFetchWindowSchema.parse({
      watermark: '2026-09-10T14:03:22.250+01:00',
      output_dir: '/tmp/out',
      max_messages: 5,
      cross_check: false,
    }).max_messages).toBe(5);
  });

  it('rejects a watermark without an explicit zone', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22', output_dir: '/tmp/out' }))
      .toThrow(/zone/);
  });

  it('rejects an impossible calendar date that Date.parse would roll over', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-02-30T00:00:00Z', output_dir: '/tmp/out' }))
      .toThrow(/valid date/);
  });

  it('rejects an unparseable watermark, a relative directory, and bad caps', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-13-40T99:00:00Z', output_dir: '/tmp/out' })).toThrow();
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: 'relative/out' })).toThrow(/absolute/);
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: '/tmp/out', max_messages: 0 })).toThrow();
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: '/tmp/out', extra: 1 })).toThrow();
  });
});

describe('BatchFetchWindowOutputSchema', () => {
  const base = {
    status: 'ok',
    checkedAt: '2026-09-11T12:00:00.000Z',
    emailAddress: 'me@example.com',
    watermark: '2026-09-10T14:03:22Z',
    boundaryMs: 1789000000000,
    query: 'after:1 -in:spam -in:trash',
    pages: 1,
    listed: 0,
    inWindow: 0,
    belowBoundaryOrExcluded: 0,
    truncated: false,
    listingComplete: true,
    maxMessages: 2000,
    failures: [],
    crossCheck: { status: 'skipped', consistent: false, complete: false, unexplainedIds: [], errors: [] },
    triage: [],
  };

  it('requires crossCheck and accepts the skipped, consistent, inconsistent and failed shapes', () => {
    expect(BatchFetchWindowOutputSchema.parse(base)).toEqual(base);
    const { crossCheck: _skipped, ...withoutCheck } = base;
    expect(() => BatchFetchWindowOutputSchema.parse(withoutCheck)).toThrow();

    const ran = { complete: true, unexplainedIds: [], errors: [], counts: { window: 0, spam: 0, trash: 0, anywhere: 0 }, window: 0, spam: 0, trash: 0, anywhere: 0 };
    const consistent = { ...base, crossCheck: { ...ran, status: 'consistent', consistent: true } };
    expect(BatchFetchWindowOutputSchema.parse(consistent)).toEqual(consistent);
    const inconsistent = { ...base, crossCheck: { ...ran, status: 'inconsistent', consistent: false, unexplainedIds: ['x'] } };
    expect(BatchFetchWindowOutputSchema.parse(inconsistent)).toEqual(inconsistent);
    const failed = {
      ...base,
      crossCheck: { ...ran, status: 'failed', consistent: false, complete: false, errors: [{ query: 'in:spam', page: 2, status: 503, attempts: 5 }] },
    };
    expect(BatchFetchWindowOutputSchema.parse(failed)).toEqual(failed);
  });

  it('rejects a crossCheck whose consistent flag contradicts its status', () => {
    const ran = { complete: true, unexplainedIds: [], errors: [], counts: { window: 0, spam: 0, trash: 0, anywhere: 0 }, window: 0, spam: 0, trash: 0, anywhere: 0 };
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, crossCheck: { ...ran, status: 'consistent', consistent: false } })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, crossCheck: { ...ran, status: 'failed', consistent: true } })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, crossCheck: { ...base.crossCheck, consistent: true } })).toThrow();
  });

  it('accepts a numeric or string status on a failure entry and requires operation and attempts', () => {
    const http = { id: 'm1', error: '503', operation: 'messages.get', status: 503, attempts: 5 };
    const network = { id: 'm2', error: 'ECONNRESET', operation: 'body-part-fetch', status: 'ECONNRESET', attempts: 5 };
    expect(BatchFetchWindowOutputSchema.parse({ ...base, failures: [http, network] }).failures).toEqual([http, network]);
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, failures: [{ id: 'm1', error: '503' }] })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, failures: [{ ...http, operation: 'other' }] })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, failures: [{ ...http, attempts: 0 }] })).toThrow();
  });

  it('rejects unknown statuses and extra fields', () => {
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, status: 'done' })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, messages: [] })).toThrow();
  });
});

describe('batch_fetch_window tool definition', () => {
  it('is registered with its annotations and read scopes', () => {
    const tool = getToolByName('batch_fetch_window');
    expect(tool).toBeDefined();
    expect(tool!.scopes).toEqual(['gmail.readonly', 'gmail.modify']);
    expect(tool!.annotations).toEqual({
      title: 'Batch Fetch Window',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tool!.outputSchema).toBe(BatchFetchWindowOutputSchema);
    expect(hasScope(['gmail.readonly'], tool!.scopes)).toBe(true);
  });

  it('sits directly after batch_get_gmail_index_metadata and is MCP-valid', () => {
    const names = toolDefinitions.map(tool => tool.name);
    expect(names.indexOf('batch_fetch_window')).toBe(names.indexOf('batch_get_gmail_index_metadata') + 1);
    expect(() => ListToolsResultSchema.parse({ tools: toMcpTools(toolDefinitions) })).not.toThrow();
  });
});

describe('handleBatchFetchWindow', () => {
  it('rejects invalid arguments with a zod error before touching Gmail', async () => {
    const gmail = fakeGmail({ lists: {} });
    await expect(handleBatchFetchWindow(gmail as never, { watermark: 'nope', output_dir: dir }))
      .rejects.toBeInstanceOf(ZodError);
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
    expect(gmail.list).not.toHaveBeenCalled();
  });

  it('applies defaults, runs the window, and returns a structured MCP result', async () => {
    const gmail = windowOfA();
    const result = await handleBatchFetchWindow(gmail as never, { watermark: WATERMARK, output_dir: dir }, FIXED_NOW);

    expect(result.structuredContent).toMatchObject({ status: 'ok', maxMessages: 2000, inWindow: 1 });
    expect(result.structuredContent.crossCheck).toBeDefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect(() => BatchFetchWindowOutputSchema.parse(result.structuredContent)).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });
});
