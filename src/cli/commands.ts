/**
 * The command-line tools. Each exposes one MCP tool with the same Gmail calls, defaults and
 * guards, by calling the same core function the server calls. All but one only read Gmail;
 * gmail-create-draft saves a draft. Nothing here sends, replies, forwards, labels, trashes
 * or modifies a message, and no label or filter is created, changed or deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import TurndownService from 'turndown';
import { getAttachmentText } from '../attachment-text/attachment-text.js';
import { batchFetchWindow } from '../batch-fetch-window.js';
import { contentTypeFor, createDraft, readDraft, type ComposeArgs } from '../compose.js';
import { getFilter, listFilters } from '../filter-manager.js';
import { batchGetGmailIndexMetadata } from '../gmail-batch.js';
import { getGmailProfile, listGmailAddedHistory, listGmailMessageIds } from '../gmail-sync.js';
import { listLabels } from '../label-manager.js';
import { validateEmail } from '../utl.js';
import type { BodySource } from '../message-body.js';
import { downloadAttachment, downloadEmail, getInboxWithThreads, getThread, listInboxThreads, readEmail, searchEmails, type ReadEmailResult } from '../read-tools.js';
import {
    BatchFetchWindowSchema,
    BatchGetGmailIndexMetadataSchema,
    DownloadEmailSchema,
    GetFilterSchema,
    GetInboxWithThreadsSchema,
    GetThreadSchema,
    ListGmailAddedHistorySchema,
    ListGmailMessageIdsSchema,
    ListInboxThreadsSchema,
    SendEmailSchema,
} from '../tools.js';
import {
    assertOutputAvoids,
    commonFlags,
    credentialFiles,
    emitJson,
    parseCliArgs,
    parseOptions,
    positiveInteger,
    renderHelp,
    UsageError,
    type CliDeps,
    type Command,
    type CommandSpec,
    type ReservedPath,
} from './common.js';

export type { CliDeps } from './common.js';

export interface CliCommand {
    name: string;
    tool: string;
    flags: CommandSpec['flags'];
    positionals: string[];
    fields?: CommandSpec['fields'];
    inputOnly?: CommandSpec['inputOnly'];
    help: () => string;
    run: Command;
}

function expectPositionals(positionals: string[], names: string[]): void {
    if (positionals.length < names.length) {
        throw new UsageError(`missing ${names.slice(positionals.length).join(' and ')}`);
    }
    if (positionals.length > names.length) {
        throw new UsageError(`unexpected argument${positionals.length - names.length === 1 ? '' : 's'}: ${positionals.slice(names.length).join(' ')}`);
    }
}

// Parses argv against the spec and handles --help and --auth, which every tool takes and
// which need no other argument. Returns undefined when one of them has run.
async function start(spec: CommandSpec, argv: string[], deps: CliDeps) {
    const parsed = parseCliArgs(argv, parseOptions(spec));
    const values = parsed.values as Record<string, string | boolean | undefined>;
    if (values.help) {
        await deps.write(renderHelp(spec));
        return undefined;
    }
    // From here on the output is the resolved destination the guard checked.
    const output = assertOutputAvoids(values.output as string | undefined, credentialFiles());
    if (values.auth) {
        const { scopes } = await deps.signIn();
        await emitJson({ authenticated: true, scopes }, output, deps);
        return undefined;
    }
    return { values, positionals: parsed.positionals, output };
}

function command(spec: CommandSpec, run: Command): CliCommand {
    return {
        name: spec.name,
        tool: spec.tool,
        flags: spec.flags,
        positionals: spec.arguments.map(([name]) => name),
        fields: spec.fields,
        inputOnly: spec.inputOnly,
        help: () => renderHelp(spec),
        run,
    };
}

const SEARCH: CommandSpec = {
    name: 'gmail-search',
    tool: 'search_emails',
    fields: { query: '<gmail query>' },
    synopsis: "gmail-search '<gmail query>' [--max-results N] [-o <file>]",
    description: 'Searches Gmail like the search_emails MCP tool and prints {query, count, messages: [{id, subject, from, date}]}.',
    arguments: [['<gmail query>', "Gmail search syntax, e.g. 'from:alice@example.com is:unread'. Quote it."]],
    example: "gmail-search 'from:billing@example.com'",
    flags: {
        'max-results': {
            type: 'string',
            placeholder: 'N',
            description: 'Return at most N messages (default 10, as search_emails).',
            example: "gmail-search 'has:attachment newer_than:7d' --max-results 50",
        },
        ...commonFlags('gmail-search', "gmail-search 'label:receipts' --output receipts.json"),
    },
    notes: ["A query that starts with '-' goes after '--': gmail-search -- '-in:inbox subject:report'"],
};

export const searchCommand: Command = async (argv, deps) => {
    const args = await start(SEARCH, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<gmail query>']);
    const query = args.positionals[0];
    const maxResults = positiveInteger('max-results', args.values['max-results'] as string | undefined);
    const messages = await searchEmails(deps.gmail('search_emails'), { query, maxResults });
    await emitJson({ query, count: messages.length, messages }, args.output, deps);
};

const GET_MESSAGE: CommandSpec = {
    name: 'gmail-get-message',
    tool: 'read_email',
    synopsis: 'gmail-get-message <message_id> [--format text|markdown] [-o <file>]',
    description: 'Reads one message like the read_email MCP tool and prints id, threadId, subject, from, to, cc, date, messageIdHeader (the Message-ID header, null when absent), labels, body, bodySource (text, html or html-over-stub), htmlBody (the text/html part as delivered, also when body is the plain part, or null when the message has no HTML part; null with htmlBodyError giving the reason when the HTML part cannot be fetched), plainBodyError (only when the text/plain part cannot be fetched: the reason, the body being chosen without it) and attachments [{id, filename, mimeType, size}]; a message with a text/calendar part also gets calendarMethod and, for a reply, calendarReply {attendee, partstat}, and calendarFailures when the part cannot be read.',
    arguments: [['<message_id>', 'A Gmail message ID, as gmail-search prints it.']],
    example: 'gmail-get-message 18f2a9c4e1b7d3a0',
    flags: {
        format: {
            type: 'string',
            placeholder: 'text|markdown',
            description: "Body format. text (default) is read_email's body: the plain-text part, the HTML when there is none, or the HTML converted to text when the plain part is only a stub. markdown converts the HTML part to Markdown, falling back to the plain text when there is no HTML. Either way bodySource names the part the body came from.",
            example: 'gmail-get-message 18f2a9c4e1b7d3a0 --format markdown',
        },
        ...commonFlags('gmail-get-message', 'gmail-get-message 18f2a9c4e1b7d3a0 --output message.json'),
    },
};

// The Markdown body and the part it came from: the HTML part whenever there is one (still
// html-over-stub when that part was chosen over a stub), otherwise read_email's own body.
function markdownBody(email: ReadEmailResult): { body: string; bodySource: BodySource } {
    if (!email.html) {
        return { body: email.body, bodySource: email.bodySource };
    }
    const turndown = new TurndownService();
    turndown.remove(['head', 'style', 'script']);
    return {
        body: turndown.turndown(email.html),
        bodySource: email.bodySource === 'html-over-stub' ? 'html-over-stub' : 'html',
    };
}

export const getMessageCommand: Command = async (argv, deps) => {
    const args = await start(GET_MESSAGE, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<message_id>']);
    const format = (args.values.format as string | undefined) ?? 'text';
    if (format !== 'text' && format !== 'markdown') {
        throw new UsageError(`--format must be text or markdown, got "${format}"`);
    }
    const email = await readEmail(deps.gmail('read_email'), { messageId: args.positionals[0] });
    const { body, bodySource } = format === 'markdown' ? markdownBody(email) : email;
    await emitJson({
        id: email.id,
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        to: email.to,
        cc: email.cc,
        date: email.date,
        messageIdHeader: email.messageIdHeader,
        labels: email.labels,
        body,
        bodySource,
        htmlBody: email.htmlBody,
        ...(email.htmlBodyError === undefined ? {} : { htmlBodyError: email.htmlBodyError }),
        ...(email.plainBodyError === undefined ? {} : { plainBodyError: email.plainBodyError }),
        attachments: email.attachments,
        // Only a message with a text/calendar part carries these.
        ...(email.calendarMethod === undefined ? {} : { calendarMethod: email.calendarMethod }),
        ...(email.calendarReply === undefined ? {} : { calendarReply: email.calendarReply }),
        ...(email.calendarFailures === undefined ? {} : { calendarFailures: email.calendarFailures }),
    }, args.output, deps);
};

const DOWNLOAD_ATTACHMENT: CommandSpec = {
    name: 'gmail-download-attachment',
    tool: 'download_attachment',
    synopsis: 'gmail-download-attachment <message_id> <attachment_id> --save-path <dir> [--filename <name>] [-o <file>]',
    description: 'Saves one attachment like the download_attachment MCP tool and prints {path, size, mimeType}. A failed download exits non-zero with nothing on stdout.',
    arguments: [
        ['<message_id>', 'The Gmail message ID.'],
        ['<attachment_id>', 'The attachment ID, as gmail-get-message lists it.'],
    ],
    example: 'gmail-download-attachment 18f2a9c4e1b7d3a0 ANGjdJ8x --save-path /tmp/attachments',
    flags: {
        'save-path': {
            type: 'string',
            placeholder: '<dir>',
            description: 'Directory to save into (required); created if missing.',
            example: 'gmail-download-attachment 18f2a9c4e1b7d3a0 ANGjdJ8x --save-path ~/Downloads',
        },
        filename: {
            type: 'string',
            placeholder: '<name>',
            description: "Save under <name> instead of the attachment's own filename. Only the base name is used.",
            example: 'gmail-download-attachment 18f2a9c4e1b7d3a0 ANGjdJ8x --save-path /tmp --filename invoice.pdf',
        },
        ...commonFlags('gmail-download-attachment', 'gmail-download-attachment 18f2a9c4e1b7d3a0 ANGjdJ8x --save-path /tmp --output saved.json'),
    },
};

export const downloadAttachmentCommand: Command = async (argv, deps) => {
    const args = await start(DOWNLOAD_ATTACHMENT, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<message_id>', '<attachment_id>']);
    const savePath = args.values['save-path'] as string | undefined;
    if (!savePath) {
        throw new UsageError('--save-path <dir> is required');
    }
    const [messageId, attachmentId] = args.positionals;
    const filename = args.values.filename as string | undefined;
    const attachmentFile = (file: string): ReservedPath[] => [{ path: file, what: 'the downloaded attachment' }];
    // With --filename the saved path is known now; otherwise it is checked once the attachment's
    // own name is known, still before the file is written.
    if (filename !== undefined) {
        assertOutputAvoids(args.output, attachmentFile(path.resolve(savePath, path.basename(filename))));
    }
    const saved = await downloadAttachment(
        deps.gmail('download_attachment'),
        { messageId, attachmentId, savePath, filename },
        { lookupMimeType: true, beforeWrite: file => assertOutputAvoids(args.output, attachmentFile(file)) },
    );
    await emitJson({ path: saved.path, size: saved.size, mimeType: saved.mimeType }, args.output, deps);
};

const BATCH_FETCH_WINDOW: CommandSpec = {
    name: 'gmail-batch-fetch-window',
    tool: 'batch_fetch_window',
    synopsis: 'gmail-batch-fetch-window --watermark <ISO 8601 with zone> --output-dir <absolute dir> [--no-cross-check] [--max-messages N] [-o <file>]',
    description: [
        'Downloads every message received since the watermark like the batch_fetch_window MCP tool',
        "and prints the tool's result unchanged. Deletes and recreates <dir>/messages/ and rewrites",
        '<dir>/manifest.json and <dir>/window-metadata.json, but only when messages/ is absent, empty',
        'or carries the marker a previous run wrote; a window larger than --max-messages writes nothing.',
        'Each messages/NNN.json carries body and bodySource as read_email chooses them, with HTML alone converted to text, and htmlBody: the text/html part as delivered, also when body is the plain part, or null when the message has no HTML part. When the HTML part cannot be fetched, htmlBody is null and htmlBodyError gives the reason; when the text/plain part cannot be fetched or decoded, plainBodyError gives the reason. A message with a text/calendar part also carries calendarMethod and, for a reply, calendarReply {attendee, partstat}.',
    ].join('\n'),
    arguments: [],
    example: 'gmail-batch-fetch-window --watermark 2026-09-01T00:00:00Z --output-dir /tmp/inbox-window',
    flags: {
        watermark: {
            type: 'string',
            placeholder: '<timestamp>',
            description: 'Start of the window: ISO 8601 with Z or an explicit ±HH:MM offset (required).',
            example: 'gmail-batch-fetch-window --watermark 2026-09-01T09:30:00+01:00 --output-dir /tmp/inbox-window',
        },
        'output-dir': {
            type: 'string',
            placeholder: '<dir>',
            description: 'Absolute directory for messages/, manifest.json and window-metadata.json (required).',
            example: 'gmail-batch-fetch-window --watermark 2026-09-01T00:00:00Z --output-dir /Users/me/mail/window',
        },
        'no-cross-check': {
            type: 'boolean',
            description: 'Skip the spam, trash and in:anywhere listings (cross_check false; crossCheck.status is skipped).',
            example: 'gmail-batch-fetch-window --watermark 2026-09-01T00:00:00Z --output-dir /tmp/inbox-window --no-cross-check',
        },
        'max-messages': {
            type: 'string',
            placeholder: 'N',
            description: 'Refuse, writing nothing, when the window lists more than N messages (default 2000).',
            example: 'gmail-batch-fetch-window --watermark 2026-09-01T00:00:00Z --output-dir /tmp/inbox-window --max-messages 500',
        },
        ...commonFlags('gmail-batch-fetch-window', 'gmail-batch-fetch-window --watermark 2026-09-01T00:00:00Z --output-dir /tmp/inbox-window --output result.json'),
    },
};

export const batchFetchWindowCommand: Command = async (argv, deps) => {
    const args = await start(BATCH_FETCH_WINDOW, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const maxMessages = positiveInteger('max-messages', args.values['max-messages'] as string | undefined);
    // The tool's own schema supplies the defaults and rejects a zoneless watermark or a
    // relative directory before any Gmail call.
    const input = BatchFetchWindowSchema.parse({
        watermark: args.values.watermark,
        output_dir: args.values['output-dir'],
        ...(maxMessages === undefined ? {} : { max_messages: maxMessages }),
        ...(args.values['no-cross-check'] ? { cross_check: false } : {}),
    });
    // The tool joins these paths lexically (path.join), so they are reserved in that form.
    assertOutputAvoids(args.output, [
        { path: path.resolve(input.output_dir), what: 'the output directory' },
        { path: path.join(input.output_dir, 'manifest.json'), what: 'the manifest' },
        { path: path.join(input.output_dir, 'window-metadata.json'), what: 'the window metadata' },
        { path: path.join(input.output_dir, 'messages'), tree: true, what: 'the fetched messages' },
    ]);
    const result = await batchFetchWindow(deps.gmail('batch_fetch_window'), input);
    await emitJson(result, args.output, deps);
};

const GET_ATTACHMENT_TEXT: CommandSpec = {
    name: 'gmail-get-attachment-text',
    tool: 'get_attachment_text',
    synopsis: 'gmail-get-attachment-text <message_id> <attachment_id> [-o <file>]',
    description: [
        "Prints an attachment's text like the get_attachment_text MCP tool, as",
        '{name, format, text, truncated, sheets}.',
        '',
        'Formats: PDF, DOCX, XLSX, XLSM, XLS and CSV are parsed; TXT, MD and any other text/* part',
        'are returned as they are, decoded as UTF-8 or, when not valid UTF-8, Windows-1252.',
        "A spreadsheet's text is one '## Sheet: <name>' heading per sheet followed by tab-separated",
        'rows of display values (formula results, merged cells once at their top-left, leading and',
        "trailing empty rows and columns trimmed); sheets gives each sheet's populated span as",
        '{name, rows, columns}, and is null for other formats. Text over 500 KB is cut on a line',
        'boundary and truncated is true. Files are parsed in a separate process with a 30-second',
        'limit; macros and formulas are never run.',
    ].join('\n'),
    arguments: [
        ['<message_id>', 'The Gmail message ID.'],
        ['<attachment_id>', 'The attachment ID, as gmail-get-message lists it.'],
    ],
    example: 'gmail-get-attachment-text 18f2a9c4e1b7d3a0 ANGjdJ8x',
    flags: {
        ...commonFlags('gmail-get-attachment-text', 'gmail-get-attachment-text 18f2a9c4e1b7d3a0 ANGjdJ8x --output text.json'),
    },
    notes: [
        'When the file itself cannot be read the command exits 6, and the stderr line names the',
        'cause in these words: protected file (a password is needed), encrypted file, corrupt file',
        '(damaged, or not the format its name or type claims) or unsupported file (a format not',
        'listed above). A sign-in, network or Gmail failure exits with its own code instead.',
    ],
    exitCodes: '6 attachment protected, encrypted, corrupt or unsupported',
};

export const getAttachmentTextCommand: Command = async (argv, deps) => {
    const args = await start(GET_ATTACHMENT_TEXT, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<message_id>', '<attachment_id>']);
    const [messageId, attachmentId] = args.positionals;
    const result = await getAttachmentText(deps.gmail('get_attachment_text'), { messageId, attachmentId });
    await emitJson(result, args.output, deps);
};

const CREATE_DRAFT: CommandSpec = {
    name: 'gmail-create-draft',
    tool: 'draft_email',
    synopsis: "gmail-create-draft --to <addresses> --subject <text> (--body <text> | --body-file <file>) [options] [-o <file>]",
    description: [
        'Saves a draft like the draft_email MCP tool, with the same options, and prints',
        '{draft_id, message_id, thread_id, to, cc, bcc, subject, attachments: [{name, size}]} read back',
        'from the saved draft. It never sends. Bodies given as files are read as UTF-8, so no body',
        'has to pass through a shell argument. An unknown option, a missing required one, an invalid',
        'address or a file that cannot be read exits 2 before anything reaches Gmail.',
    ].join('\n'),
    arguments: [],
    example: "gmail-create-draft --to alice@example.com --subject 'Q3 report' --body-file body.txt",
    flags: {
        to: {
            type: 'string',
            placeholder: '<addresses>',
            description: 'Recipients, comma-separated (required unless --input supplies them).',
            example: "gmail-create-draft --to 'alice@example.com,bob@example.com' --subject Hi --body Hello",
        },
        cc: {
            type: 'string',
            placeholder: '<addresses>',
            description: 'Cc recipients, comma-separated.',
            example: "gmail-create-draft --to alice@example.com --cc carol@example.com --subject Hi --body Hello",
        },
        bcc: {
            type: 'string',
            placeholder: '<addresses>',
            description: 'Bcc recipients, comma-separated.',
            example: "gmail-create-draft --to alice@example.com --bcc dave@example.com --subject Hi --body Hello",
        },
        subject: {
            type: 'string',
            placeholder: '<text>',
            description: 'Subject (required unless --input supplies it).',
            example: "gmail-create-draft --to alice@example.com --subject 'Quarterly report' --body Hello",
        },
        body: {
            type: 'string',
            placeholder: '<text>',
            description: 'Plain-text body. Use --body-file for anything longer than a phrase.',
            example: "gmail-create-draft --to alice@example.com --subject Hi --body 'See you at 10.'",
        },
        'body-file': {
            type: 'string',
            placeholder: '<file>',
            description: 'Read the plain-text body from <file> as UTF-8 (instead of --body).',
            example: 'gmail-create-draft --to alice@example.com --subject Hi --body-file body.txt',
        },
        'html-body': {
            type: 'string',
            placeholder: '<html>',
            description: 'HTML body. With no plain body, the plain part is left empty.',
            example: "gmail-create-draft --to alice@example.com --subject Hi --body Hello --html-body '<p>Hello</p>' --mime-type multipart/alternative",
        },
        'html-body-file': {
            type: 'string',
            placeholder: '<file>',
            description: 'Read the HTML body from <file> as UTF-8 (instead of --html-body).',
            example: 'gmail-create-draft --to alice@example.com --subject Hi --body Hello --html-body-file body.html --mime-type multipart/alternative',
        },
        'mime-type': {
            type: 'string',
            placeholder: 'text/plain|text/html|multipart/alternative',
            description: 'Content type, as draft_email. Without it the type follows the bodies: text/plain for a plain body, text/html for an HTML body alone, multipart/alternative for both. text/plain beside an HTML body is refused, since it would drop the HTML.',
            example: 'gmail-create-draft --to alice@example.com --subject Hi --html-body-file body.html --mime-type text/html',
        },
        attachment: {
            type: 'string',
            multiple: true,
            placeholder: '<file>',
            description: 'Attach <file>; repeat for more.',
            example: 'gmail-create-draft --to alice@example.com --subject Report --body-file body.txt --attachment report.pdf --attachment data.xlsx',
        },
        'inline-image': {
            type: 'string',
            multiple: true,
            placeholder: 'cid=<cid>,path=<file>',
            description: 'Embed <file> in the HTML body, referenced there as <img src="cid:<cid>">; repeat for more. Needs an HTML body.',
            example: 'gmail-create-draft --to alice@example.com --subject Hi --body Hello --html-body-file body.html --mime-type multipart/alternative --inline-image cid=logo,path=logo.png',
        },
        from: {
            type: 'string',
            placeholder: '<address>',
            description: 'Send-as address configured in Gmail (default: the account address).',
            example: 'gmail-create-draft --to alice@example.com --subject Hi --body Hello --from team@example.com',
        },
        'thread-id': {
            type: 'string',
            placeholder: '<id>',
            description: "Put the draft in this thread; In-Reply-To and References come from the thread unless --in-reply-to is given.",
            example: "gmail-create-draft --to alice@example.com --subject 'Re: plan' --body Agreed --thread-id 19ff1b5e84ead3c1",
        },
        'in-reply-to': {
            type: 'string',
            placeholder: '<Message-ID>',
            description: 'Message-ID the draft replies to.',
            example: "gmail-create-draft --to alice@example.com --subject 'Re: plan' --body Agreed --in-reply-to '<abc@example.com>'",
        },
        input: {
            type: 'string',
            placeholder: '<file>',
            description: "Read the draft_email JSON request (to, cc, bcc, subject, body, htmlBody, mimeType, attachments, inlineImages, from, threadId, inReplyTo) from <file>; options override its fields.",
            example: 'gmail-create-draft --input request.json --to alice@example.com',
        },
        ...commonFlags('gmail-create-draft', 'gmail-create-draft --to alice@example.com --subject Hi --body Hello --output draft.json'),
    },
};

const addressList = (value: string) => value.split(',').map(address => address.trim()).filter(address => address !== '');

function readUtf8(flag: string, file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new UsageError(`--${flag} ${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
}

function assertReadableFile(what: string, file: string): void {
    try {
        fs.accessSync(file, fs.constants.R_OK);
        if (!fs.statSync(file).isFile()) {
            throw new UsageError(`${what} ${file} is not a file`);
        }
    } catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError(`${what} ${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
}

// One --inline-image value: cid=<cid>,path=<file>, in either order.
function inlineImage(value: string): { cid: string; path: string } {
    const fields = Object.fromEntries(value.split(',').map(field => {
        const at = field.indexOf('=');
        return at === -1 ? [field.trim(), ''] : [field.slice(0, at).trim(), field.slice(at + 1).trim()];
    }));
    if (!fields.cid || !fields.path || Object.keys(fields).length !== 2) {
        throw new UsageError(`--inline-image must be cid=<cid>,path=<file>, got "${value}"`);
    }
    return { cid: fields.cid, path: fields.path };
}

// Exactly one of --<flag> and --<flag>-file, read from the file as UTF-8.
function textOption(values: Record<string, unknown>, flag: string): string | undefined {
    const inline = values[flag] as string | undefined;
    const file = values[`${flag}-file`] as string | undefined;
    if (inline !== undefined && file !== undefined) {
        throw new UsageError(`give --${flag} or --${flag}-file, not both`);
    }
    return file !== undefined ? readUtf8(`${flag}-file`, file) : inline;
}

export const createDraftCommand: Command = async (argv, deps) => {
    const args = await start(CREATE_DRAFT, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const values = args.values as Record<string, unknown>;
    const input = values.input as string | undefined;
    let request: Record<string, unknown> = {};
    if (input !== undefined) {
        try {
            request = JSON.parse(readUtf8('input', input));
        } catch (error) {
            if (error instanceof UsageError) throw error;
            throw new UsageError(`--input ${input} is not JSON: ${(error as Error).message}`);
        }
    }
    const body = textOption(values, 'body');
    const htmlBody = textOption(values, 'html-body');
    const attachments = values.attachment as string[] | undefined;
    const inlineImages = (values['inline-image'] as string[] | undefined)?.map(inlineImage);
    const overrides: Record<string, unknown> = {
        ...(values.to !== undefined ? { to: addressList(values.to as string) } : {}),
        ...(values.cc !== undefined ? { cc: addressList(values.cc as string) } : {}),
        ...(values.bcc !== undefined ? { bcc: addressList(values.bcc as string) } : {}),
        ...(values.subject !== undefined ? { subject: values.subject } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(htmlBody !== undefined ? { htmlBody } : {}),
        ...(values['mime-type'] !== undefined ? { mimeType: values['mime-type'] } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        ...(inlineImages !== undefined ? { inlineImages } : {}),
        ...(values.from !== undefined ? { from: values.from } : {}),
        ...(values['thread-id'] !== undefined ? { threadId: values['thread-id'] } : {}),
        ...(values['in-reply-to'] !== undefined ? { inReplyTo: values['in-reply-to'] } : {}),
    };
    const merged: Record<string, unknown> = { ...request, ...overrides };
    if (merged.body === undefined && merged.htmlBody === undefined) {
        throw new UsageError('missing --body, --body-file, --html-body or --html-body-file');
    }
    // The type follows the bodies by draft_email's own rule (contentTypeFor); an explicit
    // text/plain beside an HTML body is a usage error here, before anything reaches Gmail.
    try {
        contentTypeFor(merged as Parameters<typeof contentTypeFor>[0]);
    } catch {
        throw new UsageError('--mime-type text/plain would drop the HTML body; use text/html or multipart/alternative');
    }
    // The tool's own schema supplies the defaults and rejects a missing --to or --subject.
    const draft: ComposeArgs = SendEmailSchema.parse({ body: '', ...merged });
    if (draft.to.length === 0) {
        throw new UsageError('missing --to');
    }
    // A sender may carry a display name ("Team <team@example.com>"); its address is checked.
    const sender = draft.from === undefined ? [] : [(/<([^>]*)>/.exec(draft.from)?.[1] ?? draft.from).trim()];
    for (const address of [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? []), ...sender]) {
        if (!validateEmail(address)) {
            throw new UsageError(`not an email address: "${address}"`);
        }
    }
    if ((draft.inlineImages ?? []).length > 0 && !draft.htmlBody) {
        throw new UsageError('--inline-image needs an HTML body (--html-body or --html-body-file)');
    }
    for (const file of draft.attachments ?? []) {
        assertReadableFile('attachment', file);
    }
    for (const image of draft.inlineImages ?? []) {
        if (image.path !== undefined) assertReadableFile('inline image', image.path);
    }
    // The JSON goes to --output only after the draft is saved; it must never replace a file the
    // draft was built from.
    assertOutputAvoids(args.output, [
        ...(input !== undefined ? [{ path: input, what: 'the --input file' }] : []),
        ...(['body-file', 'html-body-file'] as const)
            .filter(flag => values[flag] !== undefined)
            .map(flag => ({ path: values[flag] as string, what: flag === 'body-file' ? 'the body file' : 'the HTML body file' })),
        ...(draft.attachments ?? []).map(file => ({ path: file, what: 'an attachment' })),
        ...(draft.inlineImages ?? []).flatMap(image => (image.path === undefined ? [] : [{ path: image.path, what: 'an inline image' }])),
    ]);
    const gmail = deps.gmail('draft_email');
    const draftId = await createDraft(gmail, draft);
    await emitJson(await readDraft(gmail, draftId), args.output, deps);
};

const GET_THREAD: CommandSpec = {
    name: 'gmail-get-thread',
    tool: 'get_thread',
    synopsis: 'gmail-get-thread <thread_id> [--format full|metadata|minimal] [-o <file>]',
    description: [
        "Prints every message of a thread, oldest first, like the get_thread MCP tool, as",
        '{threadId, messageCount, messages: [{messageId, threadId, from, to, cc, bcc, subject, date,',
        'body, bodySource, htmlBody, labelIds, attachments: [{filename, mimeType, size}]}]}. Each body',
        "follows gmail-get-message: the plain part, the HTML part converted to text when the plain",
        'part is only a stub, or the HTML as it is when there is no plain part, with',
        "gmail-get-message's plainBodyError when the text/plain part cannot be fetched. With --format full",
        "each message also gets gmail-get-message's htmlBody, the text/html part as delivered, or",
        'null when the message has no HTML part, and null with htmlBodyError giving the reason when',
        'the HTML part cannot be fetched; metadata and minimal carry no htmlBody. A message with a',
        "text/calendar part also gets gmail-get-message's calendarMethod, calendarReply and",
        'calendarFailures.',
    ].join('\n'),
    arguments: [['<thread_id>', 'The Gmail thread ID, as gmail-get-message prints it.']],
    example: 'gmail-get-thread 19ff1b5e84ead3c1',
    flags: {
        format: {
            type: 'string',
            placeholder: 'full|metadata|minimal',
            description: 'The Gmail format each message is fetched in (default full); minimal carries no body.',
            example: 'gmail-get-thread 19ff1b5e84ead3c1 --format metadata',
        },
        ...commonFlags('gmail-get-thread', 'gmail-get-thread 19ff1b5e84ead3c1 --output thread.json'),
    },
};

export const getThreadCommand: Command = async (argv, deps) => {
    const args = await start(GET_THREAD, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<thread_id>']);
    // The tool's own schema supplies the default and rejects an unknown format.
    const input = GetThreadSchema.parse({
        threadId: args.positionals[0],
        ...(args.values.format !== undefined ? { format: args.values.format } : {}),
    });
    await emitJson(await getThread(deps.gmail('get_thread'), input), args.output, deps);
};

const GET_INBOX_WITH_THREADS: CommandSpec = {
    name: 'gmail-get-inbox-with-threads',
    tool: 'get_inbox_with_threads',
    synopsis: "gmail-get-inbox-with-threads [--query '<gmail query>'] [--max-results N] [--no-expand-threads] [-o <file>]",
    description: [
        'Prints the threads matching a query like the get_inbox_with_threads MCP tool, as',
        '{resultCount, threads}: each thread with its messages as gmail-get-thread prints them in full',
        'format, htmlBody included (the text/html part as delivered, or null when the message has no',
        'HTML part, and null with htmlBodyError giving the reason when the HTML part cannot be',
        'fetched), plainBodyError when the text/plain part cannot be fetched, and calendarMethod,',
        'calendarReply and calendarFailures for a message with a text/calendar part, or, with',
        '--no-expand-threads, each as {threadId, snippet, historyId, messageCount,',
        'latestMessage: {from, subject, date}}.',
    ].join('\n'),
    arguments: [],
    example: 'gmail-get-inbox-with-threads',
    flags: {
        query: {
            type: 'string',
            placeholder: "'<gmail query>'",
            description: "Gmail search syntax (default 'in:inbox'). Quote it.",
            example: "gmail-get-inbox-with-threads --query 'is:unread from:alice@example.com'",
        },
        'max-results': {
            type: 'string',
            placeholder: 'N',
            description: 'Return at most N threads (default 50).',
            example: 'gmail-get-inbox-with-threads --max-results 10',
        },
        'no-expand-threads': {
            type: 'boolean',
            description: 'Summarise each thread by its latest message instead of returning every message (expandThreads false).',
            example: 'gmail-get-inbox-with-threads --no-expand-threads',
        },
        ...commonFlags('gmail-get-inbox-with-threads', 'gmail-get-inbox-with-threads --output inbox.json'),
    },
};

export const getInboxWithThreadsCommand: Command = async (argv, deps) => {
    const args = await start(GET_INBOX_WITH_THREADS, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const maxResults = positiveInteger('max-results', args.values['max-results'] as string | undefined);
    const input = GetInboxWithThreadsSchema.parse({
        ...(args.values.query !== undefined ? { query: args.values.query } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(args.values['no-expand-threads'] ? { expandThreads: false } : {}),
    });
    await emitJson(await getInboxWithThreads(deps.gmail('get_inbox_with_threads'), input), args.output, deps);
};

const DOWNLOAD_EMAIL: CommandSpec = {
    name: 'gmail-download-email',
    tool: 'download_email',
    synopsis: 'gmail-download-email <message_id> --save-path <dir> [--format json|eml|txt|html] [-o <file>]',
    description: [
        'Saves one message as <dir>/<message_id>.<format> like the download_email MCP tool and prints',
        '{status, path, size, messageId, subject, from, date, attachments}. txt and json carry the',
        'plain part, or the HTML part converted to text when there is no plain part or it is only a',
        'stub (json also keeps both parts and bodySource, htmlBody, the text/html part as delivered,',
        'or null when the message has no HTML part, and null with htmlBodyError giving the reason when',
        'the HTML part cannot be fetched, plainBodyError when the text/plain part cannot be fetched,',
        'and calendarMethod, calendarReply and calendarFailures for a message with a text/calendar',
        'part); a txt file whose text/plain',
        'part cannot be fetched is an error; eml is the raw RFC 822 message; html is the HTML part, and',
        'a message without one, or whose HTML part cannot be fetched, is an error.',
    ].join('\n'),
    arguments: [['<message_id>', 'The Gmail message ID.']],
    example: 'gmail-download-email 18f2a9c4e1b7d3a0 --save-path /tmp/mail',
    flags: {
        'save-path': {
            type: 'string',
            placeholder: '<dir>',
            description: 'Directory to save into (required); created if missing.',
            example: 'gmail-download-email 18f2a9c4e1b7d3a0 --save-path ~/mail',
        },
        format: {
            type: 'string',
            placeholder: 'json|eml|txt|html',
            description: 'File format (default json).',
            example: 'gmail-download-email 18f2a9c4e1b7d3a0 --save-path /tmp/mail --format eml',
        },
        ...commonFlags('gmail-download-email', 'gmail-download-email 18f2a9c4e1b7d3a0 --save-path /tmp/mail --output saved.json'),
    },
};

export const downloadEmailCommand: Command = async (argv, deps) => {
    const args = await start(DOWNLOAD_EMAIL, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<message_id>']);
    const savePath = args.values['save-path'] as string | undefined;
    if (!savePath) {
        throw new UsageError('--save-path <dir> is required');
    }
    const input = DownloadEmailSchema.parse({
        messageId: args.positionals[0],
        savePath,
        ...(args.values.format !== undefined ? { format: args.values.format } : {}),
    });
    // The saved file's path is known before any Gmail call, so --output is checked against it now.
    const saved: ReservedPath[] = [{ path: path.resolve(input.savePath, `${input.messageId}.${input.format}`), what: 'the downloaded email' }];
    assertOutputAvoids(args.output, saved);
    await emitJson(await downloadEmail(deps.gmail('download_email'), input), args.output, deps);
};

const LIST_INBOX_THREADS: CommandSpec = {
    name: 'gmail-list-inbox-threads',
    tool: 'list_inbox_threads',
    synopsis: "gmail-list-inbox-threads [--query '<gmail query>'] [--max-results N] [-o <file>]",
    description: 'Lists the threads matching a query like the list_inbox_threads MCP tool and prints {resultCount, threads: [{threadId, snippet, historyId, messageCount, latestMessage: {from, subject, date}}]}, each thread summarised by its latest message.',
    arguments: [],
    example: 'gmail-list-inbox-threads',
    flags: {
        query: {
            type: 'string',
            placeholder: "'<gmail query>'",
            description: "Gmail search syntax (default 'in:inbox'). Quote it.",
            example: "gmail-list-inbox-threads --query 'is:unread label:receipts'",
        },
        'max-results': {
            type: 'string',
            placeholder: 'N',
            description: 'Return at most N threads (default 50).',
            example: 'gmail-list-inbox-threads --max-results 10',
        },
        ...commonFlags('gmail-list-inbox-threads', 'gmail-list-inbox-threads --output threads.json'),
    },
};

export const listInboxThreadsCommand: Command = async (argv, deps) => {
    const args = await start(LIST_INBOX_THREADS, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const maxResults = positiveInteger('max-results', args.values['max-results'] as string | undefined);
    const input = ListInboxThreadsSchema.parse({
        ...(args.values.query !== undefined ? { query: args.values.query } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
    });
    await emitJson(await listInboxThreads(deps.gmail('list_inbox_threads'), input), args.output, deps);
};

const GET_PROFILE: CommandSpec = {
    name: 'gmail-get-profile',
    tool: 'get_gmail_profile',
    synopsis: 'gmail-get-profile [-o <file>]',
    description: "Prints the mailbox's current history ID like the get_gmail_profile MCP tool, as {historyId}: the cursor gmail-list-added-history starts from.",
    arguments: [],
    example: 'gmail-get-profile',
    flags: {
        ...commonFlags('gmail-get-profile', 'gmail-get-profile --output profile.json'),
    },
};

export const getProfileCommand: Command = async (argv, deps) => {
    const args = await start(GET_PROFILE, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    await emitJson(await getGmailProfile(deps.gmail('get_gmail_profile')), args.output, deps);
};

const LIST_MESSAGE_IDS: CommandSpec = {
    name: 'gmail-list-message-ids',
    tool: 'list_gmail_message_ids',
    synopsis: 'gmail-list-message-ids [--page-token <token>] [--max-results N] [-o <file>]',
    description: 'Lists one page of message IDs in the mailbox, spam and trash excluded, like the list_gmail_message_ids MCP tool, as {messageIds, nextPageToken}; nextPageToken is absent on the last page.',
    arguments: [],
    example: 'gmail-list-message-ids',
    flags: {
        'page-token': {
            type: 'string',
            placeholder: '<token>',
            description: 'The page to read: a nextPageToken an earlier call printed.',
            example: 'gmail-list-message-ids --page-token 09876543210987654321',
        },
        'max-results': {
            type: 'string',
            placeholder: 'N',
            description: 'Return at most N IDs, 1 to 500 (default 500).',
            example: 'gmail-list-message-ids --max-results 100',
        },
        ...commonFlags('gmail-list-message-ids', 'gmail-list-message-ids --output ids.json'),
    },
};

export const listMessageIdsCommand: Command = async (argv, deps) => {
    const args = await start(LIST_MESSAGE_IDS, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const maxResults = positiveInteger('max-results', args.values['max-results'] as string | undefined);
    // The tool's own schema supplies the default and refuses a limit above 500.
    const input = ListGmailMessageIdsSchema.parse({
        ...(args.values['page-token'] !== undefined ? { pageToken: args.values['page-token'] } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
    });
    await emitJson(await listGmailMessageIds(deps.gmail('list_gmail_message_ids'), input), args.output, deps);
};

const LIST_ADDED_HISTORY: CommandSpec = {
    name: 'gmail-list-added-history',
    tool: 'list_gmail_added_history',
    synopsis: 'gmail-list-added-history <start_history_id> [--page-token <token>] [--max-results N] [-o <file>]',
    description: 'Lists the IDs of messages added since a history ID like the list_gmail_added_history MCP tool, as {status: "ok", messageIds, nextPageToken, historyId}, or {status: "cursor_expired", startHistoryId} when Gmail no longer keeps history that far back.',
    arguments: [['<start_history_id>', 'The history ID to read from, as gmail-get-profile or an earlier call printed it.']],
    example: 'gmail-list-added-history 4182736',
    flags: {
        'page-token': {
            type: 'string',
            placeholder: '<token>',
            description: 'The page to read: a nextPageToken an earlier call printed.',
            example: 'gmail-list-added-history 4182736 --page-token 09876543210987654321',
        },
        'max-results': {
            type: 'string',
            placeholder: 'N',
            description: 'Read at most N history records, 1 to 500 (default 500).',
            example: 'gmail-list-added-history 4182736 --max-results 100',
        },
        ...commonFlags('gmail-list-added-history', 'gmail-list-added-history 4182736 --output added.json'),
    },
};

export const listAddedHistoryCommand: Command = async (argv, deps) => {
    const args = await start(LIST_ADDED_HISTORY, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<start_history_id>']);
    const maxResults = positiveInteger('max-results', args.values['max-results'] as string | undefined);
    const input = ListGmailAddedHistorySchema.parse({
        startHistoryId: args.positionals[0],
        ...(args.values['page-token'] !== undefined ? { pageToken: args.values['page-token'] } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
    });
    await emitJson(await listGmailAddedHistory(deps.gmail('list_gmail_added_history'), input), args.output, deps);
};

const BATCH_GET_INDEX_METADATA: CommandSpec = {
    name: 'gmail-batch-get-index-metadata',
    tool: 'batch_get_gmail_index_metadata',
    fields: { messageIds: '<message_id>...' },
    synopsis: 'gmail-batch-get-index-metadata <message_id>... [-o <file>]',
    description: 'Fetches the index metadata of 1 to 50 messages in one batch request like the batch_get_gmail_index_metadata MCP tool, as {messages: [{id, internalDate, labelIds}], missingMessageIds}, in the order given; a message Gmail does not find is listed in missingMessageIds.',
    arguments: [['<message_id>...', 'One to 50 Gmail message IDs, as gmail-list-message-ids prints them.']],
    example: 'gmail-batch-get-index-metadata 18f2a9c4e1b7d3a0 18f2a9c4e1b7d3a1',
    flags: {
        ...commonFlags('gmail-batch-get-index-metadata', 'gmail-batch-get-index-metadata 18f2a9c4e1b7d3a0 --output index.json'),
    },
};

export const batchGetIndexMetadataCommand: Command = async (argv, deps) => {
    const args = await start(BATCH_GET_INDEX_METADATA, argv, deps);
    if (!args) return;
    if (args.positionals.length === 0) {
        throw new UsageError('missing <message_id>');
    }
    // The tool's own schema refuses more than 50 IDs before any request is made.
    const input = BatchGetGmailIndexMetadataSchema.parse({ messageIds: args.positionals });
    await emitJson(await batchGetGmailIndexMetadata(deps.oauth('batch_get_gmail_index_metadata'), input.messageIds), args.output, deps);
};

const LIST_LABELS: CommandSpec = {
    name: 'gmail-list-labels',
    tool: 'list_email_labels',
    synopsis: 'gmail-list-labels [-o <file>]',
    description: "Lists the mailbox's labels like the list_email_labels MCP tool, as {count: {total, system, user}, system, user}, each label as Gmail returns it (id, name, type and its visibility settings).",
    arguments: [],
    example: 'gmail-list-labels',
    flags: {
        ...commonFlags('gmail-list-labels', 'gmail-list-labels --output labels.json'),
    },
};

export const listLabelsCommand: Command = async (argv, deps) => {
    const args = await start(LIST_LABELS, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    const { count, system, user } = await listLabels(deps.gmail('list_email_labels'));
    await emitJson({ count, system, user }, args.output, deps);
};

const LIST_FILTERS: CommandSpec = {
    name: 'gmail-list-filters',
    tool: 'list_filters',
    synopsis: 'gmail-list-filters [-o <file>]',
    description: "Lists the mailbox's filters like the list_filters MCP tool, as {count, filters: [{id, criteria, action}]}.",
    arguments: [],
    example: 'gmail-list-filters',
    flags: {
        ...commonFlags('gmail-list-filters', 'gmail-list-filters --output filters.json'),
    },
};

export const listFiltersCommand: Command = async (argv, deps) => {
    const args = await start(LIST_FILTERS, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, []);
    await emitJson(await listFilters(deps.gmail('list_filters')), args.output, deps);
};

const GET_FILTER: CommandSpec = {
    name: 'gmail-get-filter',
    tool: 'get_filter',
    synopsis: 'gmail-get-filter <filter_id> [-o <file>]',
    description: 'Prints one filter like the get_filter MCP tool, as {id, criteria, action}.',
    arguments: [['<filter_id>', 'The filter ID, as gmail-list-filters prints it.']],
    example: 'gmail-get-filter ANe1BmhGd4wFkLMNo',
    flags: {
        ...commonFlags('gmail-get-filter', 'gmail-get-filter ANe1BmhGd4wFkLMNo --output filter.json'),
    },
};

export const getFilterCommand: Command = async (argv, deps) => {
    const args = await start(GET_FILTER, argv, deps);
    if (!args) return;
    expectPositionals(args.positionals, ['<filter_id>']);
    const input = GetFilterSchema.parse({ filterId: args.positionals[0] });
    await emitJson(await getFilter(deps.gmail('get_filter'), input.filterId), args.output, deps);
};

export const COMMANDS: CliCommand[] = [
    command(SEARCH, searchCommand),
    command(GET_MESSAGE, getMessageCommand),
    command(DOWNLOAD_ATTACHMENT, downloadAttachmentCommand),
    command(GET_ATTACHMENT_TEXT, getAttachmentTextCommand),
    command(BATCH_FETCH_WINDOW, batchFetchWindowCommand),
    command(CREATE_DRAFT, createDraftCommand),
    command(GET_THREAD, getThreadCommand),
    command(GET_INBOX_WITH_THREADS, getInboxWithThreadsCommand),
    command(DOWNLOAD_EMAIL, downloadEmailCommand),
    command(LIST_INBOX_THREADS, listInboxThreadsCommand),
    command(GET_PROFILE, getProfileCommand),
    command(LIST_MESSAGE_IDS, listMessageIdsCommand),
    command(LIST_ADDED_HISTORY, listAddedHistoryCommand),
    command(BATCH_GET_INDEX_METADATA, batchGetIndexMetadataCommand),
    command(LIST_LABELS, listLabelsCommand),
    command(LIST_FILTERS, listFiltersCommand),
    command(GET_FILTER, getFilterCommand),
];
