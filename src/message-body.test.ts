import { describe, expect, it, vi } from 'vitest';
import { GMAIL_RETRY_MAX_ATTEMPTS, GmailRequestError } from './gmail-sync.js';
import {
  bodySourceOf,
  decodeBase64Url,
  extractMessageParts,
  headerValue,
  htmlToText,
  NAMED_ENTITIES,
  isPlainTextStub,
  resolveMessageBody,
  selectBody,
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

  it('decodes decimal and hexadecimal character references', () => {
    expect(htmlToText('It&#8217;s &#x2019;quoted&#X2019; and &#x1F600;')).toBe('It’s ’quoted’ and 😀');
    expect(htmlToText('a&#8199;&#8199;b')).toBe('a  b');
  });

  it('decodes common named entities beyond the basic five', () => {
    expect(htmlToText('It&rsquo;s 9&ndash;5&hellip; &copy; 2026 &eacute;t&eacute; &euro;10 &mdash; &laquo;x&raquo;'))
      .toBe('It’s 9–5… © 2026 été €10 — «x»');
  });

  it('maps the Latin-1 entity names to their own code points, from iexcl to yuml', () => {
    expect([...NAMED_ENTITIES].filter(([, codePoint]) => codePoint >= 160 && codePoint <= 255)).toHaveLength(96);
    expect(['iexcl', 'copy', 'shy', 'deg', 'iquest', 'Agrave', 'times', 'szlig', 'eacute', 'divide', 'yuml'].map(name => NAMED_ENTITIES.get(name)))
      .toEqual([161, 169, 173, 176, 191, 192, 215, 223, 233, 247, 255]);
  });

  it('turns a no-break space in any spelling into a plain space', () => {
    expect(htmlToText('a&nbsp;b&#160;c&#xA0;d')).toBe('a b c d');
  });

  it('leaves an invalid or unknown reference as written', () => {
    for (const reference of ['&bogus;', '&#xZZ;', '&#1114112;', '&#xD800;', '&#0;', '&rsquo', '& amp;']) {
      expect(htmlToText(`a ${reference} b`), reference).toBe(`a ${reference} b`);
    }
  });

  it('decodes each reference once, so an escaped reference stays a reference', () => {
    expect(htmlToText('&amp;lt;b&amp;gt; &amp;#8217; &amp;amp;')).toBe('&lt;b&gt; &#8217; &amp;');
  });

  it('collapses runs of spaces and blank lines and trims', () => {
    expect(htmlToText('  a  \t b\n\n\n\nc  ')).toBe('a b\n\nc');
  });

  it('reads CRLF and lone CR line endings as LF, so no carriage return survives and blank lines collapse', () => {
    expect(htmlToText('Re Itamin,\r\n\r\n \r\nWe have\rsent it')).toBe(htmlToText('Re Itamin,\n\n \nWe have\nsent it'));
    expect(htmlToText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(htmlToText('a<br>\r\nb')).toBe(htmlToText('a<br>\nb'));
    expect(htmlToText('<p>x</p>\r\n\r\n\r\n<p>y</p>')).not.toContain('\r');
    expect(htmlToText('a&#13;&#10;b&#xD;c')).toBe('a\nb\nc');
  });

  it('keeps the documented behaviour: a br right before a newline is not converted', () => {
    expect(htmlToText('a<br>\nb')).toBe('a\nb');
  });

  it('trims spaces at the ends of each line, so a line of only spaces is blank and collapses', () => {
    expect(htmlToText('Re Itamin,\n\n \nWe have')).toBe('Re Itamin,\n\nWe have');
    expect(htmlToText('<td>a</td> <td>b</td>\n<span> c </span>')).toBe('a b\nc');
  });
});

describe('selectBody', () => {
  const stub = 'Plain text version not available.';
  const html = '<p>It&rsquo;s <b>here</b></p>';

  it('takes a real plain part as it is', () => {
    expect(selectBody('Hello', html, 'keep-html')).toEqual({ body: 'Hello', bodySource: 'text' });
    expect(selectBody('Hello', html, 'convert-html')).toEqual({ body: 'Hello', bodySource: 'text' });
  });

  it('converts the HTML part when the plain part is only a stub, whichever HTML-only rule applies', () => {
    expect(selectBody(stub, html, 'keep-html')).toEqual({ body: 'It’s here', bodySource: 'html-over-stub' });
    expect(selectBody(stub, html, 'convert-html')).toEqual({ body: 'It’s here', bodySource: 'html-over-stub' });
  });

  it('keeps or converts the HTML of an HTML-only message as asked', () => {
    expect(selectBody('', html, 'keep-html')).toEqual({ body: html, bodySource: 'html' });
    expect(selectBody('', html, 'convert-html')).toEqual({ body: 'It’s here', bodySource: 'html' });
  });

  it('gives an empty text body when the message has neither part', () => {
    expect(selectBody('', '', 'convert-html')).toEqual({ body: '', bodySource: 'text' });
  });
});

describe('isPlainTextStub', () => {
  it('recognises the stub wording real senders put in the plain part', () => {
    for (const stub of [
      'This is an HTML message; reading this requires an HTML-capable mail reader.',
      "Your email client doesn't support HTML emails, please view this email in a client that supports HTML.",
      'Plain text version not available.',
      'This message was sent to you as HTML-only.',
      'Having trouble reading this? View it in your browser: https://example.com/v/123',
      'The plain-text version of this email is not available.',
      "  Your mail client can't display HTML.\r\n\r\n  ",
    ]) {
      expect(isPlainTextStub(stub), stub).toBe(true);
    }
  });

  it('keeps short real bodies, and a long body that merely mentions a browser', () => {
    for (const body of [
      'Kind regards Alexander Golev +447887960127',
      'Important information about the times of your upcoming easyJet flight',
      'Closed #295 as completed. -- Reply to this email directly or view it on GitHub: https://github.com/x/y/issues/295',
      `${'Dear Sally, here is the full letter. '.repeat(15)} If the images are missing, view it in your browser.`,
      '',
    ]) {
      expect(isPlainTextStub(body), body).toBe(false);
    }
  });
});

describe('bodySourceOf', () => {
  const stub = 'This is an HTML message; reading this requires an HTML-capable mail reader.';
  it('takes the HTML part over a stub, and only when the HTML part has content', () => {
    expect(bodySourceOf(stub, '<p>Real content</p>')).toBe('html-over-stub');
    expect(bodySourceOf(stub, '  ')).toBe('text');
  });

  it('keeps a real plain part, and names an HTML-only message', () => {
    expect(bodySourceOf('Plain body', '<p>HTML body</p>')).toBe('text');
    expect(bodySourceOf('', '<p>HTML body</p>')).toBe('html');
    expect(bodySourceOf('', '')).toBe('text');
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
    expect(result.bodySource).toBe('text');
    expect(result.failures).toEqual([]);
  });

  it('falls back to converted html when there is no plain text', async () => {
    const gmail = gmailWithAttachments(async () => ({ data: { data: b64('<p>only html</p>') } }));
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/html', body: { attachmentId: 'h' } }],
    });
    expect(result.body).toBe('only html');
    expect(result.bodySource).toBe('html');
  });

  it('delivers the converted HTML part when the plain part is a stub', async () => {
    const result = await resolveMessageBody(gmailWithAttachments(async () => ({ data: {} })) as never, 'm1', {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain text version not available.') } },
        { mimeType: 'text/html', body: { data: b64('<p>Your order <b>#123</b> has shipped.</p>') } },
      ],
    });
    expect(result.body).toBe('Your order #123 has shipped.');
    expect(result.bodySource).toBe('html-over-stub');
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

  it('delivers the HTML part as htmlBody beside a full plain part, inline or deferred, and null without one', async () => {
    const gmail = gmailWithAttachments(async () => ({ data: { data: b64('<p>Deferred</p>') } }));
    const inline = await resolveMessageBody(gmail as never, 'm1', {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Stale reminder') } },
        { mimeType: 'text/html', body: { data: b64('<p>Real content</p>') } },
      ],
    });
    expect(inline).toMatchObject({ body: 'Stale reminder', bodySource: 'text', htmlBody: '<p>Real content</p>' });
    expect(inline).not.toHaveProperty('htmlBodyError');

    const deferred = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain') } },
        { mimeType: 'text/html', body: { attachmentId: 'h' } },
      ],
    });
    expect(deferred.htmlBody).toBe('<p>Deferred</p>');

    const textOnly = await resolveMessageBody(gmail as never, 'm1', { mimeType: 'text/plain', body: { data: b64('Plain') } });
    expect(textOnly.htmlBody).toBeNull();
    expect(textOnly).not.toHaveProperty('htmlBodyError');
  });

  it('gives an empty HTML part as an empty htmlBody, and an attached .html file as no HTML part', async () => {
    const gmail = gmailWithAttachments(async () => ({ data: {} }));
    const empty = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain') } },
        { mimeType: 'text/html', body: { size: 0 } },
      ],
    });
    expect(empty.htmlBody).toBe('');
    const attached = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain') } },
        { mimeType: 'text/html', filename: 'page.html', body: { data: b64('<p>attached</p>') } },
      ],
    });
    expect(attached.htmlBody).toBeNull();
  });

  it('gives htmlBody null and the reason in htmlBodyError when the HTML part cannot be fetched, and not for a failed plain part', async () => {
    const gmail = gmailWithAttachments(async () => { throw httpError(404); });
    const html = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain') } },
        { mimeType: 'text/html', body: { attachmentId: 'gone' } },
      ],
    }, { sleep: async () => {} });
    expect(html).toMatchObject({ body: 'Plain', bodySource: 'text', htmlBody: null, htmlBodyError: 'body-part-fetch: 404' });

    const plain = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'gone' } },
        { mimeType: 'text/html', body: { data: b64('<p>Here</p>') } },
      ],
    }, { sleep: async () => {} });
    expect(plain.htmlBody).toBe('<p>Here</p>');
    expect(plain).not.toHaveProperty('htmlBodyError');
  });

  it('rethrows an auth failure', async () => {
    const unauthorised = httpError(401);
    const gmail = gmailWithAttachments(async () => { throw unauthorised; });
    await expect(resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/plain', body: { attachmentId: 'x' } }],
    })).rejects.toBe(unauthorised);
  });
});
