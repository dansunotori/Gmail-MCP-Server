/**
 * What the live tests at the repository root share: a Gmail client signed in with this server's
 * saved OAuth credential (~/.gmail-mcp), and the base64url encoding Gmail takes a raw message in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

export function liveGmail() {
    const keysFile = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
    const keys = keysFile.installed || keysFile.web;
    const credFile = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const tokens = credFile.tokens || credFile;
    const auth = new OAuth2Client(keys.client_id, keys.client_secret, 'http://localhost:3000/oauth2callback');
    auth.setCredentials(tokens);
    return google.gmail({ version: 'v1', auth });
}

export function encodeRaw(message) {
    return Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
