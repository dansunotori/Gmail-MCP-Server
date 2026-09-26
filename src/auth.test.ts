import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsError, loadCredentials } from './auth.js';
import { DEFAULT_SCOPES } from './scopes.js';

const KEYS = { installed: { client_id: 'id', client_secret: 'secret' } };

describe('loadCredentials', () => {
  let dir: string;
  let oauthPath: string;
  let credentialsPath: string;
  const saved = { oauth: process.env.GMAIL_OAUTH_PATH, credentials: process.env.GMAIL_CREDENTIALS_PATH };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
    oauthPath = path.join(dir, 'keys.json');
    credentialsPath = path.join(dir, 'credentials.json');
    process.env.GMAIL_OAUTH_PATH = oauthPath;
    process.env.GMAIL_CREDENTIALS_PATH = credentialsPath;
  });

  afterEach(() => {
    process.env.GMAIL_OAUTH_PATH = saved.oauth;
    process.env.GMAIL_CREDENTIALS_PATH = saved.credentials;
    if (saved.oauth === undefined) delete process.env.GMAIL_OAUTH_PATH;
    if (saved.credentials === undefined) delete process.env.GMAIL_CREDENTIALS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function kindOf(run: () => unknown): string | undefined {
    try {
      run();
    } catch (error) {
      return error instanceof CredentialsError ? error.kind : 'other';
    }
    return undefined;
  }

  it('throws missing-oauth-keys when the keys file is absent', () => {
    expect(kindOf(() => loadCredentials())).toBe('missing-oauth-keys');
  });

  it('throws invalid-oauth-keys when the keys file has neither installed nor web', () => {
    fs.writeFileSync(oauthPath, JSON.stringify({ other: {} }));
    expect(kindOf(() => loadCredentials())).toBe('invalid-oauth-keys');
  });

  it('throws invalid-oauth-keys when the keys file is not JSON or not an object', () => {
    for (const content of ['{not json', 'null', '[]', '"text"']) {
      fs.writeFileSync(oauthPath, content);
      expect(kindOf(() => loadCredentials()), content).toBe('invalid-oauth-keys');
    }
  });

  it('throws invalid-credentials when the saved credentials are not JSON or not an object', () => {
    fs.writeFileSync(oauthPath, JSON.stringify(KEYS));
    for (const content of ['{not json', 'null', '[]', '42']) {
      fs.writeFileSync(credentialsPath, content);
      expect(kindOf(() => loadCredentials()), content).toBe('invalid-credentials');
      expect(kindOf(() => loadCredentials({ requireCredentials: true })), content).toBe('invalid-credentials');
    }
  });

  it('tolerates a missing credentials file unless credentials are required', () => {
    fs.writeFileSync(oauthPath, JSON.stringify(KEYS));
    const loaded = loadCredentials();
    expect(loaded.authorizedScopes).toEqual(DEFAULT_SCOPES);
    expect(loaded.callbackUrl.href).toBe('http://localhost:3000/oauth2callback');
    expect(kindOf(() => loadCredentials({ requireCredentials: true }))).toBe('missing-credentials');
  });

  it('loads the v1.2.0 shape with its scopes and the legacy shape with the default scopes', () => {
    fs.writeFileSync(oauthPath, JSON.stringify(KEYS));
    fs.writeFileSync(credentialsPath, JSON.stringify({ tokens: { refresh_token: 'r1' }, scopes: ['gmail.readonly'] }));
    const current = loadCredentials({ requireCredentials: true });
    expect(current.authorizedScopes).toEqual(['gmail.readonly']);
    expect(current.oauth2Client.credentials.refresh_token).toBe('r1');

    fs.writeFileSync(credentialsPath, JSON.stringify({ refresh_token: 'r2' }));
    const legacy = loadCredentials({ requireCredentials: true });
    expect(legacy.authorizedScopes).toEqual(DEFAULT_SCOPES);
    expect(legacy.oauth2Client.credentials.refresh_token).toBe('r2');
  });

  it('persists refreshed tokens, keeping the refresh token when Google omits it', () => {
    fs.writeFileSync(oauthPath, JSON.stringify(KEYS));
    fs.writeFileSync(credentialsPath, JSON.stringify({ tokens: { refresh_token: 'r1', access_token: 'a1' }, scopes: ['gmail.readonly'] }));
    const { oauth2Client } = loadCredentials();
    oauth2Client.emit('tokens', { access_token: 'a2', expiry_date: 42 });
    expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))).toEqual({
      tokens: { refresh_token: 'r1', access_token: 'a2', expiry_date: 42 },
      scopes: ['gmail.readonly'],
    });
  });

  it('routes progress lines through the injected log, never stdout', () => {
    fs.writeFileSync(oauthPath, JSON.stringify(KEYS));
    const stdout = vi.spyOn(process.stdout, 'write');
    const log = vi.fn();
    const cwd = process.cwd();
    process.chdir(dir);
    fs.writeFileSync(path.join(dir, 'gcp-oauth.keys.json'), JSON.stringify(KEYS));
    try {
      loadCredentials({ callback: 'https://proxy.example.com/cb', log });
      // Before mockRestore, which clears the recorded calls.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      process.chdir(cwd);
      stdout.mockRestore();
    }
    expect(log.mock.calls.map(call => call[0])).toEqual([
      'OAuth keys found in current directory, copied to global config.',
      expect.stringContaining('https callback URL detected'),
    ]);
  });
});
