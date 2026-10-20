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
import { withContext } from './error-text.js';
import { isPlainTextStub, optionalHeader, resolveMessageBody, selectBody, type BodySource, type HtmlBodyFields, type MessagePart } from './message-body.js';

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
 * Extract attachments from Gmail message payload: every part Gmail delivers by attachmentId
 * except an unnamed text/plain or text/html part, which is the message body Gmail defers, as
 * the window fetch's reader (src/message-body.ts) treats it.
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    function processAttachmentParts(part: GmailMessagePart) {
        const isDeferredBody = (part.mimeType === 'text/plain' || part.mimeType === 'text/html') && !part.filename;
        if (part.body && part.body.attachmentId && !isDeferredBody) {
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
    // The text/html part as delivered, whatever the body is, read by the window fetch's own
    // reader (resolveMessageBody): null when there is none, and null with htmlBodyError when
    // the part could not be fetched.
    htmlBody: string | null;
    htmlBodyError?: string;
    // Only a message whose text/plain part could not be fetched carries this: the reason, so
    // the body, chosen without that part, never reads as complete.
    plainBodyError?: string;
    attachments: EmailAttachment[];
    // Only a message with a text/calendar part carries these, read by the window fetch's own
    // reader (resolveCalendarPart): its METHOD and, for a REPLY, the replying attendee.
    calendarMethod?: string;
    calendarReply?: { attendee: string; partstat: string };
    // A calendar part that could not be fetched or parsed, one entry each.
    calendarFailures?: string[];
}

export type CalendarFields = Pick<ReadEmailResult, 'calendarMethod' | 'calendarReply' | 'calendarFailures'>;

// The calendar fields of a message, read by the window fetch's own reader: none for a message
// without a text/calendar part. read_email, get_thread, get_inbox_with_threads and
// download_email's json all carry them.
export async function calendarFields(gmail: gmail_v1.Gmail, messageId: string, payload: gmail_v1.Schema$MessagePart | null | undefined): Promise<CalendarFields> {
    const { calendar, failures } = await resolveCalendarPart(gmail, messageId, payload as MessagePart);
    return {
        ...(calendar === undefined ? {} : { calendarMethod: calendar.method }),
        ...(calendar?.reply === undefined ? {} : { calendarReply: calendar.reply }),
        ...(failures.length === 0 ? {} : { calendarFailures: failures.map(failure => failure.code) }),
    };
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
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);
    // The window fetch's own reader, so a part Gmail defers is fetched once and serves both
    // body and htmlBody.
    const { text, html, htmlBody, htmlBodyError, plainBodyError } = await resolveMessageBody(gmail, response.data.id || args.messageId, response.data.payload as MessagePart);
    const { body, bodySource } = selectBody(text, html, 'keep-html');
    const calendar = await calendarFields(gmail, response.data.id || args.messageId, response.data.payload);

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
        htmlBody,
        ...(htmlBodyError === undefined ? {} : { htmlBodyError }),
        ...(plainBodyError === undefined ? {} : { plainBodyError }),
        attachments,
        ...calendar,
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
    const plainPartNote = email.plainBodyError === undefined
        ? ''
        : `[Note: The plain-text part of this email could not be fetched (${email.plainBodyError}).]\n\n`;

    // Add attachment info to output if any are present
    const attachmentInfo = attachments.length > 0 ?
        `\n\nAttachments (${attachments.length}):\n` +
        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

    // The HTML part comes last, so everything before it reads as it does without one.
    const htmlPart = email.htmlBodyError !== undefined
        ? `\n\nHTML part not read: ${email.htmlBodyError}`
        : email.htmlBody === null ? '\n\nHTML part: none' : `\n\nHTML part:\n${email.htmlBody}`;

    return `Thread ID: ${threadId}\nMessage-ID: ${messageIdHeader ?? '(none)'}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCC: ${cc}` : ''}${bcc ? `\nBCC: ${bcc}` : ''}\nDate: ${date}${calendarLines}\n\n${plainPartNote}${contentTypeNote}${body}${attachmentInfo}${htmlPart}`;
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

// One message of a thread as get_thread and get_inbox_with_threads return it, with
// read_email's body, plainBodyError, htmlBody and calendar fields, read by read_email's own
// readers. A minimal-format message carries no body, and a message fetched without its parts
// (metadata, minimal) neither htmlBody nor a calendar part to read.
async function threadMessage(gmail: gmail_v1.Gmail, message: gmail_v1.Schema$Message, format: 'full' | 'metadata' | 'minimal') {
    const headers = message.payload?.headers || [];
    const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name)?.value || '';
    let body = '';
    let bodySource: BodySource = 'text';
    let plainFields: { plainBodyError?: string } = {};
    let htmlFields: HtmlBodyFields | undefined;
    if (format !== 'minimal') {
        const { text, html, htmlBody, htmlBodyError, plainBodyError } = await resolveMessageBody(gmail, message.id || '', message.payload as MessagePart);
        ({ body, bodySource } = selectBody(text, html, 'keep-html'));
        plainFields = plainBodyError === undefined ? {} : { plainBodyError };
        if (format === 'full') {
            htmlFields = { htmlBody, ...(htmlBodyError === undefined ? {} : { htmlBodyError }) };
        }
    }
    const attachments = message.payload ? extractAttachments(message.payload as GmailMessagePart) : [];
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
        ...plainFields,
        ...htmlFields,
        labelIds: message.labelIds || [],
        attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
        ...await calendarFields(gmail, message.id || '', message.payload),
    };
}

// get_thread: every message of a thread, oldest first, as the Gmail API returns them.
export async function getThread(gmail: gmail_v1.Gmail, args: { threadId: string; format?: 'full' | 'metadata' | 'minimal' }) {
    const response = await gmail.users.threads.get({ userId: 'me', id: args.threadId, format: args.format || 'full' });
    const messages = await Promise.all((response.data.messages || []).map(message => threadMessage(gmail, message, args.format || 'full')));
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
        const messages = await Promise.all((detail.data.messages || []).map(message => threadMessage(gmail, message, 'full')));
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
        // read_email's reader, so a part Gmail defers is fetched and the json's htmlBody is
        // read_email's for the same message.
        const { text, html, htmlBody, htmlBodyError, plainBodyError, failures } = await resolveMessageBody(gmail, messageId, fullResponse.data.payload as MessagePart);
        const emailContent = { text, html };
        // A txt or html file is only its body, so one missing the part it is made from is
        // refused rather than saved incomplete. Gmail's own error stays the cause, so its
        // status and reason set the exit code.
        const htmlFailure = failures.find(failure => failure.mimeType === 'text/html');
        if (format === 'html' && htmlFailure !== undefined) {
            throw withContext(`The HTML part could not be fetched: ${htmlBodyError}`, htmlFailure.error);
        }
        const plainFailure = failures.find(failure => failure.mimeType === 'text/plain');
        if (format === 'txt' && plainFailure !== undefined) {
            throw withContext(`The plain-text part could not be fetched: ${plainBodyError}`, plainFailure.error);
        }
        // A missing or stub plain part leaves the txt body to the HTML part.
        if (format === 'txt' && htmlFailure !== undefined && (text.trim() === '' || isPlainTextStub(text))) {
            throw withContext(`The HTML part the text is made from could not be fetched: ${htmlBodyError}`, htmlFailure.error);
        }
        content = format === 'json'
            ? JSON.stringify({
                ...gmailMessageToJson(fullResponse.data, emailContent, attachments),
                htmlBody,
                ...(htmlBodyError === undefined ? {} : { htmlBodyError }),
                ...(plainBodyError === undefined ? {} : { plainBodyError }),
                ...await calendarFields(gmail, messageId, fullResponse.data.payload),
            }, null, 2)
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
