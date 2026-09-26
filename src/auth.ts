/**
 * OAuth credential loading and the interactive sign-in flow, shared by the MCP server and the
 * command-line tools. Progress lines go through an injected `log` so the server can keep
 * printing them to stdout while the command-line tools send them to stderr.
 */

import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import http from 'http';
import open from 'open';
import os from 'os';
import { DEFAULT_SCOPES, scopeNamesToUrls } from './scopes.js';

// Configuration paths
export const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');

export function oauthPath(): string {
    return process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
}

export function credentialsPath(): string {
    return process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');
}

// OAuth keys in the current directory, which loadCredentials copies over oauthPath().
export function localOAuthPath(): string {
    return path.join(process.cwd(), 'gcp-oauth.keys.json');
}

export type Log = (line: string) => void;

export class CredentialsError extends Error {
    readonly kind: 'missing-oauth-keys' | 'invalid-oauth-keys' | 'missing-credentials' | 'invalid-credentials';

    constructor(kind: CredentialsError['kind'], message: string) {
        super(message);
        this.name = 'CredentialsError';
        this.kind = kind;
    }
}

// Reads a JSON object from a credentials file; unreadable JSON, or JSON that is not an object,
// is a CredentialsError of the given kind rather than a bare SyntaxError or TypeError.
function readJsonObject(file: string, kind: CredentialsError['kind'], describe: string): Record<string, any> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new CredentialsError(kind, `Error: ${describe} ${file} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CredentialsError(kind, `Error: ${describe} ${file} does not contain a JSON object.`);
    }
    return parsed as Record<string, any>;
}

export interface LoadedCredentials {
    oauth2Client: OAuth2Client;
    authorizedScopes: string[];
    callbackUrl: URL;
}

export function loadCredentials(options: {
    // OAuth callback URL; defaults to the local listener.
    callback?: string;
    log?: Log;
    // Throw `missing-credentials` when no credentials file exists yet.
    requireCredentials?: boolean;
} = {}): LoadedCredentials {
    const log = options.log ?? console.log;
    const OAUTH_PATH = oauthPath();
    const CREDENTIALS_PATH = credentialsPath();

    // Create config directory if it doesn't exist
    if (!process.env.GMAIL_OAUTH_PATH && !process.env.GMAIL_CREDENTIALS_PATH && !fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }

    // Check for OAuth keys in current directory first, then in config directory
    const localKeys = localOAuthPath();

    if (fs.existsSync(localKeys)) {
        // If found in current directory, copy to config directory
        fs.copyFileSync(localKeys, OAUTH_PATH);
        log('OAuth keys found in current directory, copied to global config.');
    }

    if (!fs.existsSync(OAUTH_PATH)) {
        throw new CredentialsError('missing-oauth-keys', `Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or ${CONFIG_DIR}`);
    }

    const keysContent = readJsonObject(OAUTH_PATH, 'invalid-oauth-keys', 'OAuth keys file');
    const keys = keysContent.installed || keysContent.web;

    if (!keys) {
        throw new CredentialsError('invalid-oauth-keys', 'Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.');
    }

    const callback = options.callback || "http://localhost:3000/oauth2callback";
    const callbackUrl = new URL(callback);

    // The built-in listener is plain HTTP. An https:// callback is only valid
    // in the documented reverse-proxy setup (README "Cloud Server Authentication"),
    // where TLS terminates at the proxy and traffic is forwarded to the local
    // listener on port 3000. Direct browser->listener https would hang.
    if (callbackUrl.protocol === 'https:') {
        log('https callback URL detected: assuming a reverse proxy terminates TLS and forwards to the local listener on port 3000 (see README "Cloud Server Authentication").');
    }

    const oauth2Client = new OAuth2Client(
        keys.client_id,
        keys.client_secret,
        callback
    );
    let authorizedScopes = DEFAULT_SCOPES;

    if (fs.existsSync(CREDENTIALS_PATH)) {
        const credentials = readJsonObject(CREDENTIALS_PATH, 'invalid-credentials', 'Saved credentials file');

        // Credentials file structure (v1.2.0+):
        //   { "tokens": { access_token, refresh_token, ... }, "scopes": ["gmail.readonly", ...] }
        //
        // Legacy structure (pre-v1.2.0):
        //   { access_token, refresh_token, ... }
        //
        // We support both formats for backwards compatibility. Users with legacy
        // credentials will get DEFAULT_SCOPES (full access) until they re-authenticate.
        const tokens = credentials.tokens || credentials;
        oauth2Client.setCredentials(tokens);

        if (credentials.scopes) {
            authorizedScopes = credentials.scopes;
        }

        // Persist refreshed tokens so refresh_token survives access_token rotation.
        // Without this, google-auth-library's silent refresh updates only the
        // in-memory client; on next process start we'd re-read a stale token.
        oauth2Client.on('tokens', (newTokens) => {
            try {
                const onDisk = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
                const currentTokens = onDisk.tokens || onDisk;
                const mergedTokens = newTokens.refresh_token
                    ? { ...currentTokens, ...newTokens }
                    : { ...currentTokens, access_token: newTokens.access_token, expiry_date: newTokens.expiry_date };
                const updated = onDisk.tokens
                    ? { ...onDisk, tokens: mergedTokens }
                    : mergedTokens;
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 });
            } catch (err) {
                console.error('Failed to persist refreshed tokens:', err);
            }
        });
    } else if (options.requireCredentials) {
        throw new CredentialsError('missing-credentials', `No saved credentials at ${CREDENTIALS_PATH}; sign in first with --auth`);
    }

    return { oauth2Client, authorizedScopes, callbackUrl };
}

export async function authenticate(oauth2Client: OAuth2Client, callbackUrl: URL, scopes: string[], log: Log = console.log) {
    const CREDENTIALS_PATH = credentialsPath();
    const server = http.createServer();
    // Port derivation:
    // - explicit port in the callback URL -> use it
    // - portless http -> protocol default 80 (NOT 3000 — that fallback caused
    //   the silent-hang bug this derivation exists to fix)
    // - https -> reverse-proxy setup; the proxy forwards to the local listener
    //   on 3000 (documented default in README "Cloud Server Authentication")
    const port = callbackUrl.port
        ? Number(callbackUrl.port)
        : (callbackUrl.protocol === 'https:' ? 3000 : 80);
    server.listen(port, '127.0.0.1');

    // Convert shorthand scope names (e.g., "gmail.readonly") to full Google API URLs
    const scopeUrls = scopeNamesToUrls(scopes);

    return new Promise<void>((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: scopeUrls,
        });

        log(`Requesting scopes: ${scopes.join(', ')}`);
        log(`Please visit this URL to authenticate: ${authUrl}`);
        open(authUrl);

        server.on('request', async (req, res) => {
            if (!req.url?.startsWith(callbackUrl.pathname)) return;

            const url = new URL(req.url, callbackUrl.origin);
            const code = url.searchParams.get('code');

            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                reject(new Error('No code provided'));
                return;
            }

            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);

                // Store both tokens and authorized scopes for runtime filtering
                const credentials = { tokens, scopes };
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                log(`Credentials saved with scopes: ${scopes.join(', ')}`);
                server.close();
                resolve();
            } catch (error) {
                res.writeHead(500);
                res.end('Authentication failed');
                reject(error);
            }
        });
    });
}
