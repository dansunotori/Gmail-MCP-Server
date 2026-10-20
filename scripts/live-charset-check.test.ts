import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { gmail_v1 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';
import { readEmail } from '../src/read-tools.js';
import { encodeCharset, exitCode, probeMessage, runCharsetCheck } from './live-charset-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const KOI8R_HELLO = [0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4];

describe('encodeCharset', () => {
  it('writes text in the named charset', () => {
    expect([...encodeCharset('Привет', 'koi8-r')]).toEqual(KOI8R_HELLO);
    expect([...encodeCharset('Пa ', 'windows-1251')]).toEqual([0xcf, 0x61, 0x20]);
  });

  it('refuses a character the charset cannot hold', () => {
    expect(() => encodeCharset('€', 'koi8-r')).toThrow('koi8-r has no byte for €');
  });
});

describe('probeMessage', () => {
  it('is a multipart/alternative message with base64 plain and HTML parts in the charset', () => {
    const raw = probeMessage({ address: 'me@example.com', charset: 'koi8-r', text: 'Привет', html: '<p>Привет</p>' });
    expect(raw).toContain('Content-Type: text/plain; charset=koi8-r\r\nContent-Transfer-Encoding: base64\r\n\r\n8NLJ18XU\r\n');
    expect(raw).toContain('Content-Type: text/html; charset=koi8-r\r\n');
    expect(raw).toContain('From: Gmail MCP live charset check <me@example.com>\r\n');
  });
});

// A Gmail that holds each inserted message and serves its parts as the case says Gmail does:
// through attachments.get in the bytes it was written in, or inline already in UTF-8.
function fakeGmail(options: { stored: boolean; declareCharset?: boolean; charsetName?: string; failRead?: boolean; failParts?: boolean }) {
  const held: Array<{ charset: string; text: string; html: string }> = [];
  const trashed: string[] = [];
  const part = (mimeType: string, charset: string, content: string) => {
    const headers = options.declareCharset === false ? [] : [{ name: 'Content-Type', value: `${mimeType}; charset=${options.charsetName ?? charset}` }];
    return options.stored
      ? { mimeType, headers, body: { attachmentId: `${mimeType}-bytes`, size: content.length } }
      : { mimeType, headers, body: { data: Buffer.from(content).toString('base64url') } };
  };
  const gmail = { users: {
    getProfile: vi.fn(async () => ({ data: { emailAddress: 'me@example.com' } })),
    messages: {
      insert: vi.fn(async (params: { media: { body: string } }) => {
        const [, charset] = /charset=([\w-]+)/.exec(params.media.body)!;
        held.push({ charset, ...probeFixture });
        return { data: { id: `m${held.length}` } };
      }),
      get: vi.fn(async ({ id }: { id: string }) => {
        if (options.failRead) throw new Error('read failed');
        const { charset, text, html } = held[Number(id.slice(1)) - 1];
        return { data: { id, threadId: id, payload: { mimeType: 'multipart/alternative', parts: [part('text/plain', charset, text), part('text/html', charset, html)] } } };
      }),
      attachments: { get: vi.fn(async ({ messageId, id }: { messageId: string; id: string }) => {
        if (options.failParts) throw Object.assign(new Error('gone'), { response: { status: 404 } });
        const { charset, text, html } = held[Number(messageId.slice(1)) - 1];
        return { data: { data: encodeCharset(id.startsWith('text/plain') ? text : html, charset).toString('base64url') } };
      }) },
      trash: vi.fn(async ({ id }: { id: string }) => { trashed.push(id); return { data: {} }; }),
    },
  } } as unknown as gmail_v1.Gmail;
  return { gmail, trashed };
}

const probeFixture = { text: 'Проверка кодировки ', html: '<p>Проверка кодировки </p>' };
const CASE = { name: 'stored windows-1251', charset: 'windows-1251', ...probeFixture, served: 'attachments.get' };

describe('runCharsetCheck', () => {
  it('reports each part read back exactly as sent, served the expected way, and moves every message to Bin', async () => {
    const { gmail, trashed } = fakeGmail({ stored: true });
    const report = await runCharsetCheck({ gmail, readEmail, cases: [CASE] });
    expect(report.cases).toEqual([{
      name: 'stored windows-1251',
      charset: 'windows-1251',
      served: { plain: 'attachments.get', html: 'attachments.get' },
      servedAsExpected: true,
      body: { length: CASE.text.length, replacementChars: 0, matchesSent: true },
      htmlBody: { length: CASE.html.length, replacementChars: 0, matchesSent: true },
      errors: {},
    }]);
    expect(trashed).toEqual(['m1']);
    expect(exitCode(report)).toBe(0);
  });

  it('exits 1 when a part reads back garbled, as one with no declared charset does', async () => {
    const report = await runCharsetCheck({ gmail: fakeGmail({ stored: true, declareCharset: false }).gmail, readEmail, cases: [CASE] });
    expect(report.cases[0].body).toMatchObject({ matchesSent: false });
    expect(report.cases[0].body.replacementChars).toBeGreaterThan(0);
    expect(exitCode(report)).toBe(1);
  });

  it('exits 1 when Gmail serves a part another way than the case expects, since the case then tests nothing', async () => {
    const report = await runCharsetCheck({ gmail: fakeGmail({ stored: false }).gmail, readEmail, cases: [CASE] });
    expect(report.cases[0]).toMatchObject({ served: { plain: 'inline', html: 'inline' }, servedAsExpected: false });
    expect(exitCode(report)).toBe(1);
  });

  it('exits 2 when Gmail fails to serve a part, which read_email reports as body-part-fetch rather than throwing', async () => {
    const report = await runCharsetCheck({ gmail: fakeGmail({ stored: true, failParts: true }).gmail, readEmail, cases: [CASE] });
    expect(report.cases[0].errors).toEqual({ plainBodyError: 'body-part-fetch: 404', htmlBodyError: 'body-part-fetch: 404' });
    expect(exitCode(report)).toBe(2);
  });

  it('exits 1 when read_email cannot decode a part, a charset failure being what the check looks for', async () => {
    const report = await runCharsetCheck({ gmail: fakeGmail({ stored: true, charsetName: 'x-no-such-charset' }).gmail, readEmail, cases: [CASE] });
    expect(report.cases[0].errors).toEqual({ plainBodyError: 'body-part-charset: x-no-such-charset', htmlBodyError: 'body-part-charset: x-no-such-charset' });
    expect(exitCode(report)).toBe(1);
  });

  it('still moves the message to Bin when reading it fails, and exits 2', async () => {
    const { gmail, trashed } = fakeGmail({ stored: true, failRead: true });
    const report = await runCharsetCheck({ gmail, readEmail, cases: [CASE] });
    expect(report.errors).toEqual([{ case: 'stored windows-1251', error: 'read failed' }]);
    expect(trashed).toEqual(['m1']);
    expect(exitCode(report)).toBe(2);
  });

  it('is the live:charset-check npm script, built first', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['live:charset-check']).toBe('npm run build && node scripts/live-charset-check.mjs');
  });
});
