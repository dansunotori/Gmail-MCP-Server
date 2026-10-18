import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRACTION_TIMEOUT_MS } from './attachment-text/extract.js';
import { createGmailServer } from './server.js';
import { toolDefinitions } from './tools.js';

// The error gaxios throws for a Gmail JSON error response, as observed live.
function gmailError(status: number, message: string, reason: string, extra: Record<string, unknown> = {}) {
  const errors = [{ message, domain: 'global', reason }];
  return Object.assign(new Error(message), {
    code: status,
    errors,
    config: { headers: { Authorization: 'Bearer ya29.secret-token' } },
    response: { status, data: { error: { code: status, message, errors, ...extra } } },
  });
}

const rejects = (error: unknown) => async () => {
  throw error;
};

const ALL_SCOPES = ['gmail.modify', 'gmail.settings.basic'];

async function connect(gmail: unknown, options: { scopes?: string[]; oauth2Client?: unknown } = {}) {
  const server = createGmailServer({
    gmail: gmail as gmail_v1.Gmail,
    oauth2Client: (options.oauth2Client ?? {}) as OAuth2Client,
    authorizedScopes: options.scopes ?? ALL_SCOPES,
    toolPrefix: '',
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'server-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(gmail: unknown, name: string, args: Record<string, unknown>, options?: Parameters<typeof connect>[1]) {
  const client = await connect(gmail, options);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return { isError: result.isError, text: (result.content as Array<{ text: string }>)[0].text };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-server-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('draft_email and send_email', () => {
  function composeGmail() {
    const draftsCreate = vi.fn(async (_params: { requestBody: { message: { raw: string; threadId?: string } } }) => ({ data: { id: 'd-1' } }));
    const messagesSend = vi.fn(async (_params: { requestBody: { raw: string; threadId?: string } }) => ({ data: { id: 'sent-1' } }));
    const threadsGet = vi.fn(async () => ({ data: { messages: [
      { payload: { headers: [{ name: 'Message-ID', value: '<one@example.com>' }] } },
      { payload: { headers: [{ name: 'Message-ID', value: '<two@example.com>' }] } },
    ] } }));
    return {
      gmail: { users: { drafts: { create: draftsCreate }, messages: { send: messagesSend }, threads: { get: threadsGet } } },
      draftsCreate,
      messagesSend,
      threadsGet,
    };
  }
  const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

  it('draft_email saves a draft with its attachment and reports the draft id', async () => {
    const fake = composeGmail();
    const attachment = path.join(dir, 'notes.txt');
    fs.writeFileSync(attachment, 'notes');
    const result = await call(fake.gmail, 'draft_email', { to: ['a@example.com'], subject: 'Notes', body: 'See attached', attachments: [attachment] });
    expect(result).toEqual({ isError: undefined, text: 'Email draft created successfully with ID: d-1' });
    const raw = decode(fake.draftsCreate.mock.calls[0][0].requestBody.message.raw);
    expect(raw).toContain('filename=notes.txt');
    expect(raw).toContain('Subject: Notes');
    expect(fake.messagesSend).not.toHaveBeenCalled();
  });

  // The first Content-Type header of a raw message is its top-level type.
  const topType = (raw: string) => /^Content-Type: ([^;\r\n]+)/m.exec(decode(raw))?.[1];
  const sentRaw = (fake: ReturnType<typeof composeGmail>) => fake.messagesSend.mock.calls[0][0].requestBody.raw;
  const draftRaw = (fake: ReturnType<typeof composeGmail>) => fake.draftsCreate.mock.calls[0][0].requestBody.message.raw;

  for (const [tool, rawOf] of [['send_email', sentRaw], ['draft_email', draftRaw]] as const) {
    it(`${tool} with no mimeType sends an HTML body alone as text/html and both bodies as multipart/alternative`, async () => {
      const htmlOnly = composeGmail();
      expect((await call(htmlOnly.gmail, tool, { to: ['a@example.com'], subject: 's', body: '', htmlBody: '<p>Hi <b>there</b></p>' })).isError).toBeUndefined();
      expect(topType(rawOf(htmlOnly))).toBe('text/html');
      expect(decode(rawOf(htmlOnly))).toContain('<p>Hi <b>there</b></p>');

      const both = composeGmail();
      await call(both.gmail, tool, { to: ['a@example.com'], subject: 's', body: 'Hi there', htmlBody: '<p>Hi there</p>' });
      expect(topType(rawOf(both))).toBe('multipart/alternative');
      expect(decode(rawOf(both))).toContain('Hi there\r\n');
      expect(decode(rawOf(both))).toContain('<p>Hi there</p>');

      const plain = composeGmail();
      await call(plain.gmail, tool, { to: ['a@example.com'], subject: 's', body: 'Just text' });
      expect(topType(rawOf(plain))).toBe('text/plain');
    });

    it(`${tool} keeps the HTML body when a file is attached and no mimeType is given`, async () => {
      const fake = composeGmail();
      const attachment = path.join(dir, 'notes.txt');
      fs.writeFileSync(attachment, 'notes');
      await call(fake.gmail, tool, { to: ['a@example.com'], subject: 's', body: '', htmlBody: '<p>See attached</p>', attachments: [attachment] });
      expect(decode(rawOf(fake))).toContain('<p>See attached</p>');
      expect(decode(rawOf(fake))).toContain('filename=notes.txt');
    });

    it(`${tool} refuses an explicit text/plain beside htmlBody instead of dropping the HTML`, async () => {
      for (const attachments of [undefined, [path.join(dir, 'a.txt')]]) {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        const fake = composeGmail();
        const result = await call(fake.gmail, tool, { to: ['a@example.com'], subject: 's', body: 'Hi', htmlBody: '<p>Hi</p>', mimeType: 'text/plain', ...(attachments ? { attachments } : {}) });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('mimeType text/plain would drop htmlBody');
        expect(fake.messagesSend).not.toHaveBeenCalled();
        expect(fake.draftsCreate).not.toHaveBeenCalled();
      }
    });
  }

  it('update_draft with no mimeType saves an HTML body alone as text/html, and refuses text/plain beside it', async () => {
    const draftsUpdate = vi.fn(async (_params: { id: string; requestBody: { message: { raw: string } } }) => ({ data: { id: 'd-1' } }));
    const gmail = { users: { drafts: { update: draftsUpdate } } };
    expect((await call(gmail, 'update_draft', { draftId: 'd-1', to: ['a@example.com'], subject: 's', body: '', htmlBody: '<p>New</p>' })).isError).toBeUndefined();
    expect(topType(draftsUpdate.mock.calls[0][0].requestBody.message.raw)).toBe('text/html');
    const refused = await call(gmail, 'update_draft', { draftId: 'd-1', to: ['a@example.com'], subject: 's', body: 'x', htmlBody: '<p>New</p>', mimeType: 'text/plain' });
    expect(refused.isError).toBe(true);
    expect(draftsUpdate).toHaveBeenCalledTimes(1);
  });

  it('send_email sends in the thread with threading headers resolved from it', async () => {
    const fake = composeGmail();
    const result = await call(fake.gmail, 'send_email', { to: ['a@example.com'], subject: 'Re: plan', body: 'Agreed', threadId: 'th-1' });
    expect(result).toEqual({ isError: undefined, text: 'Email sent successfully with ID: sent-1' });
    const request = fake.messagesSend.mock.calls[0][0].requestBody;
    expect(request.threadId).toBe('th-1');
    expect(decode(request.raw)).toContain('In-Reply-To: <two@example.com>');
    expect(decode(request.raw)).toContain('References: <one@example.com> <two@example.com>');
    expect(fake.draftsCreate).not.toHaveBeenCalled();
  });
});

describe('unknown arguments', () => {
  it('refuses a misnamed argument with an error result naming it, the intended one and the accepted ones', async () => {
    const get = vi.fn();
    const result = await call({ users: { messages: { get } } }, 'read_email', { message_id: 'm1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown argument: message_id (use messageId instead). Accepted arguments: messageId');
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses an unknown argument on every tool, those that read no arguments included, before any Gmail call', async () => {
    const calls: string[] = [];
    // Any Gmail method reached records its path, so a handler that runs is caught.
    const recorder = (route: string[]): unknown => new Proxy(() => undefined, {
      get: (_target, key) => recorder([...route, String(key)]),
      apply: () => { calls.push(route.join('.')); return Promise.resolve({ data: {} }); },
    });
    const client = await connect(recorder(['gmail']), { scopes: ['gmail.full', 'gmail.modify', 'gmail.settings.basic'] });
    for (const tool of toolDefinitions) {
      const result = await client.callTool({ name: tool.name, arguments: { unexpected_argument: true } });
      expect(result.isError, tool.name).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text, tool.name).toContain('Unknown argument: unexpected_argument');
    }
    await client.close();
    expect(calls).toEqual([]);
  });

  it('refuses an unknown key inside a nested argument too', async () => {
    const create = vi.fn();
    const result = await call({ users: { settings: { filters: { create } } } }, 'create_filter', { criteria: { has_attachment: true }, action: {} });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('criteria: Unknown argument: has_attachment (use hasAttachment instead)');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('get_thread and get_inbox_with_threads bodies', () => {
  const part = (mimeType: string, text: string) => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });
  const message = (id: string, plain: string, html: string) => ({
    id,
    threadId: 'th-1',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'Subject', value: id }],
      parts: [...(plain ? [part('text/plain', plain)] : []), ...(html ? [part('text/html', html)] : [])],
    },
  });
  const threadGmail = () => ({ users: { threads: {
    list: async () => ({ data: { threads: [{ id: 'th-1' }] } }),
    get: async () => ({ data: { messages: [
      message('stubbed', 'View this email in your browser', '<p>The real &amp; full body</p>'),
      message('plain', 'Just text', '<p>Just text</p>'),
      message('html-only', '', '<p>Only HTML</p>'),
    ] } }),
  } } });
  const bodies = (messages: Array<{ messageId: string; body: string; bodySource: string }>) =>
    messages.map(({ messageId, body, bodySource }) => ({ messageId, body, bodySource }));
  const expected = [
    { messageId: 'stubbed', body: 'The real & full body', bodySource: 'html-over-stub' },
    { messageId: 'plain', body: 'Just text', bodySource: 'text' },
    { messageId: 'html-only', body: '<p>Only HTML</p>', bodySource: 'html' },
  ];

  it('get_thread returns the converted HTML part for a stubbed message and reports bodySource per message', async () => {
    const result = await call(threadGmail(), 'get_thread', { threadId: 'th-1' });
    expect(bodies(JSON.parse(result.text).messages)).toEqual(expected);
  });

  it('get_inbox_with_threads chooses each expanded message body the same way', async () => {
    const result = await call(threadGmail(), 'get_inbox_with_threads', { expandThreads: true });
    expect(bodies(JSON.parse(result.text).threads[0].messages)).toEqual(expected);
  });
});

describe('list_inbox_threads', () => {
  it("summarises each thread by its latest message, from the inbox and 50 threads by default", async () => {
    const headers = (from: string, subject: string, date: string) =>
      ({ payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }] } });
    const list = vi.fn(async () => ({ data: { threads: [{ id: 'th-1', snippet: 'Latest words', historyId: 'h-9' }] } }));
    const get = vi.fn(async () => ({ data: { messages: [
      headers('a@example.com', 'Plan', 'Mon, 07 Sep 2026 09:00:00 +0000'),
      headers('b@example.com', 'Re: Plan', 'Mon, 07 Sep 2026 10:00:00 +0000'),
    ] } }));
    const result = await call({ users: { threads: { list, get } } }, 'list_inbox_threads', {});
    expect(JSON.parse(result.text)).toEqual({
      resultCount: 1,
      threads: [{
        threadId: 'th-1',
        snippet: 'Latest words',
        historyId: 'h-9',
        messageCount: 2,
        latestMessage: { from: 'b@example.com', subject: 'Re: Plan', date: 'Mon, 07 Sep 2026 10:00:00 +0000' },
      }],
    });
    expect(list).toHaveBeenCalledWith({ userId: 'me', q: 'in:inbox', maxResults: 50 });
    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'th-1', format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
  });
});

// These tests fork real extraction workers, which take seconds each on a slow CI runner, so they
// get the worker's own limit rather than vitest's five-second default.
describe('get_attachment_text', { timeout: EXTRACTION_TIMEOUT_MS }, () => {
  const pdfGmail = (file: string) => {
    const bytes = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'attachment-text', '__fixtures__', file));
    return { users: { messages: {
      attachments: { get: async () => ({ data: { data: bytes.toString('base64url') } }) },
      get: async () => ({ data: { payload: { mimeType: 'multipart/mixed', parts: [
        { mimeType: 'application/pdf', filename: file, body: { attachmentId: 'refetched', size: bytes.length } },
      ] } } }),
    } } };
  };

  it('returns the attachment\'s name, format, text, truncated flag and sheets', async () => {
    const client = await connect(pdfGmail('report.pdf'));
    const result = await client.callTool({ name: 'get_attachment_text', arguments: { messageId: 'm1', attachmentId: 'a1' } });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ name: 'report.pdf', format: 'pdf', truncated: false, sheets: null });
    expect((result.structuredContent as { text: string }).text).toContain('Quarterly report 2026');
  });

  it('reports a protected file as an error result naming the cause', async () => {
    expect(await call(pdfGmail('protected.pdf'), 'get_attachment_text', { messageId: 'm1', attachmentId: 'a1' })).toEqual({
      isError: true,
      text: 'Failed to get attachment text: protected file: the PDF needs a password to open',
    });
  });
});

describe('MCP tool failures', () => {
  const notFound = () => gmailError(404, 'Requested entity was not found.', 'notFound');

  it('read_email reports Gmail\'s reason and status as an error result', async () => {
    const gmail = { users: { messages: { get: rejects(notFound()) } } };
    expect(await call(gmail, 'read_email', { messageId: 'nope' })).toEqual({
      isError: true,
      text: 'Failed to get message: Requested entity was not found. (code notFound, HTTP 404)',
    });
  });

  it('download_attachment reports a failed download as an error result', async () => {
    const gmail = { users: { messages: { attachments: { get: rejects(gmailError(400, 'Invalid attachment token', 'invalidArgument')) } } } };
    expect(await call(gmail, 'download_attachment', { messageId: 'm1', attachmentId: 'bad', savePath: dir })).toEqual({
      isError: true,
      text: 'Failed to download attachment: Invalid attachment token (code invalidArgument, HTTP 400)',
    });
  });

  it('download_attachment reports missing attachment data as an error result', async () => {
    const gmail = { users: { messages: { attachments: { get: async () => ({ data: {} }) } } } };
    expect(await call(gmail, 'download_attachment', { messageId: 'm1', attachmentId: 'a1', savePath: dir })).toEqual({
      isError: true,
      text: 'Failed to download attachment: No attachment data received',
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('download_email reports a failed download as an error result', async () => {
    const gmail = { users: { messages: { get: rejects(notFound()) } } };
    expect(await call(gmail, 'download_email', { messageId: 'nope', savePath: dir })).toEqual({
      isError: true,
      text: 'Failed to download message: Requested entity was not found. (code notFound, HTTP 404)',
    });
  });

  it('refuses a tool the saved scopes do not grant, as an error result', async () => {
    expect(await call({}, 'send_email', { to: ['a@example.com'], subject: 's', body: 'b' }, { scopes: ['gmail.readonly'] })).toEqual({
      isError: true,
      text: 'Failed to send message: Tool "send_email" is not available. You may need to re-authenticate with additional scopes.',
    });
  });

  it('get_filter keeps Gmail\'s reason and status behind its not-found message', async () => {
    const gmail = { users: { settings: { filters: { get: rejects(notFound()) } } } };
    expect(await call(gmail, 'get_filter', { filterId: 'f1' })).toEqual({
      isError: true,
      text: 'Failed to get filter: Filter with ID "f1" not found. (code notFound, HTTP 404)',
    });
  });

  it('delete_filter and list_filters keep Gmail\'s reason and status', async () => {
    const gmail = { users: { settings: { filters: {
      delete: rejects(notFound()),
      list: rejects(gmailError(403, 'Insufficient Permission', 'insufficientPermissions')),
    } } } };
    expect((await call(gmail, 'delete_filter', { filterId: 'f1' })).text)
      .toBe('Failed to delete filter: Filter with ID "f1" not found. (code notFound, HTTP 404)');
    expect((await call(gmail, 'list_filters', {})).text)
      .toBe('Failed to list filters: Insufficient Permission (code insufficientPermissions, HTTP 403)');
  });

  it('create_filter and create_filter_from_template name the parameter Gmail rejected', async () => {
    const invalid = () => gmailError(400, 'Invalid filter', 'invalidArgument', {
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'criteria' }] }],
    });
    const gmail = { users: { settings: { filters: { create: async () => { throw invalid(); } } } } };
    const expected = 'Invalid filter criteria or action: Invalid filter (code invalidArgument, HTTP 400; rejected parameter: criteria)';
    expect((await call(gmail, 'create_filter', { criteria: { from: 'x' }, action: { addLabelIds: ['L1'] } })).text)
      .toBe(`Failed to create filter: ${expected}`);
    expect((await call(gmail, 'create_filter_from_template', { template: 'fromSender', parameters: { senderEmail: 'x@example.com' } })).text)
      .toBe(`Failed to create filter from template: ${expected}`);
  });

  it('label tools keep Gmail\'s reason and status, with their own context where they add one', async () => {
    const conflict = gmailError(409, 'Label name exists or conflicts', 'failedPrecondition');
    const listFailure = gmailError(500, 'Backend Error', 'backendError');
    const gmail = { users: { labels: {
      create: rejects(conflict),
      get: rejects(notFound()),
      list: rejects(listFailure),
    } } };
    expect((await call(gmail, 'create_label', { name: 'Receipts' })).text)
      .toBe('Failed to create label: Label name exists or conflicts (code failedPrecondition, HTTP 409)');
    expect((await call(gmail, 'update_label', { id: 'L1', name: 'New' })).text)
      .toBe('Failed to update label: Label with ID "L1" not found. (code notFound, HTTP 404)');
    expect((await call(gmail, 'delete_label', { id: 'L1' })).text)
      .toBe('Failed to delete label: Label with ID "L1" not found. (code notFound, HTTP 404)');
    expect((await call(gmail, 'list_email_labels', {})).text)
      .toBe('Failed to list labels: Backend Error (code backendError, HTTP 500)');
    expect((await call(gmail, 'get_or_create_label', { name: 'Receipts' })).text)
      .toBe('Failed to get or create label: Backend Error (code backendError, HTTP 500)');
  });

  it('create_label keeps Gmail\'s fields behind its duplicate-name message', async () => {
    const gmail = { users: { labels: { create: rejects(gmailError(409, 'Label Receipts already exists', 'alreadyExists')) } } };
    expect((await call(gmail, 'create_label', { name: 'Receipts' })).text)
      .toBe('Failed to create label: Label "Receipts" already exists. Please use a different name. (code alreadyExists, HTTP 409)');
  });

  it('delete_label refuses a system label without inventing Gmail fields', async () => {
    const gmail = { users: { labels: { get: async () => ({ data: { id: 'INBOX', name: 'INBOX', type: 'system' } }) } } };
    expect(await call(gmail, 'delete_label', { id: 'INBOX' })).toEqual({
      isError: true,
      text: 'Failed to delete label: Cannot delete system label with ID "INBOX".',
    });
  });

  it('batch_fetch_window keeps the listing\'s reason and status behind its context', async () => {
    const gmail = { users: {
      getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }),
      messages: { list: rejects(gmailError(400, 'Invalid query', 'invalidArgument')) },
    } };
    const result = await call(gmail, 'batch_fetch_window', { watermark: '2026-09-07T12:00:00Z', output_dir: dir });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Failed to fetch window: window listing failed: query ".*" page 1 status 400 after 1 attempt \(code invalidArgument, HTTP 400\)$/);
  });

  it('batch_get_gmail_index_metadata keeps the reason and status of a failed batch part', async () => {
    const boundary = 'batch_response';
    const body = JSON.stringify({ error: { code: 400, message: 'Invalid id value', errors: [{ message: 'Invalid id value', reason: 'invalidArgument' }] } });
    const oauth2Client = {
      request: async () => ({
        data: [
          `--${boundary}`,
          'Content-Type: application/http',
          'Content-ID: <response-gmail-index-0>',
          '',
          'HTTP/1.1 400 Bad Request',
          'Content-Type: application/json; charset=UTF-8',
          '',
          body,
          `--${boundary}--`,
          '',
        ].join('\r\n'),
        headers: new Headers({ 'content-type': `multipart/mixed; boundary=${boundary}` }),
      }),
    };
    expect(await call({}, 'batch_get_gmail_index_metadata', { messageIds: ['bad!'] }, { oauth2Client })).toEqual({
      isError: true,
      text: 'Failed to get index metadata: Gmail batch request for bad! failed with HTTP 400: Invalid id value (code invalidArgument, HTTP 400)',
    });
  });

  it('batch tools name each failed message with Gmail\'s message, reason and status', async () => {
    const modify = async ({ id }: { id: string }) => {
      if (id === '18f2a9c4e1b7d3a0-missing') throw notFound();
      return { data: {} };
    };
    const gmail = { users: { messages: {
      modify,
      delete: modify,
      batchModify: rejects(gmailError(400, 'Invalid label', 'invalidArgument')),
    } } };
    const ids = ['18f2a9c4e1b7d3a0', '18f2a9c4e1b7d3a0-missing'];
    const line = '- 18f2a9c4e1b7d3a0-missing: Requested entity was not found. (code notFound, HTTP 404)';
    expect((await call(gmail, 'batch_modify_emails', { messageIds: ids, addLabelIds: ['L1'] })).text).toContain(line);
    expect((await call(gmail, 'batch_delete_emails', { messageIds: ids }, { scopes: ['gmail.full'] })).text).toContain(line);
    expect((await call(gmail, 'batch_report_phishing', { messageIds: ['18f2a9c4e1b7d3a0'] })).text)
      .toContain('- 18f2a9c4e1b7d3a0: Invalid label (code invalidArgument, HTTP 400)');
  });

  it('never puts a token or request header in the text', async () => {
    const gmail = { users: { messages: { get: rejects(gmailError(401, 'Invalid Credentials', 'authError')) } } };
    const { text } = await call(gmail, 'read_email', { messageId: 'm1' });
    expect(text).toBe('Failed to get message: Invalid Credentials (code authError, HTTP 401)');
    expect(text).not.toMatch(/secret|Bearer|Authorization/);
  });
});
