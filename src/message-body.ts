import type { gmail_v1 } from 'googleapis';
import {
  failureCode,
  GmailRequestError,
  isAuthError,
  retryAttempts,
  toGmailRequestError,
  withGmailRetry,
  type GmailRetryOptions,
} from './gmail-sync.js';

export interface MessageHeader {
  name?: string | null;
  value?: string | null;
}

export interface MessagePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: MessageHeader[] | null;
  body?: {
    attachmentId?: string | null;
    size?: number | null;
    data?: string | null;
  } | null;
  parts?: MessagePart[] | null;
}

export interface MessageAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  inlineBase64?: string;
}

export interface DeferredBody {
  mimeType: string;
  attachmentId: string;
}

export interface ExtractedParts {
  text: string;
  html: string;
  attachments: MessageAttachment[];
  deferredBodies: DeferredBody[];
}

export interface BodyFailure {
  code: string;
  error: GmailRequestError;
  // Calls made to attachments.get for this part before it was given up on.
  attempts: number;
}

// Which part a delivered body came from: the plain part, the HTML part of a message that has
// no plain part, or the HTML part because the plain part is only a stub.
export type BodySource = 'text' | 'html' | 'html-over-stub';

export interface ResolvedBody extends ExtractedParts {
  body: string;
  bodySource: BodySource;
  failures: BodyFailure[];
}

// A plain part longer than this is a real body even if it uses stub wording.
const STUB_MAX_LENGTH = 400;

// The wording senders use when the plain part only points at the HTML part. The one list
// both read_email and batch_fetch_window consult; matched case-insensitively against the
// plain part with its whitespace collapsed.
const STUB_PATTERNS: RegExp[] = [
  /\bhtml[- ]only\b/,
  /\bthis is an html (?:message|e-?mail)\b/,
  /\brequires an html[- ]capable (?:mail|e-?mail) (?:reader|client|program)\b/,
  /\b(?:e-?mail|mail) (?:client|program|reader|software) (?:does not|doesn['’]t|cannot|can['’]t|is unable to) (?:support|display|show|render|read) html\b/,
  /\bplain[- ]text version (?:of this (?:e-?mail|message) )?(?:is )?not available\b/,
  /\bview (?:it|this (?:e-?mail|message|newsletter)) (?:in|on) (?:your|a|the) (?:web )?browser\b/,
];

export function isPlainTextStub(text: string): boolean {
  const collapsed = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return collapsed !== '' && collapsed.length <= STUB_MAX_LENGTH && STUB_PATTERNS.some(pattern => pattern.test(collapsed));
}

export function bodySourceOf(text: string, html: string): BodySource {
  const hasHtml = html.trim() !== '';
  if (text.trim() === '') {
    return hasHtml ? 'html' : 'text';
  }
  return hasHtml && isPlainTextStub(text) ? 'html-over-stub' : 'text';
}

// How a message with no plain part is delivered: tools that return the body inline
// (read_email, get_thread, get_inbox_with_threads) keep its HTML as it is; tools that write a
// text format (download_email's txt and json) convert it to text.
export type HtmlOnlyRule = 'keep-html' | 'convert-html';

// The body every tool that returns one chooses, by bodySourceOf: the plain part as it is, or
// the HTML part converted to text over a stub, or the HTML part as htmlOnly says.
export function selectBody(text: string, html: string, htmlOnly: HtmlOnlyRule): { body: string; bodySource: BodySource } {
  const bodySource = bodySourceOf(text, html);
  if (bodySource === 'text') return { body: text, bodySource };
  if (bodySource === 'html' && htmlOnly === 'keep-html') return { body: html, bodySource };
  return { body: htmlToText(html), bodySource };
}

export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function headerValue(headers: MessageHeader[] | null | undefined, name: string): string {
  return optionalHeader(headers, name) ?? '';
}

// The header's value exactly as the message holds it, or null when the message has no such
// header, so a caller can tell an absent header from an empty one.
export function optionalHeader(headers: MessageHeader[] | null | undefined, name: string): string | null {
  const found = (headers ?? []).find(header => (header.name ?? '').toLowerCase() === name.toLowerCase());
  return found === undefined ? null : found.value ?? '';
}

function walk(payload: MessagePart | null | undefined, out: ExtractedParts): void {
  if (!payload) return;
  const mime = payload.mimeType || '';
  if (payload.body?.attachmentId) {
    const isBody = (mime === 'text/plain' || mime === 'text/html') && !payload.filename;
    if (isBody) {
      out.deferredBodies.push({ mimeType: mime, attachmentId: payload.body.attachmentId });
    } else {
      out.attachments.push({
        filename: payload.filename || '',
        mimeType: mime,
        size: payload.body.size || 0,
        attachmentId: payload.body.attachmentId,
      });
    }
  } else if (payload.body?.data && payload.filename) {
    out.attachments.push({
      filename: payload.filename,
      mimeType: mime,
      size: payload.body.size || 0,
      inlineBase64: payload.body.data,
    });
  } else if (mime === 'text/plain' && payload.body?.data) {
    out.text += decodeBase64Url(payload.body.data);
  } else if (mime === 'text/html' && payload.body?.data) {
    out.html += decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) walk(part, out);
}

export function extractMessageParts(payload: MessagePart | null | undefined): ExtractedParts {
  const out: ExtractedParts = { text: '', html: '', attachments: [], deferredBodies: [] };
  walk(payload, out);
  return out;
}

// HTML's Latin-1 entity names, for code points 160 to 255 in order.
const LATIN1_ENTITY_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn '
  + 'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave '
  + 'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml '
  + 'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN '
  + 'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute '
  + 'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml '
  + 'yacute thorn yuml'
).split(' ');

export const NAMED_ENTITIES: ReadonlyMap<string, number> = new Map([
  ['quot', 34], ['amp', 38], ['apos', 39], ['lt', 60], ['gt', 62],
  ...LATIN1_ENTITY_NAMES.map((name, index): [string, number] => [name, 160 + index]),
  ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376], ['fnof', 402],
  ['circ', 710], ['tilde', 732], ['ensp', 8194], ['emsp', 8195], ['thinsp', 8201], ['zwnj', 8204],
  ['zwj', 8205], ['lrm', 8206], ['rlm', 8207], ['ndash', 8211], ['mdash', 8212], ['lsquo', 8216],
  ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220], ['rdquo', 8221], ['bdquo', 8222],
  ['dagger', 8224], ['Dagger', 8225], ['bull', 8226], ['hellip', 8230], ['permil', 8240],
  ['prime', 8242], ['Prime', 8243], ['lsaquo', 8249], ['rsaquo', 8250], ['euro', 8364],
  ['trade', 8482], ['larr', 8592], ['uarr', 8593], ['rarr', 8594], ['darr', 8595], ['hearts', 9829],
]);

const NO_BREAK_SPACE = 160;

// One pass over every reference, so text that escapes a reference (`&amp;lt;`) keeps it as
// written (`&lt;`) instead of being decoded twice. A reference that names no character (an
// unknown name, a missing semicolon, code point 0, a surrogate or one beyond U+10FFFF) stays
// as written. A no-break space becomes a plain space, so the space collapsing below applies.
function decodeCharacterReferences(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (reference, decimal, hex, name) => {
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10)
      : hex !== undefined ? Number.parseInt(hex, 16)
      : NAMED_ENTITIES.get(name);
    if (codePoint === undefined || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return reference;
    }
    return codePoint === NO_BREAK_SPACE ? ' ' : String.fromCodePoint(codePoint);
  });
}

// CRLF and lone CR, as an HTML part or a decoded &#13; may carry them, read as LF.
const toLf = (text: string) => text.replace(/\r\n?/g, '\n');

// Apply these steps in exactly this order: the plain-text output shape is part of this
// server's contract for downloaded message files, and the <br>-before-newline behaviour (no
// `s` flag) is pinned by a test. Line endings are LF before the <br> rule, so a CRLF part
// converts as its LF form does.
export function htmlToText(html: string): string {
  const withoutTags = toLf(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<a\s[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<[^>]+>/g, ' ');
  return toLf(decodeCharacterReferences(withoutTags))
    .replace(/[ \t]+/g, ' ')
    // A line's leading and trailing spaces are dropped, so a line left holding only a space
    // is blank and collapses with the blank lines around it.
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function resolveMessageBody(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: MessagePart | null | undefined,
  retry: GmailRetryOptions = {},
): Promise<ResolvedBody> {
  const parts = extractMessageParts(payload);
  const failures: BodyFailure[] = [];

  for (const deferred of parts.deferredBodies) {
    try {
      const response = await withGmailRetry(() => gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: deferred.attachmentId,
      }), retry);
      const decoded = decodeBase64Url(response.data.data);
      if (deferred.mimeType === 'text/plain') {
        parts.text += decoded;
      } else {
        parts.html += decoded;
      }
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push({
        code: `body-part-fetch: ${failureCode(error)}`,
        error: toGmailRequestError(error),
        attempts: retryAttempts(error),
      });
    }
  }

  const bodySource = bodySourceOf(parts.text, parts.html);
  const body = bodySource === 'text' ? parts.text.trim() : htmlToText(parts.html);
  return { ...parts, body, bodySource, failures };
}
