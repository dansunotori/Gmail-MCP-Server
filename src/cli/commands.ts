/**
 * The command-line tools. Each exposes one MCP tool with the same Gmail calls, defaults and
 * guards, by calling the same core function the server calls. Four only read; one,
 * gmail-create-draft, saves a draft. Nothing here sends, replies, forwards, labels, trashes
 * or modifies a message.
 */

import fs from 'node:fs';
import path from 'node:path';
import TurndownService from 'turndown';
import { getAttachmentText } from '../attachment-text/attachment-text.js';
import { batchFetchWindow } from '../batch-fetch-window.js';
import { createDraft, readDraft, type ComposeArgs } from '../compose.js';
import { validateEmail } from '../utl.js';
import type { BodySource } from '../message-body.js';
import { downloadAttachment, readEmail, searchEmails, type ReadEmailResult } from '../read-tools.js';
import { BatchFetchWindowSchema, SendEmailSchema } from '../tools.js';
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
    flags: CommandSpec['flags'];
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
    return { name: spec.name, flags: spec.flags, help: () => renderHelp(spec), run };
}

const SEARCH: CommandSpec = {
    name: 'gmail-search',
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
    synopsis: 'gmail-get-message <message_id> [--format text|markdown] [-o <file>]',
    description: 'Reads one message like the read_email MCP tool and prints id, threadId, subject, from, to, cc, date, messageIdHeader (the Message-ID header, null when absent), labels, body, bodySource (text, html or html-over-stub) and attachments [{id, filename, mimeType, size}].',
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
        attachments: email.attachments,
    }, args.output, deps);
};

const DOWNLOAD_ATTACHMENT: CommandSpec = {
    name: 'gmail-download-attachment',
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
    synopsis: 'gmail-batch-fetch-window --watermark <ISO 8601 with zone> --output-dir <absolute dir> [--no-cross-check] [--max-messages N] [-o <file>]',
    description: [
        'Downloads every message received since the watermark like the batch_fetch_window MCP tool',
        "and prints the tool's result unchanged. Deletes and recreates <dir>/messages/ and rewrites",
        '<dir>/manifest.json and <dir>/window-metadata.json, but only when messages/ is absent, empty',
        'or carries the marker a previous run wrote; a window larger than --max-messages writes nothing.',
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
    // draft_email defaults to text/plain, which drops an HTML body; with no type given, the
    // type follows the bodies given, and an explicit text/plain beside an HTML body is refused.
    const hasHtml = typeof merged.htmlBody === 'string' && merged.htmlBody !== '';
    const hasText = typeof merged.body === 'string' && merged.body !== '';
    if (merged.mimeType === undefined && hasHtml) {
        merged.mimeType = hasText ? 'multipart/alternative' : 'text/html';
    }
    if (merged.mimeType === 'text/plain' && hasHtml) {
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

export const COMMANDS: CliCommand[] = [
    command(SEARCH, searchCommand),
    command(GET_MESSAGE, getMessageCommand),
    command(DOWNLOAD_ATTACHMENT, downloadAttachmentCommand),
    command(GET_ATTACHMENT_TEXT, getAttachmentTextCommand),
    command(BATCH_FETCH_WINDOW, batchFetchWindowCommand),
    command(CREATE_DRAFT, createDraftCommand),
];
