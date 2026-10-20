#!/usr/bin/env node
// Checks live that read_email decodes a body part by the charset it names however Gmail serves
// it: a large part through attachments.get, in the bytes it was written in, and a small one
// inline in a format=full message, already in UTF-8. For each case it inserts one unsent,
// unlabelled message (gmail.modify), records how Gmail served each part, reads the message with
// the built readEmail, prints only counts, and moves the message to Bin whatever happens. Exit 0
// when every part reads back as sent and was served as the case expects, 1 when one did not, 2
// when a Gmail call failed, a part Gmail did not serve included.
//
//   npm run live:charset-check
import { runDirectly } from './script-support.mjs';

const PHRASE = 'Проверка кодировки письма для теста ';

export const CASES = [
  { name: 'stored windows-1251', charset: 'windows-1251', bytes: 4 * 1024 * 1024, served: 'attachments.get' },
  { name: 'inline koi8-r', charset: 'koi8-r', bytes: 2 * 1024, served: 'inline' },
].map(({ bytes, ...rest }) => {
  const text = PHRASE.repeat(Math.ceil(bytes / PHRASE.length));
  return { ...rest, text, html: `<html><body><p>${text}</p></body></html>` };
});

// The text in the named charset, one byte per character, from the charset's own decoding table.
export function encodeCharset(text, charset) {
  const decoder = new TextDecoder(charset);
  const bytes = new Map();
  for (let byte = 255; byte >= 0; byte -= 1) bytes.set(decoder.decode(Uint8Array.of(byte)), byte);
  return Buffer.from([...text].map(character => {
    const byte = bytes.get(character);
    if (byte === undefined) throw new Error(`${charset} has no byte for ${character}`);
    return byte;
  }));
}

const base64Lines = buffer => buffer.toString('base64').replace(/.{76}/g, '$&\r\n');

export function probeMessage({ address, charset, text, html }) {
  const part = (mimeType, content) => [
    '--probe',
    `Content-Type: ${mimeType}; charset=${charset}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(encodeCharset(content, charset)),
  ];
  return [
    `From: Gmail MCP live charset check <${address}>`,
    `To: ${address}`,
    'Subject: Gmail MCP live charset check (safe to delete)',
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="probe"',
    '',
    ...part('text/plain', text),
    ...part('text/html', html),
    '--probe--',
    '',
  ].join('\r\n');
}

const counts = (actual, sent) => ({
  length: (actual ?? '').length,
  replacementChars: ((actual ?? '').match(/�/g) ?? []).length,
  matchesSent: actual === sent,
});

const servedAs = part => (part?.body?.attachmentId ? 'attachments.get' : 'inline');

async function runCase(gmail, readEmail, address, kase) {
  const inserted = await gmail.users.messages.insert({
    userId: 'me',
    internalDateSource: 'receivedTime',
    requestBody: { labelIds: [] },
    media: { mimeType: 'message/rfc822', body: probeMessage({ address, ...kase }) },
  });
  const id = inserted.data.id;
  try {
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const parts = data.payload?.parts ?? [];
    const served = {
      plain: servedAs(parts.find(part => part.mimeType === 'text/plain')),
      html: servedAs(parts.find(part => part.mimeType === 'text/html')),
    };
    const email = await readEmail(gmail, { messageId: id });
    return {
      name: kase.name,
      charset: kase.charset,
      served,
      servedAsExpected: served.plain === kase.served && served.html === kase.served,
      body: counts(email.body, kase.text),
      htmlBody: counts(email.htmlBody, kase.html),
      errors: {
        ...(email.plainBodyError === undefined ? {} : { plainBodyError: email.plainBodyError }),
        ...(email.htmlBodyError === undefined ? {} : { htmlBodyError: email.htmlBodyError }),
      },
    };
  } finally {
    await gmail.users.messages.trash({ userId: 'me', id });
  }
}

export async function runCharsetCheck({ gmail, readEmail, cases = CASES }) {
  const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
  /** @type {{ cases: Array<Awaited<ReturnType<typeof runCase>>>, errors: Array<{ case: string, error: string }> }} */
  const report = { cases: [], errors: [] };
  for (const kase of cases) {
    try {
      report.cases.push(await runCase(gmail, readEmail, profile.emailAddress, kase));
    } catch (error) {
      report.errors.push({ case: kase.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

// read_email reports a part Gmail failed to serve as a body-part-fetch error instead of throwing,
// so such a case is a failed Gmail call (2), while a body-part-charset error is a decoding
// failure the check exists to catch (1).
const failedFetch = kase => Object.values(kase.errors).some(code => code.includes('body-part-fetch:'));

export function exitCode(report) {
  if (report.errors.length > 0 || report.cases.some(failedFetch)) return 2;
  const passed = report.cases.every(kase => kase.servedAsExpected && kase.body.matchesSent && kase.htmlBody.matchesSent);
  return passed ? 0 : 1;
}

if (runDirectly(import.meta.url)) {
  try {
    const { liveGmail } = await import('../test/live-gmail.mjs');
    const { readEmail } = await import('../dist/read-tools.js');
    const report = await runCharsetCheck({ gmail: liveGmail(), readEmail });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report);
  } catch (error) {
    process.stderr.write(`live:charset-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
