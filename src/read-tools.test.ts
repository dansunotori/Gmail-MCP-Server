import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAttachment,
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  formatDownloadAttachmentText,
  formatReadEmailText,
  formatSearchEmailsText,
  readEmail,
  searchEmails,
} from './read-tools.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

function fakeGmail(config: {
  listed?: Array<{ id: string }>;
  messages?: Record<string, Record<string, unknown>>;
  attachments?: Record<string, string | null | Error>;
}) {
  const list = vi.fn(async (_params: { q: string; maxResults: number }) => ({ data: { messages: config.listed } }));
  const get = vi.fn(async ({ id }: { id: string; format?: string }) => {
    const found = config.messages?.[id];
    if (!found) throw Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
    return { data: found };
  });
  const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
    const found = config.attachments?.[id];
    if (found instanceof Error) throw found;
    return { data: { data: found } };
  });
  const gmail = { users: { messages: { list, get, attachments: { get: attachmentsGet } } } } as unknown as gmail_v1.Gmail;
  return { gmail, list, get, attachmentsGet };
}

const fullMessage = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Subject', value: 'Invoice' },
      { name: 'From', value: 'Billing <billing@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Cc', value: 'boss@example.com' },
      { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
      { name: 'Message-ID', value: '<abc@example.com>' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Plain body') } },
      { mimeType: 'text/html', body: { data: b64('<p>HTML body</p>') } },
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att-1', size: 2048 } },
    ],
  },
};

describe('extractHeaders', () => {
  it('returns subject, from, to, cc, bcc, date and the RFC Message-ID, case-insensitively', () => {
    const headers = extractHeaders({
      headers: [
        { name: 'subject', value: 'S' },
        { name: 'FROM', value: 'F' },
        { name: 'To', value: 'T' },
        { name: 'Cc', value: 'C' },
        { name: 'Bcc', value: 'B' },
        { name: 'Date', value: 'D' },
        { name: 'Message-Id', value: '<id@x>' },
      ],
    });
    expect(headers).toEqual({ subject: 'S', from: 'F', to: 'T', cc: 'C', bcc: 'B', date: 'D', rfcMessageId: '<id@x>' });
  });

  it('returns empty strings when the payload has no headers', () => {
    expect(extractHeaders(undefined)).toEqual({ subject: '', from: '', to: '', cc: '', bcc: '', date: '', rfcMessageId: '' });
  });
});

describe('extractEmailContent and extractAttachments', () => {
  it('collects nested text and HTML and lists attachments with their exact byte size', () => {
    expect(extractEmailContent(fullMessage.payload)).toEqual({ text: 'Plain body', html: '<p>HTML body</p>' });
    expect(extractAttachments(fullMessage.payload)).toEqual([
      { id: 'att-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 },
    ]);
  });

  it('names an unnamed attachment after its id and defaults its type', () => {
    expect(extractAttachments({ body: { attachmentId: 'x9', size: 3 } })).toEqual([
      { id: 'x9', filename: 'attachment-x9', mimeType: 'application/octet-stream', size: 3 },
    ]);
  });
});

describe('searchEmails', () => {
  it('lists with the query and a default of 10 results, and fetches Subject, From and Date for each', async () => {
    const { gmail, list, get } = fakeGmail({
      listed: [{ id: 'a' }, { id: 'b' }],
      messages: {
        a: { payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'x@y' }, { name: 'Date', value: 'D1' }] } },
        b: { payload: { headers: [] } },
      },
    });
    const results = await searchEmails(gmail, { query: 'from:x@y' });
    expect(list).toHaveBeenCalledWith({ userId: 'me', q: 'from:x@y', maxResults: 10 });
    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'a', format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
    expect(results).toEqual([
      { id: 'a', subject: 'Hi', from: 'x@y', date: 'D1' },
      { id: 'b', subject: '', from: '', date: '' },
    ]);
  });

  it('passes maxResults through and returns nothing when Gmail lists nothing', async () => {
    const { gmail, list } = fakeGmail({ listed: undefined });
    expect(await searchEmails(gmail, { query: 'q', maxResults: 3 })).toEqual([]);
    expect(list).toHaveBeenCalledWith({ userId: 'me', q: 'q', maxResults: 3 });
  });

  it('formats the listing exactly as the search_emails tool prints it', () => {
    expect(formatSearchEmailsText([
      { id: 'a', subject: 'Hi', from: 'x@y', date: 'D1' },
      { id: 'b', subject: '', from: '', date: '' },
    ])).toBe('ID: a\nSubject: Hi\nFrom: x@y\nDate: D1\n\nID: b\nSubject: \nFrom: \nDate: \n');
    expect(formatSearchEmailsText([])).toBe('');
  });
});

describe('readEmail', () => {
  it('returns headers, labels, both bodies and attachments from one full fetch', async () => {
    const { gmail, get } = fakeGmail({ messages: { m1: fullMessage } });
    const result = await readEmail(gmail, { messageId: 'm1' });
    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'm1', format: 'full' });
    expect(result).toEqual({
      id: 'm1',
      threadId: 't1',
      rfcMessageId: '<abc@example.com>',
      subject: 'Invoice',
      from: 'Billing <billing@example.com>',
      to: 'me@example.com',
      cc: 'boss@example.com',
      bcc: '',
      date: 'Mon, 07 Sep 2026 14:00:00 +0000',
      labels: ['INBOX', 'UNREAD'],
      text: 'Plain body',
      html: '<p>HTML body</p>',
      body: 'Plain body',
      attachments: [{ id: 'att-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 }],
    });
  });

  it('uses the HTML as the body when there is no plain text', async () => {
    const htmlOnly = { id: 'h', threadId: 't', payload: { mimeType: 'text/html', body: { data: b64('<b>x</b>') } } };
    const { gmail } = fakeGmail({ messages: { h: htmlOnly } });
    const result = await readEmail(gmail, { messageId: 'h' });
    expect(result.body).toBe('<b>x</b>');
    expect(result.labels).toEqual([]);
  });

  it('formats the message exactly as the read_email tool prints it', async () => {
    const { gmail } = fakeGmail({ messages: { m1: fullMessage } });
    const text = formatReadEmailText(await readEmail(gmail, { messageId: 'm1' }));
    expect(text).toBe(
      'Thread ID: t1\nMessage-ID: <abc@example.com>\nSubject: Invoice\nFrom: Billing <billing@example.com>\n'
      + 'To: me@example.com\nCC: boss@example.com\nDate: Mon, 07 Sep 2026 14:00:00 +0000\n\nPlain body'
      + '\n\nAttachments (1):\n- invoice.pdf (application/pdf, 2 KB, ID: att-1)',
    );
  });

  it('prints CC and BCC only when present, and notes an HTML-only body', () => {
    const base = {
      id: 'x', threadId: 't', rfcMessageId: '', subject: 's', from: 'f', to: 'to', cc: '', bcc: '', date: 'd',
      labels: [], text: '', html: '<p>h</p>', body: '<p>h</p>', attachments: [],
    };
    expect(formatReadEmailText(base)).toBe(
      'Thread ID: t\nMessage-ID: \nSubject: s\nFrom: f\nTo: to\nDate: d\n\n'
      + '[Note: This email is HTML-formatted. Plain text version not available.]\n\n<p>h</p>',
    );
    expect(formatReadEmailText({ ...base, bcc: 'b@x', html: '', body: '' })).toBe(
      'Thread ID: t\nMessage-ID: \nSubject: s\nFrom: f\nTo: to\nBCC: b@x\nDate: d\n\n',
    );
  });
});

describe('downloadAttachment', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const data = Buffer.from('%PDF-1.7 bytes').toString('base64url');

  it('saves under the original filename and reports path, size and the part MIME type', async () => {
    const { gmail } = fakeGmail({ messages: { m1: fullMessage }, attachments: { 'att-1': data } });
    const result = await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir });
    const saved = path.join(dir, 'invoice.pdf');
    expect(result).toEqual({ filename: 'invoice.pdf', path: saved, size: 14, mimeType: 'application/pdf' });
    expect(fs.readFileSync(saved, 'utf8')).toBe('%PDF-1.7 bytes');
    expect(formatDownloadAttachmentText(result)).toBe(
      `Attachment downloaded successfully:\nFile: invoice.pdf\nSize: 14 bytes\nSaved to: ${saved}`,
    );
  });

  it('with a filename, skips the message fetch unless the MIME type is asked for', async () => {
    const plain = fakeGmail({ messages: { m1: fullMessage }, attachments: { 'att-1': data } });
    const result = await downloadAttachment(plain.gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir, filename: 'mine.pdf' });
    expect(plain.get).not.toHaveBeenCalled();
    expect(result.mimeType).toBeUndefined();
    expect(result.path).toBe(path.join(dir, 'mine.pdf'));

    const typed = fakeGmail({ messages: { m1: fullMessage }, attachments: { 'att-1': data } });
    const withType = await downloadAttachment(
      typed.gmail,
      { messageId: 'm1', attachmentId: 'att-1', savePath: dir, filename: 'mine.pdf' },
      { lookupMimeType: true },
    );
    expect(typed.get).toHaveBeenCalledTimes(1);
    expect(withType).toMatchObject({ filename: 'mine.pdf', mimeType: 'application/pdf' });
  });

  it('reduces a hostile filename to its base name inside the save directory', async () => {
    const { gmail } = fakeGmail({ attachments: { 'att-1': data } });
    const result = await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir, filename: '../../etc/passwd' });
    expect(result.path).toBe(path.join(dir, 'passwd'));
  });

  it('falls back to attachment-<id> and octet-stream when the part is not in the message', async () => {
    const { gmail } = fakeGmail({ messages: { m1: { payload: { parts: [] } } }, attachments: { zz: data } });
    const result = await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'zz', savePath: dir });
    expect(result).toMatchObject({ filename: 'attachment-zz', mimeType: 'application/octet-stream' });
  });

  it('creates a missing save directory', async () => {
    const { gmail } = fakeGmail({ messages: { m1: fullMessage }, attachments: { 'att-1': data } });
    const nested = path.join(dir, 'a', 'b');
    const result = await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: nested });
    expect(result.path).toBe(path.join(nested, 'invoice.pdf'));
  });

  it('throws, writing nothing, when Gmail returns no data or fails', async () => {
    const empty = fakeGmail({ attachments: { 'att-1': null } });
    await expect(downloadAttachment(empty.gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir }))
      .rejects.toThrow('No attachment data received');
    const failing = fakeGmail({ attachments: { 'att-1': new Error('boom') } });
    await expect(downloadAttachment(failing.gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir }))
      .rejects.toThrow('boom');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
