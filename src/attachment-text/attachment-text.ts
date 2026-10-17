/**
 * get_attachment_text: an attachment's text, shared by the MCP tool and the
 * gmail-get-attachment-text command. Text parts are decoded here; every other format is
 * checked by its magic bytes and parsed in the extraction worker.
 */

import type { gmail_v1 } from 'googleapis';
import { attachmentParts, findAttachmentPart } from '../attachment-part.js';
import type { MessagePart } from '../message-body.js';
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
  const found = findAttachmentPart(attachmentParts(message.data.payload as MessagePart), args.attachmentId, bytes.length, args.messageId);
  if (found.part === undefined) throw new Error(found.reason);
  const { part } = found;
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
