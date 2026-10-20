import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailRequestError } from './gmail-sync.js';
import {
  downloadAttachment,
  downloadEmail,
  extractAttachments,
  extractHeaders,
  formatDownloadAttachmentText,
  formatReadEmailText,
  formatSearchEmailsText,
  getInboxWithThreads,
  getThread,
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

describe('extractAttachments', () => {
  it('lists nested attachments with their exact byte size', () => {
    expect(extractAttachments(fullMessage.payload)).toEqual([
      { id: 'att-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 },
    ]);
  });

  it('names an unnamed attachment after its id and defaults its type', () => {
    expect(extractAttachments({ body: { attachmentId: 'x9', size: 3 } })).toEqual([
      { id: 'x9', filename: 'attachment-x9', mimeType: 'application/octet-stream', size: 3 },
    ]);
  });

  it('lists a deferred part as an attachment only when the window fetch does: not an unnamed text/plain or text/html body part', () => {
    expect(extractAttachments({ mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { attachmentId: 'plain-1', size: 700000 } },
      { mimeType: 'text/html', filename: '', body: { attachmentId: 'html-1', size: 900000 } },
      { mimeType: 'text/html', filename: 'page.html', body: { attachmentId: 'page-1', size: 50 } },
      { mimeType: 'text/csv', body: { attachmentId: 'csv-1', size: 20 } },
    ] })).toEqual([
      { id: 'page-1', filename: 'page.html', mimeType: 'text/html', size: 50 },
      { id: 'csv-1', filename: 'attachment-csv-1', mimeType: 'text/csv', size: 20 },
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
      messageIdHeader: '<abc@example.com>',
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
      bodySource: 'text',
      htmlBody: '<p>HTML body</p>',
      attachments: [{ id: 'att-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 }],
    });
  });

  it('uses the HTML as the body when there is no plain text, and delivers it as htmlBody too', async () => {
    const htmlOnly = { id: 'h', threadId: 't', payload: { mimeType: 'text/html', body: { data: b64('<b>x</b>') } } };
    const { gmail } = fakeGmail({ messages: { h: htmlOnly } });
    const result = await readEmail(gmail, { messageId: 'h' });
    expect(result.body).toBe('<b>x</b>');
    expect(result.bodySource).toBe('html');
    expect(result.htmlBody).toBe('<b>x</b>');
    expect(result.labels).toEqual([]);
  });

  it('gives htmlBody null for a text-only message and says so in the text', async () => {
    const textOnly = { id: 'p', threadId: 't', payload: { mimeType: 'text/plain', body: { data: b64('Just text') } } };
    const result = await readEmail(fakeGmail({ messages: { p: textOnly } }).gmail, { messageId: 'p' });
    expect(result).toMatchObject({ body: 'Just text', bodySource: 'text', htmlBody: null });
    expect(result).not.toHaveProperty('htmlBodyError');
    expect(formatReadEmailText(result).endsWith('Just text\n\nHTML part: none')).toBe(true);
  });

  it('fetches a deferred HTML part for htmlBody without changing body, and reports one it cannot fetch', async () => {
    const deferred = { id: 'd', threadId: 't', payload: {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Stale reminder') } },
        { mimeType: 'text/html', body: { attachmentId: 'html-1', size: 900000 } },
      ],
    } };
    const fetched = fakeGmail({ messages: { d: deferred }, attachments: { 'html-1': Buffer.from('<p>Real content</p>').toString('base64url') } });
    const result = await readEmail(fetched.gmail, { messageId: 'd' });
    expect(fetched.attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'd', id: 'html-1' });
    expect(result).toMatchObject({ body: 'Stale reminder', bodySource: 'text', htmlBody: '<p>Real content</p>', attachments: [] });
    expect(formatReadEmailText(result)).not.toContain('Attachments');

    const missing = fakeGmail({ messages: { d: deferred }, attachments: { 'html-1': Object.assign(new Error('gone'), { response: { status: 404 } }) } });
    const failed = await readEmail(missing.gmail, { messageId: 'd' });
    expect(failed).toMatchObject({ body: 'Stale reminder', bodySource: 'text', htmlBody: null, htmlBodyError: 'body-part-fetch: 404' });
    expect(formatReadEmailText(failed).endsWith('\n\nHTML part not read: body-part-fetch: 404')).toBe(true);
  });

  it('fetches a deferred plain part once and delivers it as the body, as the window fetch does', async () => {
    const deferredPlain = { id: 'dp', threadId: 't', payload: {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'plain-1', size: 700000 } },
        { mimeType: 'text/html', body: { attachmentId: 'html-1', size: 900000 } },
      ],
    } };
    const fake = fakeGmail({ messages: { dp: deferredPlain }, attachments: {
      'plain-1': Buffer.from('Long plain body').toString('base64url'),
      'html-1': Buffer.from('<p>Long HTML body</p>').toString('base64url'),
    } });
    const result = await readEmail(fake.gmail, { messageId: 'dp' });
    expect(result).toMatchObject({
      text: 'Long plain body', html: '<p>Long HTML body</p>', body: 'Long plain body', bodySource: 'text', htmlBody: '<p>Long HTML body</p>',
    });
    expect(fake.attachmentsGet.mock.calls.map(([params]) => params.id).sort()).toEqual(['html-1', 'plain-1']);
  });

  it('gives the reason in plainBodyError, and says so before the body, when the plain part cannot be fetched', async () => {
    const deferredPlain = { id: 'dp', threadId: 't', payload: {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'plain-1', size: 700000 } },
        { mimeType: 'text/html', body: { data: b64('<p>HTML body</p>') } },
      ],
    } };
    const fake = fakeGmail({ messages: { dp: deferredPlain }, attachments: { 'plain-1': Object.assign(new Error('gone'), { response: { status: 404 } }) } });
    const result = await readEmail(fake.gmail, { messageId: 'dp' });
    expect(result).toMatchObject({ plainBodyError: 'body-part-fetch: 404', htmlBody: '<p>HTML body</p>' });
    expect(formatReadEmailText(result)).toContain('\n\n[Note: The plain-text part of this email could not be fetched (body-part-fetch: 404).]\n\n');

    const fine = await readEmail(fakeGmail({ messages: { m1: fullMessage } }).gmail, { messageId: 'm1' });
    expect(fine).not.toHaveProperty('plainBodyError');
    expect(formatReadEmailText(fine)).not.toContain('could not be fetched');
  });

  it('delivers the HTML part converted to text when the plain part is a stub', async () => {
    const stubbed = { id: 's', threadId: 't', payload: {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64("Your email client doesn't support HTML emails, please view this email in a client that supports HTML.") } },
        { mimeType: 'text/html', body: { data: b64('<p>Your appointment is <b>confirmed</b>.</p>') } },
      ],
    } };
    const { gmail } = fakeGmail({ messages: { s: stubbed } });
    const result = await readEmail(gmail, { messageId: 's' });
    expect(result.body).toBe('Your appointment is confirmed .');
    expect(result.bodySource).toBe('html-over-stub');
    expect(formatReadEmailText(result)).toContain(
      '[Note: The plain-text part of this email is only a stub; this is its HTML part converted to text.]\n\nYour appointment is confirmed .',
    );
  });

  it('gives messageIdHeader null when the message has no Message-ID header', async () => {
    const noHeader = { id: 'n', threadId: 't', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 's' }], body: { data: b64('x') } } };
    const { gmail } = fakeGmail({ messages: { n: noHeader } });
    expect((await readEmail(gmail, { messageId: 'n' })).messageIdHeader).toBeNull();
  });

  it('keeps the Message-ID header exactly as the message holds it, whatever the header name\'s case', async () => {
    const raw = { id: 'r', threadId: 't', payload: { mimeType: 'text/plain', headers: [{ name: 'message-id', value: ' <Mixed.Case@Example.COM> ' }], body: { data: b64('x') } } };
    const { gmail } = fakeGmail({ messages: { r: raw } });
    expect((await readEmail(gmail, { messageId: 'r' })).messageIdHeader).toBe(' <Mixed.Case@Example.COM> ');
  });

  const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
  const withCalendar = (id: string, calendar: string) => ({ id, threadId: 't', payload: {
    mimeType: 'multipart/alternative',
    headers: [{ name: 'Subject', value: 'Accepted: Planning' }],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Alexander has accepted.') } },
      { mimeType: 'text/calendar', body: { data: b64(calendar) } },
    ],
  } });

  it('reads the calendar method and, for a reply, the replying attendee and partstat, by the window fetch\'s reader', async () => {
    const reply = ics('METHOD:REPLY', 'BEGIN:VEVENT', 'UID:u1', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com', 'END:VEVENT');
    const { gmail } = fakeGmail({ messages: { c: withCalendar('c', reply) } });
    const result = await readEmail(gmail, { messageId: 'c' });
    expect(result).toMatchObject({ calendarMethod: 'REPLY', calendarReply: { attendee: 'alice@example.com', partstat: 'ACCEPTED' } });
    expect(formatReadEmailText(result)).toContain('\nCalendar: REPLY\nCalendar reply: alice@example.com ACCEPTED\n');

    const invite = await readEmail(fakeGmail({ messages: { i: withCalendar('i', ics('METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u2', 'END:VEVENT')) } }).gmail, { messageId: 'i' });
    expect(invite.calendarMethod).toBe('REQUEST');
    expect(invite).not.toHaveProperty('calendarReply');
  });

  it('carries no calendar field for a message without a calendar part', async () => {
    const result = await readEmail(fakeGmail({ messages: { m1: fullMessage } }).gmail, { messageId: 'm1' });
    expect(result).not.toHaveProperty('calendarMethod');
    expect(result).not.toHaveProperty('calendarReply');
    expect(result).not.toHaveProperty('calendarFailures');
    expect(formatReadEmailText(result)).not.toContain('Calendar');
  });

  it('reports a calendar part it cannot read instead of dropping it', async () => {
    const result = await readEmail(fakeGmail({ messages: { b: withCalendar('b', 'not a calendar') } }).gmail, { messageId: 'b' });
    expect(result).not.toHaveProperty('calendarMethod');
    expect(result.calendarFailures).toEqual([expect.stringMatching(/^calendar-part: /)]);
    expect(formatReadEmailText(result)).toMatch(/\nCalendar part not read: calendar-part: .+\n/);
  });

  it('formats the message exactly as the read_email tool prints it', async () => {
    const { gmail } = fakeGmail({ messages: { m1: fullMessage } });
    const text = formatReadEmailText(await readEmail(gmail, { messageId: 'm1' }));
    expect(text).toBe(
      'Thread ID: t1\nMessage-ID: <abc@example.com>\nSubject: Invoice\nFrom: Billing <billing@example.com>\n'
      + 'To: me@example.com\nCC: boss@example.com\nDate: Mon, 07 Sep 2026 14:00:00 +0000\n\nPlain body'
      + '\n\nAttachments (1):\n- invoice.pdf (application/pdf, 2 KB, ID: att-1)'
      + '\n\nHTML part:\n<p>HTML body</p>',
    );
  });

  it('prints CC and BCC only when present, notes an HTML-only body, and says when there is no Message-ID', () => {
    const base = {
      id: 'x', threadId: 't', messageIdHeader: null, subject: 's', from: 'f', to: 'to', cc: '', bcc: '', date: 'd',
      labels: [], text: '', html: '<p>h</p>', body: '<p>h</p>', bodySource: 'html' as const, htmlBody: '<p>h</p>', attachments: [],
    };
    expect(formatReadEmailText(base)).toBe(
      'Thread ID: t\nMessage-ID: (none)\nSubject: s\nFrom: f\nTo: to\nDate: d\n\n'
      + '[Note: This email is HTML-formatted. Plain text version not available.]\n\n<p>h</p>\n\nHTML part:\n<p>h</p>',
    );
    expect(formatReadEmailText({ ...base, bcc: 'b@x', html: '', body: '', bodySource: 'text', htmlBody: null })).toBe(
      'Thread ID: t\nMessage-ID: (none)\nSubject: s\nFrom: f\nTo: to\nBCC: b@x\nDate: d\n\n\n\nHTML part: none',
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

  it('finds the part by size when Gmail has issued a new attachment id since the caller read the message', async () => {
    const refetched = { ...fullMessage, payload: { ...fullMessage.payload, parts: [
      ...fullMessage.payload.parts.slice(0, 2),
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att-1-refetched', size: 14 } },
      { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo-refetched', size: 999 } },
    ] } };
    const { gmail } = fakeGmail({ messages: { m1: refetched }, attachments: { 'att-1': data } });
    const result = await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'att-1', savePath: dir });
    expect(result).toMatchObject({ filename: 'invoice.pdf', mimeType: 'application/pdf' });
  });

  it('names a part from its own Content-Disposition when Gmail gives it no filename', async () => {
    const message = { payload: { parts: [
      { mimeType: 'text/csv', filename: '', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="figures.csv"' }], body: { attachmentId: 'other', size: 14 } },
    ] } };
    const { gmail } = fakeGmail({ messages: { m1: message }, attachments: { 'c-1': data } });
    expect(await downloadAttachment(gmail, { messageId: 'm1', attachmentId: 'c-1', savePath: dir })).toMatchObject({ filename: 'figures.csv', mimeType: 'text/csv' });
  });

  it('refuses to guess a name between attachments it cannot tell apart, unless a filename is given', async () => {
    const twins = { payload: { parts: [
      { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'x1', size: 14 } },
      { mimeType: 'application/pdf', filename: 'b.pdf', body: { attachmentId: 'x2', size: 14 } },
    ] } };
    const unnamed = fakeGmail({ messages: { m1: twins }, attachments: { old: data } });
    await expect(downloadAttachment(unnamed.gmail, { messageId: 'm1', attachmentId: 'old', savePath: dir }))
      .rejects.toThrow('cannot tell which attachment of message m1 this is: a.pdf, b.pdf have its size; give a filename to save it under');
    expect(fs.readdirSync(dir)).toEqual([]);

    const named = fakeGmail({ messages: { m1: twins }, attachments: { old: data } });
    const result = await downloadAttachment(named.gmail, { messageId: 'm1', attachmentId: 'old', savePath: dir, filename: 'mine.pdf' }, { lookupMimeType: true });
    expect(result).toMatchObject({ filename: 'mine.pdf', mimeType: 'application/octet-stream' });
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

// get_thread, get_inbox_with_threads and download_email's json read a message's text/calendar
// part with read_email's reader, so a thread read tells a meeting response from ordinary mail.
describe('calendar fields in thread reads and the json download', () => {
  const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
  const accept = ics('METHOD:REPLY', 'BEGIN:VEVENT', 'UID:u1', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com', 'END:VEVENT');
  const decline = ics('METHOD:REPLY', 'BEGIN:VEVENT', 'UID:u1', 'ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.com', 'END:VEVENT');
  const calendarMessage = (id: string, calendarPart: Record<string, unknown>) => ({ id, threadId: 'th', payload: {
    mimeType: 'multipart/alternative',
    headers: [{ name: 'Subject', value: `Reply ${id}` }],
    parts: [{ mimeType: 'text/plain', body: { data: b64('A reply.') } }, { mimeType: 'text/calendar', ...calendarPart }],
  } });
  const messages = [
    // One inline, one stored as an attachment, one that cannot be parsed, and ordinary mail.
    calendarMessage('accepted', { body: { data: b64(accept) } }),
    calendarMessage('declined', { body: { attachmentId: 'ics-1', size: decline.length } }),
    calendarMessage('broken', { body: { data: b64('not a calendar') } }),
    fullMessage,
  ];
  const threadGmail = () => {
    const attachmentsGet = vi.fn(async () => ({ data: { data: Buffer.from(decline).toString('base64url') } }));
    const gmail = { users: {
      threads: {
        get: vi.fn(async () => ({ data: { messages } })),
        list: vi.fn(async () => ({ data: { threads: [{ id: 'th' }] } })),
      },
      messages: { attachments: { get: attachmentsGet } },
    } } as unknown as gmail_v1.Gmail;
    return { gmail, attachmentsGet };
  };
  const expectCalendarFields = (read: Array<Record<string, unknown>>) => {
    expect(read[0]).toMatchObject({ calendarMethod: 'REPLY', calendarReply: { attendee: 'alice@example.com', partstat: 'ACCEPTED' } });
    expect(read[1]).toMatchObject({ calendarMethod: 'REPLY', calendarReply: { attendee: 'bob@example.com', partstat: 'DECLINED' } });
    expect(read[2]).not.toHaveProperty('calendarMethod');
    expect(read[2].calendarFailures).toEqual([expect.stringMatching(/^calendar-part: /)]);
    for (const field of ['calendarMethod', 'calendarReply', 'calendarFailures']) expect(read[3]).not.toHaveProperty(field);
  };

  it("getThread gives each message read_email's calendar fields, fetching a part stored as an attachment", async () => {
    const fake = threadGmail();
    const thread = await getThread(fake.gmail, { threadId: 'th' });
    expectCalendarFields(thread.messages);
    expect(fake.attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'declined', id: 'ics-1' });
  });

  it('getInboxWithThreads gives each expanded message the same fields', async () => {
    const inbox = await getInboxWithThreads(threadGmail().gmail, { expandThreads: true });
    expectCalendarFields((inbox.threads[0] as { messages: Array<Record<string, unknown>> }).messages);
  });

  it("downloadEmail's json file carries the fields, and a message without a calendar part none of them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
    try {
      const reply = fakeGmail({ messages: { accepted: messages[0], m1: fullMessage } });
      await downloadEmail(reply.gmail, { messageId: 'accepted', savePath: dir, format: 'json' });
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'accepted.json'), 'utf8'));
      expect(saved).toMatchObject({ calendarMethod: 'REPLY', calendarReply: { attendee: 'alice@example.com', partstat: 'ACCEPTED' } });
      await downloadEmail(reply.gmail, { messageId: 'm1', savePath: dir, format: 'json' });
      const plain = JSON.parse(fs.readFileSync(path.join(dir, 'm1.json'), 'utf8'));
      for (const field of ['calendarMethod', 'calendarReply', 'calendarFailures']) expect(plain).not.toHaveProperty(field);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A body part Gmail defers is the message's body, as the window fetch reads it, never an
// attachment, in every tool that lists attachments.
describe('deferred body parts in thread reads and downloads', () => {
  it('getThread, getInboxWithThreads and downloadEmail list a deferred body part as body, not as an attachment', async () => {
    const deferredHtml = { id: 'dh', threadId: 'th', payload: {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain') } },
        { mimeType: 'text/html', body: { attachmentId: 'html-1', size: 900000 } },
        fullMessage.payload.parts[2],
      ],
    } };
    const gmail = { users: {
      threads: {
        get: vi.fn(async () => ({ data: { messages: [deferredHtml] } })),
        list: vi.fn(async () => ({ data: { threads: [{ id: 'th' }] } })),
      },
      messages: {
        get: vi.fn(async () => ({ data: deferredHtml })),
        attachments: { get: vi.fn(async () => ({ data: { data: Buffer.from('<p>Real</p>').toString('base64url') } })) },
      },
    } } as unknown as gmail_v1.Gmail;
    const pdfOnly = [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 }];
    expect((await getThread(gmail, { threadId: 'th' })).messages[0].attachments).toEqual(pdfOnly);
    const inbox = await getInboxWithThreads(gmail, { expandThreads: true });
    expect((inbox.threads[0] as { messages: Array<{ attachments: unknown }> }).messages[0].attachments).toEqual(pdfOnly);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
    try {
      const saved = await downloadEmail(gmail, { messageId: 'dh', savePath: dir, format: 'json' });
      expect(saved.attachments).toEqual([{ id: 'att-1', ...pdfOnly[0] }]);
      expect(JSON.parse(fs.readFileSync(saved.path, 'utf8')).attachments).toEqual([{ id: 'att-1', ...pdfOnly[0] }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// get_thread, expanded get_inbox_with_threads and download_email read each message's parts
// with read_email's reader, so they carry its body and htmlBody for the same message.
describe('htmlBody in thread reads and the json download', () => {
  const stalePlain = { id: 'sp', threadId: 'th', payload: {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Stale reminder') } },
      { mimeType: 'text/html', body: { attachmentId: 'html-1', size: 900000 } },
    ],
  } };
  const deferredPlain = { id: 'dp', threadId: 'th', payload: {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/plain', body: { attachmentId: 'plain-1', size: 700000 } }],
  } };
  const parts: Record<string, string | Error> = {
    'html-1': Buffer.from('<p>Real content</p>').toString('base64url'),
    'plain-1': Buffer.from('Long plain body').toString('base64url'),
  };
  const gmailFor = (messages: Array<Record<string, unknown>>, failing = false) => {
    const threadsGet = vi.fn(async (_params: { format?: string }) => ({ data: { messages } }));
    const gmail = { users: {
      threads: { get: threadsGet, list: vi.fn(async () => ({ data: { threads: [{ id: 'th' }] } })) },
      messages: {
        get: vi.fn(async ({ id }: { id: string }) => ({ data: messages.find(message => message.id === id) })),
        attachments: { get: vi.fn(async ({ id }: { id: string }) => {
          if (failing) throw Object.assign(new Error('gone'), { response: { status: 404 } });
          return { data: { data: parts[id] } };
        }) },
      },
    } } as unknown as gmail_v1.Gmail;
    return { gmail, threadsGet };
  };

  it("getThread gives each message read in full read_email's body and htmlBody, and htmlBodyError for a part it cannot fetch", async () => {
    const thread = await getThread(gmailFor([stalePlain, deferredPlain, fullMessage]).gmail, { threadId: 'th' });
    expect(thread.messages[0]).toMatchObject({ body: 'Stale reminder', bodySource: 'text', htmlBody: '<p>Real content</p>' });
    expect(thread.messages[1]).toMatchObject({ body: 'Long plain body', bodySource: 'text', htmlBody: null });
    expect(thread.messages[2]).toMatchObject({ body: 'Plain body', htmlBody: '<p>HTML body</p>' });
    for (const message of thread.messages) expect(message).not.toHaveProperty('htmlBodyError');

    const failed = await getThread(gmailFor([stalePlain], true).gmail, { threadId: 'th' });
    expect(failed.messages[0]).toMatchObject({ body: 'Stale reminder', htmlBody: null, htmlBodyError: 'body-part-fetch: 404' });
  });

  it('getThread in metadata or minimal format carries no htmlBody, having no parts to read it from', async () => {
    const headersOnly = { id: 'h', threadId: 'th', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 's' }] } };
    for (const format of ['metadata', 'minimal'] as const) {
      const thread = await getThread(gmailFor([headersOnly]).gmail, { threadId: 'th', format });
      expect(thread.messages[0], format).not.toHaveProperty('htmlBody');
      expect(thread.messages[0], format).not.toHaveProperty('htmlBodyError');
    }
  });

  it('getThread and getInboxWithThreads give the reason in plainBodyError when a plain part cannot be fetched', async () => {
    const thread = await getThread(gmailFor([deferredPlain, fullMessage], true).gmail, { threadId: 'th' });
    expect(thread.messages[0]).toMatchObject({ body: '', plainBodyError: 'body-part-fetch: 404' });
    expect(thread.messages[1]).not.toHaveProperty('plainBodyError');
    const inbox = await getInboxWithThreads(gmailFor([deferredPlain], true).gmail, { expandThreads: true });
    expect((inbox.threads[0] as { messages: Array<Record<string, unknown>> }).messages[0]).toMatchObject({ plainBodyError: 'body-part-fetch: 404' });
  });

  it("downloadEmail's json carries plainBodyError, and the txt format refuses a plain part it cannot fetch with Gmail's status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
    try {
      const failing = gmailFor([deferredPlain], true).gmail;
      await downloadEmail(failing, { messageId: 'dp', savePath: dir, format: 'json' });
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'dp.json'), 'utf8'))).toMatchObject({ plainBodyError: 'body-part-fetch: 404' });
      const refused = await downloadEmail(failing, { messageId: 'dp', savePath: dir, format: 'txt' }).catch(error => error);
      expect(refused).toBeInstanceOf(GmailRequestError);
      expect(refused).toMatchObject({ message: 'The plain-text part could not be fetched: body-part-fetch: 404', status: 404 });
      expect(fs.existsSync(path.join(dir, 'dp.txt'))).toBe(false);
      await downloadEmail(gmailFor([fullMessage]).gmail, { messageId: 'm1', savePath: dir, format: 'json' });
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'm1.json'), 'utf8'))).not.toHaveProperty('plainBodyError');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getInboxWithThreads gives each expanded message the same htmlBody', async () => {
    const inbox = await getInboxWithThreads(gmailFor([stalePlain]).gmail, { expandThreads: true });
    expect((inbox.threads[0] as { messages: Array<Record<string, unknown>> }).messages[0]).toMatchObject({ htmlBody: '<p>Real content</p>' });
  });

  it("downloadEmail's json carries htmlBody and htmlBodyError, and every format reads a deferred part", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
    const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      const { gmail } = gmailFor([stalePlain, deferredPlain, fullMessage]);
      await downloadEmail(gmail, { messageId: 'sp', savePath: dir, format: 'json' });
      expect(JSON.parse(read('sp.json'))).toMatchObject({ body: { text: 'Stale reminder', html: '<p>Real content</p>' }, htmlBody: '<p>Real content</p>' });
      await downloadEmail(gmail, { messageId: 'dp', savePath: dir, format: 'json' });
      const plainOnly = JSON.parse(read('dp.json'));
      expect(plainOnly).toMatchObject({ body: { text: 'Long plain body' }, htmlBody: null });
      expect(plainOnly).not.toHaveProperty('htmlBodyError');
      await downloadEmail(gmail, { messageId: 'dp', savePath: dir, format: 'txt' });
      expect(read('dp.txt')).toContain('\n\nLong plain body');
      await downloadEmail(gmail, { messageId: 'sp', savePath: dir, format: 'html' });
      expect(read('sp.html')).toBe('<p>Real content</p>');

      const failing = gmailFor([stalePlain], true).gmail;
      await downloadEmail(failing, { messageId: 'sp', savePath: dir, format: 'json' });
      expect(JSON.parse(read('sp.json'))).toMatchObject({ htmlBody: null, htmlBodyError: 'body-part-fetch: 404' });
      fs.rmSync(path.join(dir, 'sp.html'));
      const refused = await downloadEmail(failing, { messageId: 'sp', savePath: dir, format: 'html' }).catch(error => error);
      expect(refused).toBeInstanceOf(GmailRequestError);
      expect(refused).toMatchObject({ message: 'The HTML part could not be fetched: body-part-fetch: 404', status: 404 });
      expect(fs.existsSync(path.join(dir, 'sp.html'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
