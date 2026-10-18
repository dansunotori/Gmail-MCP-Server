/**
 * The read_email, search_emails, download_attachment, get_thread, get_inbox_with_threads and
 * download_email tools, shared by the MCP server and
 * the command-line tools. Each tool is a function returning structured data plus a formatter
 * that renders the exact text the MCP server returns, so both surfaces make the same Gmail
 * calls and cannot drift apart.
 */

import fs from 'fs';
import path from 'path';
import type { gmail_v1 } from 'googleapis';
import { EmailAttachment, emailToHtml, emailToTxt, gmailMessageToJson } from './email-export.js';
import { attachmentParts, findAttachmentPart } from './attachment-part.js';
import { resolveCalendarPart } from './calendar-part.js';
import { optionalHeader, selectBody, type BodySource, type MessagePart } from './message-body.js';

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
    // The RFC 822 Message-ID header as the message holds it, null when it has none.
    messageIdHeader: string | null;
    subject: string;
    from: string;
    to: string;
    cc: string;
    bcc: string;
    date: string;
    labels: string[];
    text: string;
    html: string;
    // The body read_email prints: the plain text when the message has a real plain part,
    // the HTML when it has none, and the HTML converted to text when the plain part is only
    // a stub. bodySource says which.
    body: string;
    bodySource: BodySource;
    attachments: EmailAttachment[];
    // Only a message with a text/calendar part carries these, read by the window fetch's own
    // reader (resolveCalendarPart): its METHOD and, for a REPLY, the replying attendee.
    calendarMethod?: string;
    calendarReply?: { attendee: string; partstat: string };
    // A calendar part that could not be fetched or parsed, one entry each.
    calendarFailures?: string[];
}

export async function readEmail(gmail: gmail_v1.Gmail, args: { messageId: string }): Promise<ReadEmailResult> {
    const response = await gmail.users.messages.get({
        userId: 'me',
        id: args.messageId,
        format: 'full',
    });

    const { subject, from, to, cc, bcc, date } = extractHeaders(response.data.payload);
    const messageIdHeader = optionalHeader(response.data.payload?.headers, 'Message-ID');
    const threadId = response.data.threadId || '';
    const { text, html } = extractEmailContent(response.data.payload as GmailMessagePart || {});
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);
    const { body, bodySource } = selectBody(text, html, 'keep-html');
    const { calendar, failures } = await resolveCalendarPart(gmail, response.data.id || args.messageId, response.data.payload as MessagePart);

    return {
        id: response.data.id || args.messageId,
        threadId,
        messageIdHeader,
        subject,
        from,
        to,
        cc,
        bcc,
        date,
        labels: response.data.labelIds || [],
        text,
        html,
        body,
        bodySource,
        attachments,
        ...(calendar === undefined ? {} : { calendarMethod: calendar.method }),
        ...(calendar?.reply === undefined ? {} : { calendarReply: calendar.reply }),
        ...(failures.length === 0 ? {} : { calendarFailures: failures.map(failure => failure.code) }),
    };
}

export function formatReadEmailText(email: ReadEmailResult): string {
    const { threadId, messageIdHeader, subject, from, to, cc, bcc, date, body, bodySource, attachments } = email;
    const calendarLines = [
        ...(email.calendarMethod === undefined ? [] : [`\nCalendar: ${email.calendarMethod}`]),
        ...(email.calendarReply === undefined ? [] : [`\nCalendar reply: ${email.calendarReply.attendee} ${email.calendarReply.partstat}`]),
        ...(email.calendarFailures ?? []).map(code => `\nCalendar part not read: ${code}`),
    ].join('');
    const contentTypeNote = bodySource === 'html'
        ? '[Note: This email is HTML-formatted. Plain text version not available.]\n\n'
        : bodySource === 'html-over-stub'
            ? '[Note: The plain-text part of this email is only a stub; this is its HTML part converted to text.]\n\n'
            : '';

    // Add attachment info to output if any are present
    const attachmentInfo = attachments.length > 0 ?
        `\n\nAttachments (${attachments.length}):\n` +
        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

    return `Thread ID: ${threadId}\nMessage-ID: ${messageIdHeader ?? '(none)'}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCC: ${cc}` : ''}${bcc ? `\nBCC: ${bcc}` : ''}\nDate: ${date}${calendarLines}\n\n${contentTypeNote}${body}${attachmentInfo}`;
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

        // The part by get_attachment_text's rule (src/attachment-part.ts). A message with no
        // attachment part leaves the name and type unknown; one whose part cannot be told apart
        // from another's is refused unless the caller names the file, since the name would be
        // a guess.
        const parts = attachmentParts(messageResponse.data.payload as MessagePart);
        const found = findAttachmentPart(parts, args.attachmentId, buffer.length, args.messageId);
        if (found.part === undefined && parts.length > 0 && !filename) {
            throw new Error(`${found.reason}; give a filename to save it under`);
        }
        mimeType = found.part?.mimeType || 'application/octet-stream';
        if (!filename) {
            filename = found.part?.filename || `attachment-${args.attachmentId}`;
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

// One message of a thread as get_thread and get_inbox_with_threads return it. A
// minimal-format message carries no body.
function threadMessage(message: gmail_v1.Schema$Message, withBody: boolean) {
    const headers = message.payload?.headers || [];
    const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name)?.value || '';
    let body = '';
    let bodySource: BodySource = 'text';
    if (withBody) {
        const { text, html } = extractEmailContent(message.payload as GmailMessagePart || {});
        ({ body, bodySource } = selectBody(text, html, 'keep-html'));
    }
    const attachments: EmailAttachment[] = [];
    const processAttachmentParts = (part: GmailMessagePart) => {
        if (part.body && part.body.attachmentId) {
            attachments.push({
                id: part.body.attachmentId,
                filename: part.filename || `attachment-${part.body.attachmentId}`,
                mimeType: part.mimeType || 'application/octet-stream',
                size: part.body.size || 0,
            });
        }
        part.parts?.forEach(processAttachmentParts);
    };
    if (message.payload) {
        processAttachmentParts(message.payload as GmailMessagePart);
    }
    return {
        messageId: message.id || '',
        threadId: message.threadId || '',
        from: header('from'),
        to: header('to'),
        cc: header('cc'),
        bcc: header('bcc'),
        subject: header('subject'),
        date: header('date'),
        body,
        bodySource,
        labelIds: message.labelIds || [],
        attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
    };
}

// get_thread: every message of a thread, oldest first, as the Gmail API returns them.
export async function getThread(gmail: gmail_v1.Gmail, args: { threadId: string; format?: 'full' | 'metadata' | 'minimal' }) {
    const response = await gmail.users.threads.get({ userId: 'me', id: args.threadId, format: args.format || 'full' });
    const messages = (response.data.messages || []).map(message => threadMessage(message, args.format !== 'minimal'));
    return { threadId: args.threadId, messageCount: messages.length, messages };
}

// get_inbox_with_threads: the threads matching the query, each expanded to its messages, or,
// with expandThreads false, each summarised by its latest message's headers.
export async function getInboxWithThreads(gmail: gmail_v1.Gmail, args: { query?: string; maxResults?: number; expandThreads?: boolean }) {
    const listed = await gmail.users.threads.list({ userId: 'me', q: args.query || 'in:inbox', maxResults: args.maxResults || 50 });
    const threads = listed.data.threads || [];
    if (args.expandThreads === false) {
        const summaries = await Promise.all(threads.map(async thread => {
            const detail = await gmail.users.threads.get({ userId: 'me', id: thread.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
            const messages = detail.data.messages || [];
            const latestHeaders = messages[messages.length - 1]?.payload?.headers || [];
            return {
                threadId: thread.id || '',
                snippet: thread.snippet || '',
                historyId: thread.historyId || '',
                messageCount: messages.length,
                latestMessage: {
                    from: latestHeaders.find(h => h.name === 'From')?.value || '',
                    subject: latestHeaders.find(h => h.name === 'Subject')?.value || '',
                    date: latestHeaders.find(h => h.name === 'Date')?.value || '',
                },
            };
        }));
        return { resultCount: summaries.length, threads: summaries };
    }
    const expanded = await Promise.all(threads.map(async thread => {
        const detail = await gmail.users.threads.get({ userId: 'me', id: thread.id!, format: 'full' });
        const messages = (detail.data.messages || []).map(message => threadMessage(message, true));
        return { threadId: thread.id || '', messageCount: messages.length, messages };
    }));
    return { resultCount: expanded.length, threads: expanded };
}

// list_inbox_threads: each matching thread summarised by its latest message, which is
// get_inbox_with_threads without expanding the threads.
export function listInboxThreads(gmail: gmail_v1.Gmail, args: { query?: string; maxResults?: number }) {
    return getInboxWithThreads(gmail, { ...args, expandThreads: false });
}

export interface DownloadEmailResult {
    status: 'saved';
    path: string;
    size: number;
    messageId: string;
    subject: string;
    from: string;
    date: string;
    attachments: EmailAttachment[];
}

// download_email: the message saved as <savePath>/<messageId>.<format>. beforeWrite sees the
// final path before the file is written and may throw to stop the write.
export async function downloadEmail(
    gmail: gmail_v1.Gmail,
    args: { messageId: string; savePath: string; format: 'json' | 'eml' | 'txt' | 'html' },
    options: { beforeWrite?: (fullPath: string) => void } = {},
): Promise<DownloadEmailResult> {
    const { messageId, savePath, format } = args;
    // Always fetch the full message for its metadata and attachment list.
    const fullResponse = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const { subject, from, date } = extractHeaders(fullResponse.data.payload);
    const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);
    let content: string;
    if (format === 'eml') {
        const rawResponse = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' });
        content = Buffer.from(rawResponse.data.raw || '', 'base64url').toString('utf-8');
    } else {
        const emailContent = extractEmailContent(fullResponse.data.payload as GmailMessagePart || {});
        content = format === 'json'
            ? JSON.stringify(gmailMessageToJson(fullResponse.data, emailContent, attachments), null, 2)
            : format === 'txt'
                ? emailToTxt(fullResponse.data, emailContent, attachments)
                : emailToHtml(emailContent);
    }
    if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
    }
    const fullPath = path.join(savePath, `${messageId}.${format}`);
    options.beforeWrite?.(fullPath);
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { status: 'saved', path: fullPath, size: fs.statSync(fullPath).size, messageId, subject, from, date, attachments };
}
