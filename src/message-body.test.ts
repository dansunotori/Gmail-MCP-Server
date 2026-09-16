import { describe, expect, it, vi } from 'vitest';
import { GMAIL_RETRY_MAX_ATTEMPTS, GmailRequestError } from './gmail-sync.js';
import {
  decodeBase64Url,
  extractMessageParts,
  headerValue,
  htmlToText,
  resolveMessageBody,
} from './message-body.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
}

describe('decodeBase64Url', () => {
  it('decodes base64url and returns empty for missing data', () => {
    expect(decodeBase64Url(b64('héllo?>'))).toBe('héllo?>');
    expect(decodeBase64Url(undefined)).toBe('');
    expect(decodeBase64Url('')).toBe('');
  });
});

describe('headerValue', () => {
  it('matches case-insensitively and returns empty when absent', () => {
    const headers = [{ name: 'From', value: 'a@example.com' }, { name: 'subject', value: 'Hi' }];
    expect(headerValue(headers, 'from')).toBe('a@example.com');
    expect(headerValue(headers, 'SUBJECT')).toBe('Hi');
    expect(headerValue(headers, 'To')).toBe('');
    expect(headerValue(undefined, 'To')).toBe('');
  });
});

describe('extractMessageParts', () => {
  it('defers text and html attachmentId parts without a filename', () => {
    const parts = extractMessageParts({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'big-text' } },
        { mimeType: 'text/html', body: { attachmentId: 'big-html' } },
      ],
    });
    expect(parts.deferredBodies).toEqual([
      { mimeType: 'text/plain', attachmentId: 'big-text' },
      { mimeType: 'text/html', attachmentId: 'big-html' },
    ]);
    expect(parts.attachments).toEqual([]);
  });

  it('lists other attachmentId parts as attachments', () => {
    const parts = extractMessageParts({
      parts: [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att-1', size: 42 } }],
    });
    expect(parts.attachments).toEqual([
      { filename: 'a.pdf', mimeType: 'application/pdf', size: 42, attachmentId: 'att-1' },
    ]);
  });

  it('lists inline data with a filename as an inline attachment', () => {
    const parts = extractMessageParts({
      parts: [{ mimeType: 'image/png', filename: 'logo.png', body: { data: 'AAAA', size: 3 } }],
    });
    expect(parts.attachments).toEqual([
      { filename: 'logo.png', mimeType: 'image/png', size: 3, inlineBase64: 'AAAA' },
    ]);
  });

  it('concatenates text and html parts in tree order, recursing after the part itself', () => {
    const parts = extractMessageParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('one ') } },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('two') } },
            { mimeType: 'text/html', body: { data: b64('<p>two</p>') } },
          ],
        },
      ],
    });
    expect(parts.text).toBe('one two');
    expect(parts.html).toBe('<p>two</p>');
  });

  it('handles a missing payload', () => {
    expect(extractMessageParts(undefined)).toEqual({ text: '', html: '', attachments: [], deferredBodies: [] });
  });
});

describe('htmlToText', () => {
  it('strips style and script blocks', () => {
    expect(htmlToText('<style>p{}</style>a<script>x()</script>b')).toBe('a b');
  });

  it('turns br and block closers into newlines', () => {
    expect(htmlToText('a<br>b</p>c</div>d</tr>e</li>f</h2>g')).toBe('a\nb\nc\nd\ne\nf\ng');
  });

  it('renders anchors as text [href] for double and single quotes', () => {
    expect(htmlToText('<a href="https://x.test/a">Link</a>')).toBe('Link [https://x.test/a]');
    expect(htmlToText("<a href='https://x.test/b'>Link</a>")).toBe('Link [https://x.test/b]');
  });

  it('drops remaining tags and decodes entities', () => {
    expect(htmlToText('<b>x</b>&nbsp;&amp;&lt;&gt;&#39;&apos;&quot;')).toBe('x &<>\'\'"');
  });

  it('collapses runs of spaces and blank lines and trims', () => {
    expect(htmlToText('  a  \t b\n\n\n\nc  ')).toBe('a b\n\nc');
  });

  it('keeps the documented behaviour: a br right before a newline is not converted', () => {
    expect(htmlToText('a<br>\nb')).toBe('a \nb');
  });
});

describe('resolveMessageBody', () => {
  function gmailWithAttachments(handler: (id: string) => Promise<{ data: { data?: string } }>) {
    return { users: { messages: { attachments: { get: vi.fn(({ id }: { id: string }) => handler(id)) } } } };
  }

  it('fetches deferred bodies and prefers plain text', async () => {
    const gmail = gmailWithAttachments(async id => ({ data: { data: b64(id === 'p' ? ' plain ' : '<p>html</p>') } }));
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'p' } },
        { mimeType: 'text/html', body: { attachmentId: 'h' } },
      ],
    });
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'p' });
    expect(result.text).toBe(' plain ');
    expect(result.html).toBe('<p>html</p>');
    expect(result.body).toBe('plain');
    expect(result.failures).toEqual([]);
  });

  it('falls back to converted html when there is no plain text', async () => {
    const gmail = gmailWithAttachments(async () => ({ data: { data: b64('<p>only html</p>') } }));
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/html', body: { attachmentId: 'h' } }],
    });
    expect(result.body).toBe('only html');
  });

  it('records a non-auth fetch failure with its status after exhausting retries and keeps going', async () => {
    const gmail = gmailWithAttachments(async id => {
      if (id === 'bad') throw httpError(429);
      return { data: { data: b64('ok') } };
    });
    const sleep = vi.fn(async () => {});
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'bad' } },
        { mimeType: 'text/plain', body: { attachmentId: 'good' } },
      ],
    }, { sleep });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].code).toBe('body-part-fetch: 429');
    expect(result.failures[0].error).toBeInstanceOf(GmailRequestError);
    expect(result.failures[0].error.status).toBe(429);
    expect(result.failures[0].attempts).toBe(GMAIL_RETRY_MAX_ATTEMPTS);
    expect(result.body).toBe('ok');
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledTimes(1 + GMAIL_RETRY_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(GMAIL_RETRY_MAX_ATTEMPTS - 1);
  });

  it('records a single attempt for a body part that fails with a non-retryable status', async () => {
    const gmail = gmailWithAttachments(async () => { throw httpError(404); });
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/plain', body: { attachmentId: 'gone' } }],
    }, { sleep: async () => {} });
    expect(result.failures[0]).toMatchObject({ code: 'body-part-fetch: 404', attempts: 1 });
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows an auth failure', async () => {
    const unauthorised = httpError(401);
    const gmail = gmailWithAttachments(async () => { throw unauthorised; });
    await expect(resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/plain', body: { attachmentId: 'x' } }],
    })).rejects.toBe(unauthorised);
  });
});
