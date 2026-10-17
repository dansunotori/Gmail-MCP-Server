/**
 * Finding the message part an attachment's bytes came from, shared by get_attachment_text and
 * download_attachment. Gmail issues a new attachment id each time a message is fetched, so the
 * id a caller holds rarely appears in a fresh fetch of the message.
 */

import { headerValue, type MessagePart } from './message-body.js';

export interface AttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

// Every part stored as an attachment, named by its filename or, failing that, the filename in
// its own Content-Disposition header.
export function attachmentParts(part: MessagePart | null | undefined, found: AttachmentPart[] = []): AttachmentPart[] {
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

export type PartLookup = { part: AttachmentPart } | { part: undefined; reason: string };

// The part is the one with the caller's id, else the one attachment of exactly the bytes'
// size, else the message's only attachment. When none of those settles it, the lookup says
// why rather than guess.
export function findAttachmentPart(parts: AttachmentPart[], attachmentId: string, size: number, messageId: string): PartLookup {
  const exact = parts.find(part => part.attachmentId === attachmentId);
  if (exact) return { part: exact };
  const sized = parts.filter(part => part.size === size);
  const distinct = [...new Map(sized.map(part => [`${part.filename}\u0000${part.mimeType}`, part])).values()];
  if (distinct.length === 1) return { part: distinct[0] };
  if (distinct.length === 0 && parts.length === 1) return { part: parts[0] };
  const which = distinct.length > 1
    ? `${distinct.map(label).join(', ')} have its size`
    : `none of ${parts.map(label).join(', ') || 'its parts'} has its size`;
  return { part: undefined, reason: `cannot tell which attachment of message ${messageId} this is: ${which}` };
}
