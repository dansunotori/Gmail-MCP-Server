/**
 * get_attachment_text: an attachment's text, shared by the MCP tool and the
 * gmail-get-attachment-text command. Text parts are decoded here; every other format is
 * checked by its magic bytes and parsed in the extraction worker.
 */

import type { gmail_v1 } from 'googleapis';
import { headerValue, type MessagePart } from '../message-body.js';
import { extractInWorker } from './extract.js';
import {
  AttachmentFileError,
  PLAIN_TEXT_FORMATS,
  SUPPORTED_FORMATS_TEXT,
  checkMagicBytes,
  decodeTextBytes,
  detectFormat,
  truncateAtLine,
  type AttachmentFormat,
  type SheetSummary,
} from './formats.js';

export interface AttachmentText {
  name: string;
  format: AttachmentFormat;
  text: string;
  truncated: boolean;
  sheets: SheetSummary[] | null;
}

interface AttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

// Every part stored as an attachment, named by its filename or, failing that, the filename in
// its own Content-Disposition header.
function attachmentParts(part: MessagePart | null | undefined, found: AttachmentPart[] = []): AttachmentPart[] {
  if (!part) return found;
  const attachmentId = part.body?.attachmentId;
  if (attachmentId) {
    const disposed = headerValue(part.headers, 'Content-Disposition').match(/filename="?([^";]+)/)?.[1] ?? '';
    found.push({ filename: part.filename || disposed, mimeType: part.mimeType ?? '', attachmentId, size: part.body?.size ?? -1 });
  }
  for (const child of part.parts ?? []) attachmentParts(child, found);
  return found;
}

const label = (part: AttachmentPart) => part.filename || part.mimeType || 'unnamed part';

// The message part the bytes came from. Gmail issues a new attachment id each time a message
// is fetched, so the id the caller holds rarely appears in a fresh fetch: the part is the one
// with that id, else the one attachment of exactly the bytes' size, else the message's only
// attachment. When none of those settles it, the tool says so rather than guess.
function findPart(parts: AttachmentPart[], attachmentId: string, size: number, messageId: string): AttachmentPart {
  const exact = parts.find(part => part.attachmentId === attachmentId);
  if (exact) return exact;
  const sized = parts.filter(part => part.size === size);
  const distinct = [...new Map(sized.map(part => [`${part.filename}\u0000${part.mimeType}`, part])).values()];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length === 0 && parts.length === 1) return parts[0];
  const which = distinct.length > 1
    ? `${distinct.map(label).join(', ')} have its size`
    : `none of ${parts.map(label).join(', ') || 'its parts'} has its size`;
  throw new Error(`cannot tell which attachment of message ${messageId} this is: ${which}`);
}

export async function getAttachmentText(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; attachmentId: string },
): Promise<AttachmentText> {
  const attachment = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId: args.messageId,
    id: args.attachmentId,
  });
  const bytes = Buffer.from(attachment.data.data ?? '', 'base64url');
  const message = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
  const part = findPart(attachmentParts(message.data.payload as MessagePart), args.attachmentId, bytes.length, args.messageId);
  const name = part.filename || 'attachment';
  const format = detectFormat(name, part.mimeType);
  if (format === undefined) {
    throw new AttachmentFileError('unsupported', `${name} (${part.mimeType || 'no type'}); supported: ${SUPPORTED_FORMATS_TEXT}`);
  }
  if (PLAIN_TEXT_FORMATS.has(format)) {
    return { name, format, ...truncateAtLine(decodeTextBytes(bytes)), sheets: null };
  }
  checkMagicBytes(bytes, format);
  const extracted = await extractInWorker(format, name, bytes);
  return { name, format, ...truncateAtLine(extracted.text), sheets: extracted.sheets ?? null };
}
