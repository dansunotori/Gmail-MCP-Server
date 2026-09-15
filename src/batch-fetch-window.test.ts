import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';

const WATERMARK = '2026-09-07T12:00:00Z';
const BOUNDARY = Date.parse(WATERMARK);
const EPOCH = Math.floor(BOUNDARY / 1000);
const WINDOW_QUERY = `after:${EPOCH - 1} -in:spam -in:trash`;
const SPAM_QUERY = `after:${EPOCH - 1} in:spam`;
const TRASH_QUERY = `after:${EPOCH - 1} in:trash`;
const ANYWHERE_QUERY = `after:${EPOCH - 1} in:anywhere`;
const FIXED_NOW = () => new Date('2026-09-11T12:00:00.000Z');

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function httpError(status: number, reason?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: reason ? { error: { errors: [{ reason }] } } : {} },
  });
}

type Page = { ids: string[] } | Error;
type FakeMessage = Record<string, unknown>;

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
  messages?: Record<string, FakeMessage | Error>;
  attachments?: Record<string, string | Error>;
}) {
  const list = vi.fn(async (params: { q: string; pageToken?: string }) => {
    const pages = config.lists[params.q];
    if (!pages) throw new Error(`unexpected query ${params.q}`);
    const index = params.pageToken ? Number(params.pageToken.slice('page-'.length)) : 0;
    const page = pages[index];
    if (page instanceof Error) throw page;
    const next = index + 1 < pages.length ? `page-${index + 1}` : undefined;
    return { data: { messages: page.ids.map(id => ({ id })), ...(next ? { nextPageToken: next } : {}) } };
  });
  const get = vi.fn(async ({ id }: { id: string }) => {
    const found = config.messages?.[id];
    if (found === undefined) throw new Error(`unexpected message ${id}`);
    if (found instanceof Error) throw found;
    return { data: found };
  });
  const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
    const found = config.attachments?.[id];
    if (found === undefined) throw new Error(`unexpected attachment ${id}`);
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

function windowOnly(ids: string[], extra: Partial<Record<string, Page[]>> = {}) {
  return {
    [WINDOW_QUERY]: [{ ids }],
    [SPAM_QUERY]: [{ ids: [] }],
    [TRASH_QUERY]: [{ ids: [] }],
    [ANYWHERE_QUERY]: [{ ids }],
    ...extra,
  };
}

function run(gmail: ReturnType<typeof fakeGmail>, dir: string, overrides: Partial<BatchFetchWindowInput> = {}) {
  return batchFetchWindow(gmail as never, {
    watermark: WATERMARK,
    output_dir: dir,
    cross_check: true,
    ...overrides,
  }, FIXED_NOW);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('batchFetchWindow: listing, fetching and output files', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual(['001.json', '002.json', '003.json']);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('a');
    expect(readJson(path.join(dir, 'messages', '002.json')).id).toBe('c');
    expect(readJson(path.join(dir, 'messages', '003.json')).id).toBe('b');
    expect(result.triage).toEqual([
      `${path.join(dir, 'messages', '001.json')} | a@example.com | Subject a | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '002.json')} | c@example.com | Subject c | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '003.json')} | b@example.com | Subject b | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
    ]);
  });

  it('writes the reference shapes for the message file and window metadata, and lists the file in the manifest', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1000, { labelIds: ['INBOX', 'UNREAD'] }) },
    });
    const result = await run(gmail, dir);
    const file = path.join(dir, 'messages', '001.json');
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
      snippet: 'snippet a',
      attachments: [],
      body: 'body of a',
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
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
    expect(readJson(path.join(dir, 'manifest.json')).messages).toEqual([]);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toEqual([]);
  });

  it('rejects when the first window page fails and writes nothing', async () => {
    const failure = new Error('network down');
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [failure] } });
    await expect(run(gmail, dir)).rejects.toBe(failure);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects when a later window page fails and writes nothing', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a'] }, httpError(503)] } });
    await expect(run(gmail, dir)).rejects.toMatchObject({ name: 'GmailRequestError', status: 503 });
    expect(gmail.get).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('batchFetchWindow: owned paths and atomic publication', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('replaces messages/ completely on rerun', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await run(gmail, dir);

    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['001.json']);
  });

  it('clears old outputs before a rerun that then fails part-way', async () => {
    const first = fakeGmail({ lists: windowOnly(['old']), messages: { old: message('old', BOUNDARY + 1) } });
    await run(first, dir);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);

    const unauthorised = httpError(401);
    const second = fakeGmail({
      lists: windowOnly(['a', 'b']),
      messages: { a: message('a', BOUNDARY + 1), b: unauthorised },
    });
    await expect(run(second, dir)).rejects.toBe(unauthorised);

    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    // Every fetch completes before any message file is written, so the failed rerun leaves
    // messages/ present but empty: the old content was removed, and nothing new was written.
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
  });

  it('leaves window-metadata but no manifest when the manifest publish fails', async () => {
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.publish-manifest.json')) throw new Error('disk full');
      return original(file, data, options);
    });
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(true);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['messages', 'window-metadata.json']);

    vi.restoreAllMocks();
    const again = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(again, dir);
    expect(result.inWindow).toBe(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });

  it('leaves neither metadata file when the window-metadata publish fails', async () => {
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.publish-window-metadata.json')) throw new Error('disk full');
      return original(file, data, options);
    });
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // Regression guard: passes already, because Step 3 touches nothing outside the three owned
  // paths; it protects that property against the deletions Step 7 adds.
  it('leaves no publish temporaries and never touches unrelated caller files', async () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp-123'), 'also keep me');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await run(gmail, dir);

    expect(fs.readdirSync(dir).sort()).toEqual(['manifest.json', 'manifest.json.tmp-123', 'messages', 'notes.txt', 'window-metadata.json']);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(dir, 'manifest.json.tmp-123'), 'utf8')).toBe('also keep me');
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });
});

describe('batchFetchWindow: boundary and label filtering', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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

  it('skips a listed message labelled SPAM', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['s', 'a']),
      messages: {
        s: message('s', BOUNDARY + 1, { labelIds: ['SPAM'] }),
        a: message('a', BOUNDARY + 2),
      },
    });
    const result = await run(gmail, dir);

    expect(result.inWindow).toBe(1);
    expect(result.belowBoundaryOrExcluded).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['001.json']);
  });
});

describe('batchFetchWindow: body resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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

  it('converts an HTML-only message to plain text with the reference rules', async () => {
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
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('widens padding to four digits when more than 999 messages survive', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `m${index}`);
    const messages = Object.fromEntries(ids.map((id, index) => [id, message(id, BOUNDARY + index)]));
    const gmail = fakeGmail({ lists: windowOnly(ids), messages });
    await run(gmail, dir);

    const files = fs.readdirSync(path.join(dir, 'messages')).sort();
    expect(files).toHaveLength(1000);
    expect(files[0]).toBe('0001.json');
    expect(files[999]).toBe('1000.json');
  });
});

describe('batchFetchWindow: per-message failures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records one messages.get failure with its status and still writes the rest', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'bad', 'c']),
      messages: { a: message('a', BOUNDARY + 1), bad: httpError(500), c: message('c', BOUNDARY + 2) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: 'bad', error: '500' }]);
    expect(result.inWindow).toBe(2);
    expect(result.belowBoundaryOrExcluded).toBe(0);
    expect(readJson(path.join(dir, 'manifest.json')).failures).toEqual([{ id: 'bad', error: '500' }]);
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual(['001.json', '002.json']);
  });

  it('reports status ok with no failures for a clean run', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
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
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
  });

  it('rejects on a 403 insufficientPermissions from messages.get', async () => {
    const forbidden = httpError(403, 'insufficientPermissions');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: forbidden } });
    await expect(run(gmail, dir)).rejects.toBe(forbidden);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // Regression guard: passes already, because Task 2's lister rethrows auth errors on any page.
  it('rejects on a 401 on window page two and writes nothing', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a'] }, unauthorised] } });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('batchFetchWindow: body-part failures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records a body-part failure by code and still writes the message', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'big' } },
        }),
      },
      attachments: { big: httpError(429) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: 'a', error: 'body-part-fetch: 429' }]);
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('');
  });

  // Regression guard: passes already, because Task 3's resolveMessageBody rethrows auth errors.
  it('rejects on a 401 from a deferred body fetch', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1, { payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'big' } } }) },
      attachments: { big: unauthorised },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
  });
});

describe('batchFetchWindow: cross-check', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists spam, trash and anywhere and reports a consistent cross-check in the result and the manifest', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(gmail, dir);

    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: SPAM_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: TRASH_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: ANYWHERE_QUERY, includeSpamTrash: true }));
    const expected = { window: 1, spam: 0, trash: 0, anywhere: 1, unexplainedIds: [], consistent: true };
    expect(result.status).toBe('ok');
    expect(result.crossCheck).toEqual(expected);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toEqual(expected);
  });

  // Regression guard: passes already, because nothing lists spam, trash or anywhere before
  // Step 3; it fails the moment Step 3 runs those listings without honouring cross_check.
  it('skips the cross-check when disabled', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: [] }] } });
    const result = await run(gmail, dir, { cross_check: false });

    expect(result.status).toBe('ok');
    expect(result.crossCheck).toBeUndefined();
    expect(gmail.list).toHaveBeenCalledTimes(1);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toBeUndefined();
  });
});

describe('batchFetchWindow: cross-check outcomes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('flags an unexplained anywhere ID as inconsistent', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [ANYWHERE_QUERY]: [{ ids: ['a', 'ghost'] }] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.crossCheck).toEqual({ window: 1, spam: 0, trash: 0, anywhere: 2, unexplainedIds: ['ghost'], consistent: false });
    expect(result.failures).toEqual([]);
  });

  it('records a cross-check listing failure and keeps the message files', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [SPAM_QUERY]: [httpError(503)] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: `cross-check:${SPAM_QUERY}`, error: '503' }]);
    expect(result.crossCheck?.spam).toBe(0);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  it('reports the network error code for a later cross-check page failure', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [TRASH_QUERY]: [{ ids: [] }, reset] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: `cross-check:${TRASH_QUERY}`, error: 'ECONNRESET' }]);
  });

  // Passes at this point only because Step 3's listings have no catch, so the 401 propagates;
  // it exists to fail the moment Step 7 adds a catch without the isAuthError rethrow.
  it('rejects on a 401 from the spam cross-check and leaves no manifest', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [SPAM_QUERY]: [unauthorised] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });
});
