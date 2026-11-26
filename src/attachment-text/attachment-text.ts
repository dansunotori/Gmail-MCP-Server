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
  pageOfText,
  type AttachmentFormat,
  type SheetSummary,
  type TextPaging,
} from './formats.js';

// The paging fields are present only when the text is cut or the call gave an offset.
export interface AttachmentText extends Partial<TextPaging> {
  name: string;
  format: AttachmentFormat;
  text: string;
  truncated: boolean;
  sheets: SheetSummary[] | null;
}

export async function getAttachmentText(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; attachmentId: string; offset?: number },
): Promise<AttachmentText> {
  const { offset } = args;
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
    const { text, truncated, ...paging } = pageOfText(decodeTextBytes(bytes), offset);
    return { name, format, text, truncated, sheets: null, ...paging };
  }
  checkMagicBytes(bytes, format);
  const extracted = await extractInWorker(format, name, bytes);
  const { text, truncated, ...paging } = pageOfText(extracted.text, offset);
  return { name, format, text, truncated, sheets: extracted.sheets ?? null, ...paging };
}
