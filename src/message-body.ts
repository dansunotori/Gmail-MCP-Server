import type { gmail_v1 } from 'googleapis';
import {
  failureCode,
  GmailRequestError,
  isAuthError,
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
}

export interface ResolvedBody extends ExtractedParts {
  body: string;
  failures: BodyFailure[];
}

export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function headerValue(headers: MessageHeader[] | null | undefined, name: string): string {
  const found = (headers ?? []).find(header => (header.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
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

// The exact regex chain the design document specifies, in this order. Do not "fix" the
// regexes: consumers rely on the output being stable, and the <br>-before-newline
// behaviour (no `s` flag) is documented and pinned by a test rather than changed here.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<a\s[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
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
      });
    }
  }

  const body = parts.text.trim() || htmlToText(parts.html);
  return { ...parts, body, failures };
}
