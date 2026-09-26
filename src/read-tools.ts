/**
 * The read_email, search_emails and download_attachment tools, shared by the MCP server and
 * the command-line tools. Each tool is a function returning structured data plus a formatter
 * that renders the exact text the MCP server returns, so both surfaces make the same Gmail
 * calls and cannot drift apart.
 */

import fs from 'fs';
import path from 'path';
import type { gmail_v1 } from 'googleapis';
import { EmailAttachment } from './email-export.js';

// Type definitions for Gmail API responses
export interface GmailMessagePart {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers?: Array<{
        name: string;
        value: string;
    }>;
    body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
    };
    parts?: GmailMessagePart[];
}

export interface EmailContent {
    text: string;
    html: string;
}

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
export function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    // Initialize containers for different content types
    let textContent = '';
    let htmlContent = '';

    // If the part has a body with data, process it based on MIME type
    if (messagePart.body && messagePart.body.data) {
        const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');

        // Store content based on its MIME type
        if (messagePart.mimeType === 'text/plain') {
            textContent = content;
        } else if (messagePart.mimeType === 'text/html') {
            htmlContent = content;
        }
    }

    // If the part has nested parts, recursively process them
    if (messagePart.parts && messagePart.parts.length > 0) {
        for (const part of messagePart.parts) {
            const { text, html } = extractEmailContent(part);
            if (text) textContent += text;
            if (html) htmlContent += html;
        }
    }

    // Return both plain text and HTML content
    return { text: textContent, html: htmlContent };
}

/**
 * Extract common headers from Gmail message payload
 */
export function extractHeaders(payload: any): { subject: string; from: string; to: string; cc: string; bcc: string; date: string; rfcMessageId: string } {
    const headers = payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
    return {
        subject: getHeader("subject"),
        from: getHeader("from"),
        to: getHeader("to"),
        cc: getHeader("cc"),
        bcc: getHeader("bcc"),
        date: getHeader("date"),
        rfcMessageId: getHeader("message-id"),
    };
}

/**
 * Extract attachments from Gmail message payload
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    function processAttachmentParts(part: GmailMessagePart) {
        if (part.body && part.body.attachmentId) {
            attachments.push({
                id: part.body.attachmentId,
                filename: part.filename || `attachment-${part.body.attachmentId}`,
                mimeType: part.mimeType || "application/octet-stream",
                size: part.body.size || 0,
            });
        }
        if (part.parts) {
            part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
        }
    }

    processAttachmentParts(payload);
    return attachments;
}

export interface SearchEmailsResult {
    id: string;
    subject: string;
    from: string;
    date: string;
}

export async function searchEmails(
    gmail: gmail_v1.Gmail,
    args: { query: string; maxResults?: number },
): Promise<SearchEmailsResult[]> {
    const response = await gmail.users.messages.list({
        userId: 'me',
        q: args.query,
        maxResults: args.maxResults || 10,
    });

    const messages = response.data.messages || [];
    return await Promise.all(
        messages.map(async (msg) => {
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id!,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'Date'],
            });
            const headers = detail.data.payload?.headers || [];
            return {
                id: msg.id!,
                subject: headers.find(h => h.name === 'Subject')?.value || '',
                from: headers.find(h => h.name === 'From')?.value || '',
                date: headers.find(h => h.name === 'Date')?.value || '',
            };
        })
    );
}

export function formatSearchEmailsText(results: SearchEmailsResult[]): string {
    return results.map(r =>
        `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
    ).join('\n');
}

export interface ReadEmailResult {
    id: string;
    threadId: string;
    rfcMessageId: string;
    subject: string;
    from: string;
    to: string;
    cc: string;
    bcc: string;
    date: string;
    labels: string[];
    text: string;
    html: string;
    // Plain text when the message has it, otherwise the HTML: the body read_email prints.
    body: string;
    attachments: EmailAttachment[];
}

export async function readEmail(gmail: gmail_v1.Gmail, args: { messageId: string }): Promise<ReadEmailResult> {
    const response = await gmail.users.messages.get({
        userId: 'me',
        id: args.messageId,
        format: 'full',
    });

    const { subject, from, to, cc, bcc, date, rfcMessageId } = extractHeaders(response.data.payload);
    const threadId = response.data.threadId || '';
    const { text, html } = extractEmailContent(response.data.payload as GmailMessagePart || {});
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

    return {
        id: response.data.id || args.messageId,
        threadId,
        rfcMessageId,
        subject,
        from,
        to,
        cc,
        bcc,
        date,
        labels: response.data.labelIds || [],
        text,
        html,
        // Use plain text content if available, otherwise use HTML content
        body: text || html || '',
        attachments,
    };
}

export function formatReadEmailText(email: ReadEmailResult): string {
    const { threadId, rfcMessageId, subject, from, to, cc, bcc, date, text, html, body, attachments } = email;
    const contentTypeNote = !text && html ?
        '[Note: This email is HTML-formatted. Plain text version not available.]\n\n' : '';

    // Add attachment info to output if any are present
    const attachmentInfo = attachments.length > 0 ?
        `\n\nAttachments (${attachments.length}):\n` +
        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

    return `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCC: ${cc}` : ''}${bcc ? `\nBCC: ${bcc}` : ''}\nDate: ${date}\n\n${contentTypeNote}${body}${attachmentInfo}`;
}

export interface DownloadAttachmentResult {
    // The name the file was saved under, reduced to its base name.
    filename: string;
    path: string;
    size: number;
    // The attachment part's MIME type; set whenever the message was fetched to find the part.
    mimeType?: string;
}

export async function downloadAttachment(
    gmail: gmail_v1.Gmail,
    args: { messageId: string; attachmentId: string; filename?: string; savePath?: string },
    // beforeWrite sees the final path before the file is written and may throw to stop the write.
    options: { lookupMimeType?: boolean; beforeWrite?: (fullPath: string) => void } = {},
): Promise<DownloadAttachmentResult> {
    // Get the attachment data from Gmail API
    const attachmentResponse = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: args.messageId,
        id: args.attachmentId,
    });

    if (!attachmentResponse.data.data) {
        throw new Error('No attachment data received');
    }

    // Decode the base64 data
    const data = attachmentResponse.data.data;
    const buffer = Buffer.from(data, 'base64url');

    // Determine save path and filename
    const savePath = args.savePath || process.cwd();
    let filename = args.filename;
    let mimeType: string | undefined;

    if (!filename || options.lookupMimeType) {
        // Get original filename from message if not provided
        const messageResponse = await gmail.users.messages.get({
            userId: 'me',
            id: args.messageId,
            format: 'full',
        });

        // Find the attachment part to get original filename
        const findAttachment = (part: any): any => {
            if (part.body && part.body.attachmentId === args.attachmentId) {
                return part;
            }
            if (part.parts) {
                for (const subpart of part.parts) {
                    const found = findAttachment(subpart);
                    if (found) return found;
                }
            }
            return null;
        };

        const part = findAttachment(messageResponse.data.payload);
        mimeType = part?.mimeType || 'application/octet-stream';
        if (!filename) {
            filename = part?.filename || `attachment-${args.attachmentId}`;
        }
    }

    // Sanitize filename to prevent path traversal
    filename = path.basename(filename!);

    // Ensure save directory exists
    if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
    }

    // Resolve and validate final path stays within savePath
    const resolvedSavePath = path.resolve(savePath);
    const fullPath = path.resolve(resolvedSavePath, filename);
    if (!fullPath.startsWith(resolvedSavePath + path.sep) && fullPath !== resolvedSavePath) {
        throw new Error('Invalid filename: path traversal detected');
    }
    options.beforeWrite?.(fullPath);
    fs.writeFileSync(fullPath, buffer);

    return { filename, path: fullPath, size: buffer.length, mimeType };
}

export function formatDownloadAttachmentText(result: DownloadAttachmentResult): string {
    return `Attachment downloaded successfully:\nFile: ${result.filename}\nSize: ${result.size} bytes\nSaved to: ${result.path}`;
}
