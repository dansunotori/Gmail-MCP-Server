import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CredentialsError } from '../auth.js';
import { GmailRequestError } from '../gmail-sync.js';
import {
  COMMANDS,
  batchFetchWindowCommand,
  createDraftCommand,
  downloadAttachmentCommand,
  getAttachmentTextCommand,
  getMessageCommand,
  searchCommand,
  type CliDeps,
} from './commands.js';
import { ScopeError, UsageError, mapErrorToExitCode, parseCliArgs, runCli } from './common.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

function httpError(status: number, reason?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: reason ? { error: { errors: [{ reason }] } } : {} },
  });
}

const message = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Subject', value: 'Invoice' },
      { name: 'From', value: 'Billing <billing@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Cc', value: 'boss@example.com' },
      { name: 'Bcc', value: 'hidden@example.com' },
      { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Plain body') } },
      { mimeType: 'text/html', body: { data: b64('<style>p{}</style><p>See <a href="https://x.test">this</a></p>') } },
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att-1', size: 14 } },
    ],
  },
};

function fakeGmail() {
  const list = vi.fn(async (params: { q: string; pageToken?: string }) => {
    if (params.q === 'from:billing@example.com') return { data: { messages: [{ id: 'm1' }] } };
    return { data: {} };
  });
  const get = vi.fn(async ({ id }: { id: string }) => {
    if (id !== 'm1') throw httpError(404);
    return { data: message };
  });
  const attachmentsGet = vi.fn(async () => ({ data: { data: Buffer.from('%PDF-1.7 bytes').toString('base64url') } }));
  const getProfile = vi.fn(async () => ({ data: { emailAddress: 'me@example.com' } }));
  return {
    gmail: { users: { getProfile, messages: { list, get, attachments: { get: attachmentsGet } } } } as unknown as gmail_v1.Gmail,
    list,
    get,
    attachmentsGet,
  };
}

function harness(gmail: gmail_v1.Gmail = fakeGmail().gmail) {
  const out: string[] = [];
  const deps: CliDeps = {
    gmail: vi.fn(() => gmail),
    signIn: vi.fn(async () => ({ scopes: ['gmail.readonly'] })),
    write: vi.fn(async (text: string) => { out.push(text); }),
  };
  return { deps, out, json: () => JSON.parse(out.join('')) };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-cli-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('common', () => {
  it('maps errors to exit codes: usage 2, credentials and auth 3, rate limit 4, not found 5, else 1', () => {
    expect(mapErrorToExitCode(new UsageError('x'))).toBe(2);
    expect(mapErrorToExitCode(new z.ZodError([]))).toBe(2);
    expect(mapErrorToExitCode(new CredentialsError('missing-credentials', 'x'))).toBe(3);
    expect(mapErrorToExitCode(new CredentialsError('invalid-credentials', 'x'))).toBe(3);
    expect(mapErrorToExitCode(httpError(401))).toBe(3);
    expect(mapErrorToExitCode(httpError(403, 'insufficientPermissions'))).toBe(3);
    expect(mapErrorToExitCode(httpError(403, 'quotaExceeded'))).toBe(4);
    expect(mapErrorToExitCode(httpError(429))).toBe(4);
    expect(mapErrorToExitCode(new GmailRequestError('gone', { status: 404 }))).toBe(5);
    expect(mapErrorToExitCode(httpError(500))).toBe(1);
    expect(mapErrorToExitCode(new Error('boom'))).toBe(1);
  });

  it('rejects an unknown flag and a missing flag value as usage errors', () => {
    const options = { name: { type: 'string' as const } };
    expect(() => parseCliArgs(['--nope'], options)).toThrow(UsageError);
    expect(() => parseCliArgs(['--name'], options)).toThrow(UsageError);
  });

  it('documents every flag of every command with an example that uses it', () => {
    for (const command of COMMANDS) {
      const lines = command.help().split('\n');
      for (const [flag, spec] of Object.entries(command.flags)) {
        const example = lines.find(line => line.trim().startsWith(`${command.name} `) && line.includes(`--${flag}`));
        expect(example, `${command.name} --${flag}`).toBeDefined();
        if (spec.short) expect(command.help()).toContain(`-${spec.short}, --${flag}`);
      }
    }
  });
});

describe('every command', () => {
  it.each(COMMANDS.map(command => [command.name, command.run] as const))(
    '%s prints help for --help and -h without touching Gmail', async (name, run) => {
      for (const flag of ['--help', '-h']) {
        const { deps, out } = harness();
        await run([flag], deps);
        expect(out.join('')).toContain(`Usage: ${name}`);
        expect(deps.gmail).not.toHaveBeenCalled();
      }
    },
  );

  it.each(COMMANDS.map(command => [command.name, command.run] as const))(
    '%s signs in with --auth, prints JSON and needs no other argument', async (_name, run) => {
      const { deps, json } = harness();
      await run(['--auth'], deps);
      expect(deps.signIn).toHaveBeenCalledTimes(1);
      expect(deps.gmail).not.toHaveBeenCalled();
      expect(json()).toEqual({ authenticated: true, scopes: ['gmail.readonly'] });
    },
  );
});

describe('--output never overwrites a file the command writes or relies on', () => {
  const WATERMARK = '2026-09-07T12:00:00Z';
  const saved = process.env.GMAIL_CREDENTIALS_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.GMAIL_CREDENTIALS_PATH;
    else process.env.GMAIL_CREDENTIALS_PATH = saved;
  });

  it('refuses the saved credentials file for every command, including --auth, before signing in or calling Gmail', async () => {
    const credentials = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentials, 'keep');
    process.env.GMAIL_CREDENTIALS_PATH = credentials;
    for (const argv of [
      ['--auth', '-o', credentials],
      ['in:inbox', '-o', credentials],
      ['m1', '--output', credentials],
    ]) {
      const { deps, out } = harness();
      const run = argv[0] === 'm1' ? getMessageCommand : searchCommand;
      await expect(run(argv, deps)).rejects.toThrow(/would overwrite the saved credentials/);
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.gmail).not.toHaveBeenCalled();
      expect(out).toEqual([]);
    }
    expect(fs.readFileSync(credentials, 'utf8')).toBe('keep');
  });

  it('refuses the OAuth keys file in the current directory, including with --auth', async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const argv of [['--auth', '-o', 'gcp-oauth.keys.json'], ['in:inbox', '-o', './gcp-oauth.keys.json']]) {
        const { deps } = harness();
        await expect(searchCommand(argv, deps)).rejects.toThrow(/OAuth keys file in the current directory/);
        expect(deps.signIn).not.toHaveBeenCalled();
        expect(deps.gmail).not.toHaveBeenCalled();
      }
    } finally {
      process.chdir(cwd);
    }
    expect(fs.existsSync(path.join(dir, 'gcp-oauth.keys.json'))).toBe(false);
  });

  it('refuses a dangling symlink that points at a batch output not yet written', async () => {
    const outputDir = path.join(dir, 'window');
    for (const [name, reserved] of [
      ['to-manifest', path.join(outputDir, 'manifest.json')],
      ['to-metadata', path.join(outputDir, 'window-metadata.json')],
      ['to-message', path.join(outputDir, 'messages', '001.json')],
    ]) {
      const link = path.join(dir, name);
      fs.symlinkSync(reserved, link);
      const { deps } = harness();
      const failed = await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '-o', link], deps).catch(error => error);
      expect(failed, name).toBeInstanceOf(UsageError);
      expect(deps.gmail).not.toHaveBeenCalled();
    }
  });

  it('reports a symlink loop in --output as a usage error', async () => {
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'));
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    const { deps } = harness();
    await expect(searchCommand(['in:inbox', '-o', path.join(dir, 'a')], deps)).rejects.toThrow(/too many symbolic links/);
    expect(deps.gmail).not.toHaveBeenCalled();
  });

  it('follows a symlink before a later .. as the OS does, so link/../credentials.json is refused', async () => {
    const config = path.join(dir, 'config');
    fs.mkdirSync(path.join(config, 'subdir'), { recursive: true });
    const credentials = path.join(config, 'credentials.json');
    fs.writeFileSync(credentials, 'keep');
    process.env.GMAIL_CREDENTIALS_PATH = credentials;
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(path.join(config, 'subdir'), alias);
    // Lexically this is <dir>/credentials.json; the OS writes <dir>/config/credentials.json.
    const output = alias + path.sep + '..' + path.sep + 'credentials.json';
    for (const argv of [['--auth', '-o', output], ['in:inbox', '-o', output]]) {
      const { deps, out } = harness();
      await expect(searchCommand(argv, deps)).rejects.toThrow(/would overwrite the saved credentials/);
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.gmail).not.toHaveBeenCalled();
      expect(out).toEqual([]);
    }
    expect(fs.readFileSync(credentials, 'utf8')).toBe('keep');
  });

  it('writes --output to the file the guard checked when a symlink and .. take it away from a reserved name', async () => {
    const outputDir = path.join(dir, 'window');
    const inner = path.join(dir, 'other', 'inner');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(inner, { recursive: true });
    fs.symlinkSync(inner, path.join(outputDir, 'sub'));
    // Lexically this is the manifest; the OS writes <dir>/other/manifest.json.
    const output = path.join(outputDir, 'sub') + path.sep + '..' + path.sep + 'manifest.json';
    const { deps, out } = harness();
    await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '--no-cross-check', '-o', output], deps);
    expect(out).toEqual([]);
    const written = fs.readFileSync(path.join(dir, 'other', 'manifest.json'), 'utf8');
    expect(JSON.parse(written).status).toBe('ok');
    expect(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')).not.toBe(written);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'refuses a reserved file spelt with different capitals, which a case-insensitive disk treats as the same file', async () => {
      const credentials = path.join(dir, 'credentials.json');
      fs.writeFileSync(credentials, 'keep');
      process.env.GMAIL_CREDENTIALS_PATH = credentials;
      const { deps } = harness();
      await expect(searchCommand(['in:inbox', '-o', path.join(dir, 'CREDENTIALS.JSON')], deps))
        .rejects.toThrow(/would overwrite the saved credentials/);
      expect(fs.readFileSync(credentials, 'utf8')).toBe('keep');
    },
  );

  it('refuses a hard link to a reserved file, which names the same file under another path', async () => {
    const credentials = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentials, 'keep');
    process.env.GMAIL_CREDENTIALS_PATH = credentials;
    const credentialsLink = path.join(dir, 'innocent.json');
    fs.linkSync(credentials, credentialsLink);
    for (const argv of [['--auth', '-o', credentialsLink], ['in:inbox', '-o', credentialsLink]]) {
      const { deps } = harness();
      await expect(searchCommand(argv, deps)).rejects.toThrow(/would overwrite the saved credentials/);
      expect(deps.signIn).not.toHaveBeenCalled();
    }
    expect(fs.readFileSync(credentials, 'utf8')).toBe('keep');

    const outputDir = path.join(dir, 'window');
    fs.mkdirSync(path.join(outputDir, 'messages', 'nested'), { recursive: true });
    for (const [name, reserved] of [
      ['manifest', path.join(outputDir, 'manifest.json')],
      ['message', path.join(outputDir, 'messages', 'nested', '001.json')],
    ]) {
      fs.writeFileSync(reserved, 'keep');
      const link = path.join(dir, `${name}-link.json`);
      fs.linkSync(reserved, link);
      const { deps } = harness();
      const failed = await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '-o', link], deps).catch(error => error);
      expect(failed, name).toBeInstanceOf(UsageError);
      expect(deps.gmail).not.toHaveBeenCalled();
    }
  });

  it('refuses a hard link to an existing attachment before the attachment is rewritten', async () => {
    const saveDir = path.join(dir, 'saved');
    fs.mkdirSync(saveDir);
    const attachment = path.join(saveDir, 'invoice.pdf');
    fs.writeFileSync(attachment, 'old');
    const link = path.join(dir, 'result.json');
    fs.linkSync(attachment, link);
    const { deps, out } = harness();
    await expect(downloadAttachmentCommand(['m1', 'att-1', '--save-path', saveDir, '-o', link], deps))
      .rejects.toThrow(/would overwrite the downloaded attachment/);
    expect(fs.readFileSync(attachment, 'utf8')).toBe('old');
    expect(out).toEqual([]);
  });

  it('refuses a symlinked manifest by the link location as well as its target', async () => {
    const outputDir = path.join(dir, 'window');
    fs.mkdirSync(outputDir);
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(outputDir, 'manifest.json'));
    const { deps } = harness();
    for (const output of [path.join(outputDir, 'manifest.json'), path.join(dir, 'elsewhere.json')]) {
      const failed = await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '-o', output], deps).catch(error => error);
      expect(failed, output).toBeInstanceOf(UsageError);
    }
    expect(deps.gmail).not.toHaveBeenCalled();
  });

  it('refuses a dangling symlink to the attachment before the attachment is written', async () => {
    const saveDir = path.join(dir, 'saved');
    const link = path.join(dir, 'result.json');
    fs.symlinkSync(path.join(saveDir, 'invoice.pdf'), link);
    const { deps, out } = harness();
    await expect(downloadAttachmentCommand(['m1', 'att-1', '--save-path', saveDir, '-o', link], deps))
      .rejects.toThrow(/would overwrite the downloaded attachment/);
    expect(fs.existsSync(path.join(saveDir, 'invoice.pdf'))).toBe(false);
    expect(out).toEqual([]);
  });

  it('refuses the batch outputs, however the path is spelt, before calling Gmail', async () => {
    const outputDir = path.join(dir, 'window');
    fs.mkdirSync(outputDir);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(outputDir, alias);
    for (const output of [
      path.join(outputDir, 'manifest.json'),
      path.join(outputDir, 'window-metadata.json'),
      path.join(outputDir, 'messages', '001.json'),
      path.join(outputDir, 'messages'),
      outputDir,
      path.join(alias, 'manifest.json'),
      path.join(outputDir, 'sub', '..', 'manifest.json'),
    ]) {
      const { deps } = harness();
      const failed = await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '-o', output], deps).catch(error => error);
      expect(failed, output).toBeInstanceOf(UsageError);
      expect(deps.gmail).not.toHaveBeenCalled();
    }
  });

  it('allows a batch --output beside the reserved files', async () => {
    const outputDir = path.join(dir, 'window');
    const result = path.join(outputDir, 'result.json');
    const { deps, out } = harness();
    fs.mkdirSync(outputDir);
    await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', outputDir, '--no-cross-check', '-o', result], deps);
    expect(out).toEqual([]);
    expect(JSON.parse(fs.readFileSync(result, 'utf8')).status).toBe('ok');
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(true);
  });

  it('refuses the attachment path given by --filename before calling Gmail', async () => {
    const { deps } = harness();
    await expect(downloadAttachmentCommand(
      ['m1', 'att-1', '--save-path', dir, '--filename', 'copy.pdf', '-o', path.join(dir, 'copy.pdf')], deps,
    )).rejects.toThrow(/would overwrite the downloaded attachment/);
    expect(deps.gmail).not.toHaveBeenCalled();
  });

  it("refuses the attachment's own filename before the attachment is written", async () => {
    const { deps, out } = harness();
    await expect(downloadAttachmentCommand(
      ['m1', 'att-1', '--save-path', dir, '-o', path.join(dir, 'invoice.pdf')], deps,
    )).rejects.toThrow(UsageError);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(out).toEqual([]);
  });
});

describe('gmail-search', () => {
  it('prints {query, count, messages} with ids exactly as Gmail returns them', async () => {
    const { deps, out, json } = harness();
    await searchCommand(['from:billing@example.com'], deps);
    expect(deps.gmail).toHaveBeenCalledWith('search_emails');
    expect(json()).toEqual({
      query: 'from:billing@example.com',
      count: 1,
      messages: [{ id: 'm1', subject: 'Invoice', from: 'Billing <billing@example.com>', date: 'Mon, 07 Sep 2026 14:00:00 +0000' }],
    });
    expect(out).toHaveLength(1);
  });

  it('passes --max-results to the tool, which otherwise defaults to 10', async () => {
    const fake = fakeGmail();
    await searchCommand(['in:inbox'], harness(fake.gmail).deps);
    expect(fake.list).toHaveBeenLastCalledWith({ userId: 'me', q: 'in:inbox', maxResults: 10 });
    await searchCommand(['in:inbox', '--max-results', '25'], harness(fake.gmail).deps);
    expect(fake.list).toHaveBeenLastCalledWith({ userId: 'me', q: 'in:inbox', maxResults: 25 });
  });

  it('writes the JSON to -o instead of stdout', async () => {
    const { deps, out } = harness();
    const file = path.join(dir, 'result.json');
    await searchCommand(['from:billing@example.com', '-o', file], deps);
    expect(out).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).count).toBe(1);
  });

  it('rejects a missing or extra query and a non-positive --max-results as usage errors', async () => {
    const { deps, out } = harness();
    await expect(searchCommand([], deps)).rejects.toThrow(UsageError);
    await expect(searchCommand(['a', 'b'], deps)).rejects.toThrow(UsageError);
    await expect(searchCommand(['a', '--max-results', '0'], deps)).rejects.toThrow(UsageError);
    await expect(searchCommand(['a', '--max-results', 'ten'], deps)).rejects.toThrow(UsageError);
    expect(out).toEqual([]);
  });
});

describe('gmail-get-message', () => {
  it('prints the message fields with the plain-text body by default', async () => {
    const { deps, json } = harness();
    await getMessageCommand(['m1'], deps);
    expect(deps.gmail).toHaveBeenCalledWith('read_email');
    expect(json()).toEqual({
      id: 'm1',
      threadId: 't1',
      subject: 'Invoice',
      from: 'Billing <billing@example.com>',
      to: 'me@example.com',
      cc: 'boss@example.com',
      date: 'Mon, 07 Sep 2026 14:00:00 +0000',
      messageIdHeader: null,
      labels: ['INBOX'],
      body: 'Plain body',
      bodySource: 'text',
      attachments: [{ id: 'att-1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 14 }],
    });
  });

  it('prints the converted HTML part and bodySource html-over-stub when the plain part is a stub', async () => {
    const stubbed = { ...message, payload: { ...message.payload, parts: [
      { mimeType: 'text/plain', body: { data: b64('Plain text version not available.') } },
      { mimeType: 'text/html', body: { data: b64('<p>Real <b>content</b></p>') } },
    ] } };
    const gmail = { users: { messages: { get: async () => ({ data: stubbed }) } } } as unknown as gmail_v1.Gmail;
    const { deps, json } = harness(gmail);
    await getMessageCommand(['m1'], deps);
    expect(json()).toMatchObject({ body: 'Real content', bodySource: 'html-over-stub' });
  });

  it('prints the Message-ID header as messageIdHeader, null when the message has none', async () => {
    const withHeader = { ...message, payload: { ...message.payload, headers: [...message.payload.headers, { name: 'Message-ID', value: '<inv.1@example.com>' }] } };
    const gmail = { users: { messages: { get: async () => ({ data: withHeader }) } } } as unknown as gmail_v1.Gmail;
    const first = harness(gmail);
    await getMessageCommand(['m1'], first.deps);
    expect(first.json().messageIdHeader).toBe('<inv.1@example.com>');

    const second = harness();
    await getMessageCommand(['m1'], second.deps);
    expect(second.json()).toHaveProperty('messageIdHeader', null);
  });

  it('converts the HTML part to Markdown with --format markdown and says the body came from it', async () => {
    const { deps, json } = harness();
    await getMessageCommand(['m1', '--format', 'markdown'], deps);
    expect(json()).toMatchObject({ body: 'See [this](https://x.test)', bodySource: 'html' });
  });

  it('keeps html-over-stub for markdown when the HTML part is taken over a stub', async () => {
    const stubbed = { ...message, payload: { ...message.payload, parts: [
      { mimeType: 'text/plain', body: { data: b64('Plain text version not available.') } },
      { mimeType: 'text/html', body: { data: b64('<p>Real <b>content</b></p>') } },
    ] } };
    const gmail = { users: { messages: { get: async () => ({ data: stubbed }) } } } as unknown as gmail_v1.Gmail;
    const { deps, json } = harness(gmail);
    await getMessageCommand(['m1', '--format', 'markdown'], deps);
    expect(json()).toMatchObject({ body: 'Real **content**', bodySource: 'html-over-stub' });
  });

  it('falls back to the text body for markdown when the message has no HTML', async () => {
    const textOnly = { ...message, payload: { mimeType: 'text/plain', body: { data: b64('Just *text*') } } };
    const gmail = { users: { messages: { get: async () => ({ data: textOnly }) } } } as unknown as gmail_v1.Gmail;
    const { deps, json } = harness(gmail);
    await getMessageCommand(['m1', '--format', 'markdown'], deps);
    expect(json()).toMatchObject({ body: 'Just *text*', bodySource: 'text' });
  });

  it('rejects an unknown format and fails with nothing on stdout when the message is missing', async () => {
    const { deps, out } = harness();
    await expect(getMessageCommand(['m1', '--format', 'html'], deps)).rejects.toThrow(UsageError);
    const missing = getMessageCommand(['nope'], deps);
    await expect(missing).rejects.toMatchObject({ response: { status: 404 } });
    expect(mapErrorToExitCode(await missing.catch(error => error))).toBe(5);
    expect(out).toEqual([]);
  });
});

describe('runCli error line', () => {
  let stderr: string[];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints one line naming the action, the reason and the status, and keeps the exit code and empty stdout', async () => {
    const gmail = {
      users: { messages: { get: async () => {
        throw Object.assign(new Error('Requested entity was not found.'), {
          code: 404,
          errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
          response: { status: 404, data: { error: { code: 404, errors: [{ reason: 'notFound' }] } } },
        });
      } } },
    } as unknown as gmail_v1.Gmail;
    const { deps, out } = harness(gmail);
    const code = await runCli('gmail-get-message', getMessageCommand, ['nope'], deps);
    expect(code).toBe(5);
    expect(out).toEqual([]);
    expect(stderr).toEqual(['Failed to get message: Requested entity was not found. (code notFound, HTTP 404)\n']);
  });

  it('puts the help hint for a usage error on the same line', async () => {
    const { deps, out } = harness();
    const code = await runCli('gmail-search', searchCommand, [], deps);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(stderr).toEqual(["Failed to search messages: missing <gmail query>; run 'gmail-search --help' for usage\n"]);
  });

  it('reports a refused scope in the same form, with exit code 3', async () => {
    const { deps } = harness();
    vi.mocked(deps.gmail).mockImplementation((toolName: string) => {
      throw new ScopeError(toolName);
    });
    const code = await runCli('gmail-search', searchCommand, ['in:inbox'], deps);
    expect(code).toBe(3);
    expect(stderr).toEqual([
      'Failed to search messages: Tool "search_emails" is not available. You may need to re-authenticate with additional scopes.\n',
    ]);
  });
});

describe('gmail-download-attachment', () => {
  it('saves the file and prints {path, size, mimeType}', async () => {
    const { deps, json } = harness();
    await downloadAttachmentCommand(['m1', 'att-1', '--save-path', dir], deps);
    expect(deps.gmail).toHaveBeenCalledWith('download_attachment');
    const saved = path.join(dir, 'invoice.pdf');
    expect(json()).toEqual({ path: saved, size: 14, mimeType: 'application/pdf' });
    expect(fs.readFileSync(saved, 'utf8')).toBe('%PDF-1.7 bytes');
  });

  it('saves under --filename and still reports the MIME type', async () => {
    const { deps, json } = harness();
    await downloadAttachmentCommand(['m1', 'att-1', '--save-path', dir, '--filename', 'copy.pdf'], deps);
    expect(json()).toEqual({ path: path.join(dir, 'copy.pdf'), size: 14, mimeType: 'application/pdf' });
  });

  it('requires both ids and --save-path', async () => {
    const { deps } = harness();
    await expect(downloadAttachmentCommand(['m1', 'att-1'], deps)).rejects.toThrow(UsageError);
    await expect(downloadAttachmentCommand(['m1', '--save-path', dir], deps)).rejects.toThrow(UsageError);
  });

  it('treats a failed download as an error with nothing on stdout', async () => {
    const fake = fakeGmail();
    fake.attachmentsGet.mockResolvedValueOnce({ data: { data: '' } });
    const { deps, out } = harness(fake.gmail);
    await expect(downloadAttachmentCommand(['m1', 'att-1', '--save-path', dir], deps)).rejects.toThrow('No attachment data received');
    expect(out).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('gmail-create-draft', () => {
  // A saved draft as drafts.get returns it. Its values differ from any input, so a test can
  // tell a read-back from an echo.
  const savedDraft = {
    id: 'r-draft-1',
    message: {
      id: 'm-draft-1',
      threadId: 't-draft-1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'To', value: 'Alice <alice@example.com>, bob@example.com' },
          { name: 'Cc', value: 'carol@example.com' },
          { name: 'Bcc', value: 'dave@example.com' },
          { name: 'Subject', value: 'Saved subject' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('saved body'), size: 10 } },
          { mimeType: 'application/pdf', filename: 'saved.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="saved.pdf"' }], body: { attachmentId: 'a1', size: 4321 } },
          { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }, { name: 'Content-ID', value: '<logo>' }], body: { attachmentId: 'a2', size: 99 } },
          // nodemailer marks an attached message inline without a Content-ID; it is still an attachment.
          { mimeType: 'message/rfc822', filename: 'original.eml', headers: [{ name: 'Content-Disposition', value: 'inline; filename="original.eml"' }], body: { attachmentId: 'a3', size: 777 } },
        ],
      },
    },
  };

  function draftGmail() {
    const create = vi.fn(async (_params: { requestBody: { message: { raw: string; threadId?: string } } }) => ({ data: { id: 'r-draft-1' } }));
    const get = vi.fn(async (_params: { id: string; format: string }) => ({ data: savedDraft }));
    const send = vi.fn();
    const threadsGet = vi.fn(async () => ({ data: { messages: [
      { payload: { headers: [{ name: 'Message-ID', value: '<first@example.com>' }] } },
      { payload: { headers: [{ name: 'Message-ID', value: '<last@example.com>' }] } },
    ] } }));
    const gmail = { users: {
      drafts: { create, get, send },
      messages: { send },
      threads: { get: threadsGet },
    } } as unknown as gmail_v1.Gmail;
    const raw = () => Buffer.from(create.mock.calls[0][0].requestBody.message.raw, 'base64url').toString('utf8');
    return { gmail, create, get, send, threadsGet, raw };
  }

  const write = (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('creates the draft, never sends, and prints the fields read back from the saved draft', async () => {
    const fake = draftGmail();
    const { deps, json } = harness(fake.gmail);
    const bodyFile = write('body.txt', 'Grüße aus Stroud — £5');
    const attachment = write('report.pdf', '%PDF-1.7 report');
    await createDraftCommand([
      '--to', 'alice@example.com,bob@example.com', '--cc', 'carol@example.com', '--bcc', 'dave@example.com',
      '--subject', 'Quarterly report', '--body-file', bodyFile, '--attachment', attachment,
    ], deps);
    expect(deps.gmail).toHaveBeenCalledWith('draft_email');
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.get).toHaveBeenCalledWith({ userId: 'me', id: 'r-draft-1', format: 'full' });
    const raw = fake.raw();
    expect(raw).toContain('To: alice@example.com, bob@example.com');
    expect(raw).toContain('Subject: Quarterly report');
    expect(raw).toContain('filename=report.pdf');
    // The body file's UTF-8 bytes, quoted-printable encoded: "Grüße aus Stroud — £5".
    expect(raw).toContain('Gr=C3=BC=C3=9Fe aus Stroud =E2=80=94 =C2=A35');
    expect(json()).toEqual({
      draft_id: 'r-draft-1',
      message_id: 'm-draft-1',
      thread_id: 't-draft-1',
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
      bcc: ['dave@example.com'],
      subject: 'Saved subject',
      attachments: [{ name: 'saved.pdf', size: 4321 }, { name: 'original.eml', size: 777 }],
    });
  });

  it('sends an HTML-only body as text/html, and both bodies as multipart/alternative, when no --mime-type is given', async () => {
    const htmlOnly = draftGmail();
    await createDraftCommand(['--to', 'a@example.com', '--subject', 's', '--html-body', '<p>Hello <b>there</b></p>'], harness(htmlOnly.gmail).deps);
    expect(htmlOnly.raw()).toContain('Content-Type: text/html');
    expect(htmlOnly.raw()).toContain('<p>Hello <b>there</b></p>');

    const both = draftGmail();
    await createDraftCommand(['--to', 'a@example.com', '--subject', 's', '--body', 'Hello', '--html-body', '<p>Hello</p>'], harness(both.gmail).deps);
    expect(both.raw()).toContain('Content-Type: multipart/alternative');
    expect(both.raw()).toContain('<p>Hello</p>');
  });

  it('takes the tool\'s JSON request from --input, with options overriding its fields', async () => {
    const fake = draftGmail();
    const { deps } = harness(fake.gmail);
    const input = write('request.json', JSON.stringify({ to: ['old@example.com'], subject: 'From input', body: 'Input body', cc: ['keep@example.com'] }));
    await createDraftCommand(['--input', input, '--to', 'new@example.com'], deps);
    const raw = fake.raw();
    expect(raw).toContain('To: new@example.com');
    expect(raw).toContain('Cc: keep@example.com');
    expect(raw).toContain('Subject: From input');
    expect(raw).toContain('Input body');
  });

  it('builds an HTML draft with an inline image from files', async () => {
    const fake = draftGmail();
    const { deps } = harness(fake.gmail);
    const html = write('body.html', '<p>Hello <img src="cid:logo"></p>');
    const image = write('logo.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    await createDraftCommand([
      '--to', 'alice@example.com', '--subject', 'With logo', '--body', 'Hello',
      '--html-body-file', html, '--mime-type', 'multipart/alternative', '--inline-image', `cid=logo,path=${image}`,
    ], deps);
    const raw = fake.raw();
    expect(raw).toContain('Content-ID: <logo>');
    expect(raw).toContain('text/html');
  });

  it('accepts a send-as address with a display name', async () => {
    const fake = draftGmail();
    await createDraftCommand(['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--from', 'Team <team@example.com>'], harness(fake.gmail).deps);
    expect(fake.raw()).toContain('From: Team <team@example.com>');
  });

  it('sets the threading headers from the thread like draft_email', async () => {
    const fake = draftGmail();
    const { deps } = harness(fake.gmail);
    await createDraftCommand(['--to', 'alice@example.com', '--subject', 'Re: x', '--body', 'b', '--thread-id', 't-1'], deps);
    expect(fake.create.mock.calls[0][0].requestBody.message.threadId).toBe('t-1');
    const raw = fake.raw();
    expect(raw).toContain('In-Reply-To: <last@example.com>');
    expect(raw).toContain('References: <first@example.com> <last@example.com>');
  });

  it('exits 2 before calling Gmail for an unknown option, a missing input, an unreadable file or a bad value', async () => {
    const body = write('ok.txt', 'body');
    for (const argv of [
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--send'],
      ['--subject', 's', '--body', 'b'],
      ['--to', 'a@example.com', '--body', 'b'],
      ['--to', 'a@example.com', '--subject', 's'],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--attachment', path.join(dir, 'missing.pdf')],
      ['--to', 'a@example.com', '--subject', 's', '--body-file', path.join(dir, 'missing.txt')],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--body-file', body],
      ['--to', 'not-an-address', '--subject', 's', '--body', 'b'],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--mime-type', 'text/rtf'],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--inline-image', `cid=logo,path=${body}`],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--html-body', '<p>x</p>', '--inline-image', `path=${body}`],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', 'stray'],
      ['--input', path.join(dir, 'missing.json')],
      ['--to', 'a@example.com', '--subject', 's', '--body', 'b', '--from', 'not-an-address'],
      ['--input', write('bad-from.json', JSON.stringify({ to: ['a@example.com'], subject: 's', body: 'b', from: 'Team <not-an-address>' }))],
      ['--to', 'a@example.com', '--subject', 's', '--html-body', '<p>x</p>', '--mime-type', 'text/plain'],
    ]) {
      const { deps, out } = harness(draftGmail().gmail);
      const failed = await createDraftCommand(argv, deps).catch(error => error);
      expect(mapErrorToExitCode(failed), argv.join(' ')).toBe(2);
      expect(deps.gmail, argv.join(' ')).not.toHaveBeenCalled();
      expect(out).toEqual([]);
    }
  });

  it('refuses an --output that would overwrite one of its own input files', async () => {
    const body = write('body.txt', 'keep me');
    const { deps } = harness(draftGmail().gmail);
    await expect(createDraftCommand(['--to', 'a@example.com', '--subject', 's', '--body-file', body, '-o', body], deps))
      .rejects.toThrow(/would overwrite the body file/);
    expect(deps.gmail).not.toHaveBeenCalled();
    expect(fs.readFileSync(body, 'utf8')).toBe('keep me');
  });
});

describe('gmail-get-attachment-text', () => {
  const fixtureFile = (name: string) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'attachment-text', '__fixtures__', name));
  const attachmentGmail = (filename: string, mimeType: string, bytes: Buffer) => ({ users: { messages: {
    attachments: { get: vi.fn(async () => ({ data: { data: bytes.toString('base64url') } })) },
    get: vi.fn(async () => ({ data: { payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType, filename, body: { attachmentId: 'refetched', size: bytes.length } },
    ] } } })),
  } } }) as unknown as gmail_v1.Gmail;

  it('prints {name, format, text, truncated, sheets}', async () => {
    const workbook = fixtureFile('two-sheets.xlsx');
    const { deps, json } = harness(attachmentGmail('sales.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook));
    await getAttachmentTextCommand(['m1', 'a1'], deps);
    expect(deps.gmail).toHaveBeenCalledWith('get_attachment_text');
    const result = json();
    expect(Object.keys(result)).toEqual(['name', 'format', 'text', 'truncated', 'sheets']);
    expect(result).toMatchObject({ name: 'sales.xlsx', format: 'xlsx', truncated: false, sheets: [{ name: 'Sales', rows: 4, columns: 4 }, { name: 'Notes', rows: 2, columns: 3 }] });
  });

  it('exits 6 with one line naming the cause for a file it cannot read, and nothing on stdout', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
    try {
      for (const [filename, mimeType, bytes, line] of [
        ['secret.pdf', 'application/pdf', fixtureFile('protected.pdf'), 'Failed to get attachment text: protected file: the PDF needs a password to open'],
        ['locked.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fixtureFile('encrypted.xlsx'), 'Failed to get attachment text: encrypted file: the workbook is encrypted with a password'],
        ['broken.pdf', 'application/pdf', Buffer.from('%PDF-1.4 truncated'), 'Failed to get attachment text: corrupt file: the PDF cannot be read'],
      ] as const) {
        stderr.length = 0;
        const { deps, out } = harness(attachmentGmail(filename, mimeType, bytes));
        expect(await runCli('gmail-get-attachment-text', getAttachmentTextCommand, ['m1', 'a1'], deps)).toBe(6);
        expect(out).toEqual([]);
        expect(stderr).toEqual([`${line}\n`]);
      }
      const { deps } = harness(attachmentGmail('logo.png', 'image/png', Buffer.from('89504e47', 'hex')));
      expect(await runCli('gmail-get-attachment-text', getAttachmentTextCommand, ['m1', 'a1'], deps)).toBe(6);
      expect(stderr.at(-1)).toMatch(/^Failed to get attachment text: unsupported file: logo\.png \(image\/png\)/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('documents the formats, the output and the exit codes in --help', async () => {
    const { deps, out } = harness();
    await getAttachmentTextCommand(['--help'], deps);
    const help = out.join('');
    for (const expected of ['PDF', 'DOCX', 'XLSX', 'XLSM', 'XLS', 'CSV', 'text/*', '{name, format, text, truncated, sheets', '6 ', 'protected', 'encrypted', 'corrupt', 'unsupported']) {
      expect(help, expected).toContain(expected);
    }
  });

  it('needs both ids', async () => {
    const { deps } = harness();
    await expect(getAttachmentTextCommand(['m1'], deps)).rejects.toThrow(UsageError);
    expect(deps.gmail).not.toHaveBeenCalled();
  });
});

describe('gmail-batch-fetch-window', () => {
  const WATERMARK = '2026-09-07T12:00:00Z';

  it('runs the tool with its defaults and prints its result unchanged, writing the manifest files', async () => {
    const fake = fakeGmail();
    const { deps, json } = harness(fake.gmail);
    await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', dir], deps);
    expect(deps.gmail).toHaveBeenCalledWith('batch_fetch_window');
    const result = json();
    expect(result).toMatchObject({ status: 'ok', listed: 0, inWindow: 0, maxMessages: 2000, truncated: false, failures: [] });
    // cross_check defaults to true: the spam, trash and anywhere listings ran.
    expect(result.crossCheck.status).toBe('consistent');
    expect(fake.list.mock.calls.map(([params]) => params.q)).toEqual(expect.arrayContaining([expect.stringContaining('in:spam')]));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ listed: 0, inWindow: 0, messages: [] });
    expect(manifest).not.toHaveProperty('status');
    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(true);
  });

  it('passes --no-cross-check and --max-messages through', async () => {
    const fake = fakeGmail();
    const { deps, json } = harness(fake.gmail);
    await batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', dir, '--no-cross-check', '--max-messages', '5'], deps);
    expect(json()).toMatchObject({ maxMessages: 5, crossCheck: { status: 'skipped' } });
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it('rejects a zoneless watermark, a relative directory and a bad --max-messages before calling Gmail', async () => {
    const { deps } = harness();
    for (const argv of [
      ['--watermark', '2026-09-07T12:00:00', '--output-dir', dir],
      ['--watermark', WATERMARK, '--output-dir', 'relative/dir'],
      ['--watermark', WATERMARK, '--output-dir', dir, '--max-messages', '0'],
      ['--watermark', WATERMARK, '--output-dir', dir, '--max-messages', '1.5'],
      ['--output-dir', dir],
    ]) {
      const failed = await batchFetchWindowCommand(argv, deps).catch(error => error);
      expect(mapErrorToExitCode(failed), argv.join(' ')).toBe(2);
    }
    expect(deps.gmail).not.toHaveBeenCalled();
  });

  it('keeps the guard: a foreign messages/ directory is refused and nothing is printed or deleted', async () => {
    fs.mkdirSync(path.join(dir, 'messages'));
    fs.writeFileSync(path.join(dir, 'messages', 'keep.txt'), 'mine');
    const { deps, out } = harness();
    await expect(batchFetchWindowCommand(['--watermark', WATERMARK, '--output-dir', dir], deps)).rejects.toThrow(/refusing to delete/);
    expect(out).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'messages', 'keep.txt'), 'utf8')).toBe('mine');
  });
});
