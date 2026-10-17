#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { DEFAULT_SCOPES, parseScopes, validateScopes, getAvailableScopeNames } from "./scopes.js";
import { resolveToolPrefix } from "./tool-prefix.js";
import { authenticate, CredentialsError, loadCredentials } from "./auth.js";
import { createGmailServer } from "./server.js";

// Optional tool-name prefix — lets multiple instances of this server run side-by-side
// without their tool names colliding in clients that disambiguate by base name.
// Precedence: --tool-prefix=<value> / --tool-prefix <value> CLI flag, then
// GMAIL_MCP_TOOL_PREFIX env var, then empty (no prefix → backward compatible).
// Does not affect the `auth` subcommand, which is detected via process.argv[2] === 'auth'
// and exits before the server starts — run `auth` without --tool-prefix.
const TOOL_PREFIX = resolveToolPrefix(process.argv.slice(2), process.env);

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let authorizedScopes: string[] = DEFAULT_SCOPES;
let callbackUrl: URL;

function loadCredentialsOrExit() {
    // Parse callback URL from args (must be a URL, not a flag)
    // Supports: node index.js auth https://example.com/callback
    // Or: node index.js auth --scopes=gmail.readonly (uses default callback)
    const callbackArg = process.argv.find(arg =>
        arg.startsWith('http://') || arg.startsWith('https://')
    );
    try {
        ({ oauth2Client, authorizedScopes, callbackUrl } = loadCredentials({ callback: callbackArg, log: console.log }));
    } catch (error) {
        if (error instanceof CredentialsError) {
            console.error(error.message);
        } else {
            console.error('Error loading credentials:', error);
        }
        process.exit(1);
    }
}

// Main function
async function main() {
    loadCredentialsOrExit();

    if (process.argv[2] === 'auth') {
        // Parse --scopes flag from CLI arguments
        // Usage: node dist/index.js auth --scopes=<scope1,scope2,...>
        // Example: node dist/index.js auth --scopes=gmail.readonly
        // Example: node dist/index.js auth --scopes=gmail.readonly,gmail.settings.basic
        const scopesArg = process.argv.find(arg => arg.startsWith('--scopes='));
        let scopes = DEFAULT_SCOPES;

        if (scopesArg) {
            const scopesValue = scopesArg.slice('--scopes='.length);
            scopes = parseScopes(scopesValue);
            const validation = validateScopes(scopes);

            if (!validation.valid) {
                console.error('Error: Invalid scope(s):', validation.invalid.join(', '));
                console.error('Available scopes:', getAvailableScopeNames().join(', '));
                process.exit(1);
            }
        } else {
            console.log('No --scopes flag specified, using defaults:', DEFAULT_SCOPES.join(', '));
            console.log('Tip: Use --scopes=gmail.readonly for read-only access');
            console.log('Available scopes:', getAvailableScopeNames().join(', '));
        }

        await authenticate(oauth2Client, callbackUrl, scopes, console.log);
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const server = createGmailServer({ gmail, oauth2Client, authorizedScopes, toolPrefix: TOOL_PREFIX });
    const transport = new StdioServerTransport();
    server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
