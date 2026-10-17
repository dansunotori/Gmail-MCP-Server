/**
 * Building and saving outgoing mail, shared by the MCP tools (send_email, draft_email,
 * reply_all) and the gmail-create-draft command-line tool, so both make the same Gmail calls
 * and build the same message.
 */

import type { gmail_v1 } from 'googleapis';
import type { z } from 'zod';
import { headerValue, type MessagePart } from './message-body.js';
import { parseEmailAddresses } from './reply-all-helpers.js';
import type { SendEmailSchema } from './tools.js';
import { createEmailMessage, createEmailWithNodemailer, needsRawBuilder } from './utl.js';

// The tool's request, plus the References chain resolveThreadingHeaders may add.
export type ComposeArgs = z.infer<typeof SendEmailSchema> & { references?: string };

// When a thread is named but In-Reply-To is not, take In-Reply-To from the thread's last
// message and References from all of them. A thread that cannot be read leaves the headers
// unset: the message is still built, just not threaded by header.
export async function resolveThreadingHeaders(
  gmail: gmail_v1.Gmail,
  args: ComposeArgs,
  warn: (line: string) => void = console.warn,
): Promise<void> {
  if (!args.threadId || args.inReplyTo) {
    return;
  }
  try {
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: args.threadId,
      format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
    const threadMessages = threadResponse.data.messages || [];
    if (threadMessages.length === 0) {
      return;
    }
    const allMessageIds = threadMessages
      .map(message => headerValue(message.payload?.headers, 'Message-ID'))
      .filter(value => value !== '');
    const lastMessageId = headerValue(threadMessages[threadMessages.length - 1].payload?.headers, 'Message-ID');
    if (lastMessageId) {
      args.inReplyTo = lastMessageId;
    }
    if (allMessageIds.length > 0) {
      args.references = allMessageIds.join(' ');
    }
  } catch (threadError: any) {
    warn(`Warning: Could not fetch thread ${args.threadId} for header resolution: ${threadError.message}`);
  }
}

// The RFC 822 message, base64url-encoded as Gmail's raw field takes it. Mail with
// attachments or inline images goes through the nodemailer builder; plain and simple HTML
// mail through the lightweight one.
export async function encodeMessage(args: ComposeArgs): Promise<string> {
  const message = needsRawBuilder(args) ? await createEmailWithNodemailer(args) : createEmailMessage(args);
  return Buffer.from(message).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function messageRequest(raw: string, args: ComposeArgs): gmail_v1.Schema$Message {
  return { raw, ...(args.threadId ? { threadId: args.threadId } : {}) };
}

// Saves a draft (never sends) and returns its id.
export async function createDraft(gmail: gmail_v1.Gmail, args: ComposeArgs): Promise<string> {
  await resolveThreadingHeaders(gmail, args);
  const raw = await encodeMessage(args);
  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: messageRequest(raw, args) },
  });
  return response.data.id ?? '';
}

export interface DraftReadBack {
  draft_id: string;
  message_id: string;
  thread_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: Array<{ name: string; size: number }>;
}

// Attachment parts of a saved message: parts with a filename, except images embedded in the
// HTML body, which are inline AND carry the Content-ID the HTML refers to. An inline part
// without a Content-ID is still an attachment: nodemailer marks an attached message/rfc822
// that way.
function attachmentsOf(part: MessagePart | null | undefined, found: Array<{ name: string; size: number }> = []) {
  if (!part) return found;
  const disposition = headerValue(part.headers, 'Content-Disposition').toLowerCase();
  const embedded = disposition.startsWith('inline') && headerValue(part.headers, 'Content-ID') !== '';
  if (part.filename && !embedded) {
    found.push({ name: part.filename, size: part.body?.size ?? 0 });
  }
  for (const child of part.parts ?? []) attachmentsOf(child, found);
  return found;
}

// The draft as Gmail saved it, read back with drafts.get rather than echoed from the request.
export async function readDraft(gmail: gmail_v1.Gmail, draftId: string): Promise<DraftReadBack> {
  const response = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
  const message = response.data.message ?? {};
  const payload = message.payload as MessagePart | undefined;
  const headers = payload?.headers;
  return {
    draft_id: response.data.id ?? draftId,
    message_id: message.id ?? '',
    thread_id: message.threadId ?? '',
    to: parseEmailAddresses(headerValue(headers, 'To')),
    cc: parseEmailAddresses(headerValue(headers, 'Cc')),
    bcc: parseEmailAddresses(headerValue(headers, 'Bcc')),
    subject: headerValue(headers, 'Subject'),
    attachments: attachmentsOf(payload),
  };
}
