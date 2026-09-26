/**
 * Shared plumbing for the command-line tools: argument parsing, help rendering, JSON output,
 * error-to-exit-code mapping and the default Gmail and sign-in dependencies. Each tool prints
 * JSON on stdout, diagnostics on stderr, and on failure exits non-zero with nothing on stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { authenticate, credentialsPath, CredentialsError, loadCredentials, localOAuthPath, oauthPath } from '../auth.js';
import { isAuthError, toGmailRequestError } from '../gmail-sync.js';
import { hasScope } from '../scopes.js';
import { getToolByName } from '../tools.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_RATE_LIMITED = 4;
export const EXIT_NOT_FOUND = 5;

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

// The saved credentials do not grant the scopes the tool needs; the MCP server refuses the
// tool in the same case, with the same message.
export class ScopeError extends Error {
    constructor(toolName: string) {
        super(`Error: Tool "${toolName}" is not available. You may need to re-authenticate with additional scopes.`);
        this.name = 'ScopeError';
    }
}

// Gmail's rate-limit reasons on a 403, as gmail-sync treats them.
const RATE_LIMIT_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);

export function mapErrorToExitCode(error: unknown): number {
    if (error instanceof UsageError || error instanceof z.ZodError) {
        return EXIT_USAGE;
    }
    if (error instanceof CredentialsError || error instanceof ScopeError) {
        return EXIT_AUTH;
    }
    const wrapped = toGmailRequestError(error);
    if (wrapped.status === 429 || (wrapped.reason !== undefined && RATE_LIMIT_REASONS.has(wrapped.reason))) {
        return EXIT_RATE_LIMITED;
    }
    if (isAuthError(error)) {
        return EXIT_AUTH;
    }
    if (wrapped.status === 404) {
        return EXIT_NOT_FOUND;
    }
    return EXIT_FAILURE;
}

export function describeError(error: unknown): string {
    if (error instanceof z.ZodError) {
        return error.issues
            .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
            .join('\n');
    }
    if (error instanceof Error) {
        const status = toGmailRequestError(error).status;
        return status !== undefined && !error.message.includes(String(status))
            ? `${error.message} (HTTP ${status})`
            : error.message;
    }
    return String(error);
}

type ParseOptions = NonNullable<Parameters<typeof parseArgs>[0]>['options'] & {};

export function parseCliArgs<T extends ParseOptions>(argv: string[], options: T) {
    try {
        return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
            throw new UsageError((error as Error).message);
        }
        throw error;
    }
}

export function positiveInteger(flag: string, value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!/^[1-9]\d*$/.test(value)) {
        throw new UsageError(`--${flag} must be a positive integer, got "${value}"`);
    }
    return Number(value);
}

// Symbolic links followed per path, the limit Linux applies (ELOOP).
const MAX_SYMLINKS = 40;

// The path as the operating system resolves it, left to right: each symlink is followed where it
// appears, including a dangling one (writeFileSync creates the missing target through it), before
// a later `..` applies, so `link/../x` is the parent of the link's target, not a sibling of the
// link. path.resolve would apply `..` first and name a different file. With `entryOnly`, a
// symlink in the last component is kept: the location a tool that replaces the entry (rename,
// rm) acts on. Existing components take their on-disk spelling.
function canonicalPath(target: string, entryOnly = false): string {
    const absolute = path.isAbsolute(target) ? target : process.cwd() + path.sep + target;
    const root = path.parse(absolute).root;
    const pending = absolute.slice(root.length).split(path.sep);
    let current = root;
    let followed = 0;
    while (pending.length > 0) {
        const part = pending.shift() as string;
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            // `current` has no symlink left in it, so its lexical parent is the real one.
            current = path.dirname(current);
            continue;
        }
        const next = path.join(current, part);
        const stat = fs.lstatSync(next, { throwIfNoEntry: false });
        const last = pending.every(rest => rest === '' || rest === '.');
        if (stat?.isSymbolicLink() && !(entryOnly && last)) {
            if (++followed > MAX_SYMLINKS) {
                throw new UsageError(`too many symbolic links resolving ${target}`);
            }
            const link = fs.readlinkSync(next);
            if (path.isAbsolute(link)) {
                current = path.parse(link).root;
            }
            pending.unshift(...link.slice(path.isAbsolute(link) ? path.parse(link).root.length : 0).split(path.sep));
            continue;
        }
        current = stat && !stat.isSymbolicLink() ? fs.realpathSync.native(next) : next;
    }
    return current;
}

// Case-insensitive file systems (the default on macOS and Windows) name one file with any
// capitalisation, so the comparison ignores case there; on a case-sensitive volume this only
// refuses more.
const foldCase = process.platform === 'darwin' || process.platform === 'win32'
    ? (file: string) => file.toLowerCase()
    : (file: string) => file;

export interface ReservedPath {
    path: string;
    // Also reserve everything under the path.
    tree?: boolean;
    what: string;
}

// Refuses an --output file that would overwrite a file the command itself writes or relies on,
// before anything is fetched or written. Returns the resolved destination, which the command
// writes to, so the file written is the file checked.
export function assertOutputAvoids(output: string, reserved: ReservedPath[]): string;
export function assertOutputAvoids(output: string | undefined, reserved: ReservedPath[]): string | undefined;
export function assertOutputAvoids(output: string | undefined, reserved: ReservedPath[]): string | undefined {
    if (output === undefined) {
        return undefined;
    }
    const target = canonicalPath(output);
    const folded = foldCase(target);
    // A hard link names the same file under an unrelated path, so an existing output file is
    // also compared by identity with every existing reserved file.
    const existing = fs.statSync(target, { throwIfNoEntry: false });
    const outputFile = existing?.isFile() ? existing : undefined;
    for (const entry of reserved) {
        const refuse = () => new UsageError(`--output ${output} would overwrite ${entry.what}; write the JSON somewhere else`);
        // A reserved symlink guards both its target and the link's own location.
        for (const guarded of new Set([canonicalPath(entry.path), canonicalPath(entry.path, true)].map(foldCase))) {
            if (folded === guarded || (entry.tree && folded.startsWith(guarded + path.sep))) {
                throw refuse();
            }
        }
        if (outputFile && sharesFile(outputFile, canonicalPath(entry.path), entry.tree ?? false)) {
            throw refuse();
        }
    }
    return target;
}

// Whether `file` is the file at `reserved`, or with `tree` any regular file under it. The tree
// is walked without following symlinks, which the command neither writes nor rewrites there.
function sharesFile(file: fs.Stats, reserved: string, tree: boolean): boolean {
    const stat = fs.lstatSync(reserved, { throwIfNoEntry: false });
    if (!stat) {
        return false;
    }
    if (stat.isFile()) {
        return stat.dev === file.dev && stat.ino === file.ino;
    }
    return tree && stat.isDirectory()
        && fs.readdirSync(reserved).some(name => sharesFile(file, path.join(reserved, name), true));
}

export interface FlagSpec {
    type: 'string' | 'boolean';
    short?: string;
    // Shown after the flag in help, e.g. N or <file>.
    placeholder?: string;
    description: string;
    // A full command line that uses the flag.
    example: string;
}

export interface CommandSpec {
    name: string;
    synopsis: string;
    description: string;
    arguments: Array<[string, string]>;
    // A full command line with only the required arguments.
    example: string;
    flags: Record<string, FlagSpec>;
    notes?: string[];
}

// The flags every tool takes. --output is listed first among them so that tool-specific flags
// come before it in help, matching the synopsis.
export function commonFlags(name: string, outputExample: string): Record<string, FlagSpec> {
    return {
        output: {
            type: 'string',
            short: 'o',
            placeholder: '<file>',
            description: 'Write the JSON to <file> instead of stdout.',
            example: outputExample,
        },
        auth: {
            type: 'boolean',
            description: 'Sign in with Google in the browser and save the credentials, then exit. Needs no other argument.',
            example: `${name} --auth`,
        },
        help: {
            type: 'boolean',
            short: 'h',
            description: 'Show this help.',
            example: `${name} --help`,
        },
    };
}

export function renderHelp(spec: CommandSpec): string {
    const flagLabel = (flag: string, entry: FlagSpec) =>
        (entry.short ? `-${entry.short}, ` : '    ') + `--${flag}` + (entry.placeholder ? ` ${entry.placeholder}` : '');
    const rows: Array<[string, string]> = [
        ...spec.arguments,
        ...Object.entries(spec.flags).map(([flag, entry]): [string, string] => [flagLabel(flag, entry), entry.description]),
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    const row = ([label, text]: [string, string]) => `  ${label.padEnd(width)}  ${text}`;
    const lines = [
        `Usage: ${spec.synopsis}`,
        `       ${spec.name} --auth`,
        '',
        spec.description,
        '',
    ];
    if (spec.arguments.length > 0) {
        lines.push('Arguments:', ...spec.arguments.map(row), '');
    }
    lines.push('Options:', ...Object.entries(spec.flags).map(([flag, entry]) => row([flagLabel(flag, entry), entry.description])), '');
    lines.push('Examples:', `  ${spec.example}`, ...Object.values(spec.flags).map(entry => `  ${entry.example}`), '');
    if (spec.notes && spec.notes.length > 0) {
        lines.push(...spec.notes, '');
    }
    lines.push(
        'Output: JSON on stdout (or in the --output file); diagnostics on stderr.',
        'Exit codes: 0 success, 1 failure, 2 usage error, 3 not signed in or missing scope,',
        '4 Gmail rate limit, 5 not found. On failure nothing is written to stdout.',
    );
    return lines.join('\n') + '\n';
}

export function parseOptions(spec: CommandSpec): ParseOptions {
    return Object.fromEntries(Object.entries(spec.flags).map(([flag, entry]) =>
        [flag, entry.short ? { type: entry.type, short: entry.short } : { type: entry.type }]
    ));
}

export interface CliDeps {
    // A Gmail client for the named MCP tool, refused like the server refuses the tool when
    // the saved credentials lack its scopes.
    gmail: (toolName: string) => gmail_v1.Gmail;
    signIn: () => Promise<{ scopes: string[] }>;
    // Writes to stdout and resolves once the text is flushed.
    write: (text: string) => Promise<void>;
}

// Files every command relies on: --output must never replace them, and --auth rewrites one.
export function credentialFiles(): ReservedPath[] {
    return [
        { path: credentialsPath(), what: 'the saved credentials' },
        { path: oauthPath(), what: 'the OAuth keys file' },
        { path: localOAuthPath(), what: 'the OAuth keys file in the current directory' },
    ];
}

export async function emitJson(value: unknown, output: string | undefined, deps: CliDeps): Promise<void> {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (output !== undefined) {
        fs.writeFileSync(output, text);
        return;
    }
    await deps.write(text);
}

export function stderrLog(line: string): void {
    process.stderr.write(line + '\n');
}

function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.write(text, error => (error ? reject(error) : resolve()));
    });
}

export function defaultDeps(): CliDeps {
    return {
        gmail(toolName) {
            const { oauth2Client, authorizedScopes } = loadCredentials({ log: stderrLog, requireCredentials: true });
            const tool = getToolByName(toolName);
            if (!tool || !hasScope(authorizedScopes, tool.scopes)) {
                throw new ScopeError(toolName);
            }
            return google.gmail({ version: 'v1', auth: oauth2Client });
        },
        async signIn() {
            // Re-request the scopes already saved (DEFAULT_SCOPES when none are), so signing in
            // from a command-line tool never changes what the MCP server is allowed to do.
            const { oauth2Client, authorizedScopes, callbackUrl } = loadCredentials({ log: stderrLog });
            await authenticate(oauth2Client, callbackUrl, authorizedScopes, stderrLog);
            return { scopes: authorizedScopes };
        },
        write: text => writeStream(process.stdout, text),
    };
}

export type Command = (argv: string[], deps: CliDeps) => Promise<void>;

// Runs a command and returns its exit code; the error, if any, goes to stderr.
export async function runCli(name: string, command: Command, argv: string[], deps: CliDeps): Promise<number> {
    try {
        await command(argv, deps);
        return EXIT_OK;
    } catch (error) {
        const hint = error instanceof UsageError ? `\nRun '${name} --help' for usage.` : '';
        stderrLog(`${name}: ${describeError(error)}${hint}`);
        return mapErrorToExitCode(error);
    }
}

// The bin entry point: run, wait for stdout and stderr to drain (pipes are asynchronous on
// macOS), then exit so no idle Gmail connection keeps the process alive.
export async function main(name: string, command: Command): Promise<never> {
    const code = await runCli(name, command, process.argv.slice(2), defaultDeps());
    await writeStream(process.stdout, '');
    await writeStream(process.stderr, '');
    process.exit(code);
}
