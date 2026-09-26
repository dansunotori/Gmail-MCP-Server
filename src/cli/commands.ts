/**
 * The four read-only command-line tools. Each exposes one MCP tool with the same Gmail calls,
 * defaults and guards, by calling the same core function the server calls; nothing here
 * sends, replies, forwards, labels, trashes or modifies a message.
 */

import path from 'node:path';
import TurndownService from 'turndown';
import { batchFetchWindow } from '../batch-fetch-window.js';
import { downloadAttachment, readEmail, searchEmails, type ReadEmailResult } from '../read-tools.js';
import { BatchFetchWindowSchema } from '../tools.js';
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
    description: 'Reads one message like the read_email MCP tool and prints id, threadId, subject, from, to, cc, date, labels, body and attachments [{id, filename, mimeType, size}].',
    arguments: [['<message_id>', 'A Gmail message ID, as gmail-search prints it.']],
    example: 'gmail-get-message 18f2a9c4e1b7d3a0',
    flags: {
        format: {
            type: 'string',
            placeholder: 'text|markdown',
            description: "Body format. text (default) is read_email's body: the plain-text part, or the HTML when there is none. markdown converts the HTML part to Markdown, falling back to the plain text when there is no HTML.",
            example: 'gmail-get-message 18f2a9c4e1b7d3a0 --format markdown',
        },
        ...commonFlags('gmail-get-message', 'gmail-get-message 18f2a9c4e1b7d3a0 --output message.json'),
    },
};

function markdownBody(email: ReadEmailResult): string {
    if (!email.html) {
        return email.body;
    }
    const turndown = new TurndownService();
    turndown.remove(['head', 'style', 'script']);
    return turndown.turndown(email.html);
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
    await emitJson({
        id: email.id,
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        to: email.to,
        cc: email.cc,
        date: email.date,
        labels: email.labels,
        body: format === 'markdown' ? markdownBody(email) : email.body,
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

export const COMMANDS: CliCommand[] = [
    command(SEARCH, searchCommand),
    command(GET_MESSAGE, getMessageCommand),
    command(DOWNLOAD_ATTACHMENT, downloadAttachmentCommand),
    command(BATCH_FETCH_WINDOW, batchFetchWindowCommand),
];
