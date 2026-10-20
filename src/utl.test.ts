/** Tests for email threading headers. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmailMessage } from './utl.js';
import { extractHeaders, formatReadEmailText } from './read-tools.js';

// Resolve src directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

// Helper: extract a header value from a raw MIME message string
function getHeader(raw: string, headerName: string): string | null {
    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
}

describe('Email threading headers', () => {
    it('uses separate references field when provided', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Thread test',
            body: 'Reply body',
            inReplyTo: '<msg3@example.com>',
            references: '<msg1@example.com> <msg2@example.com> <msg3@example.com>',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBe(
            '<msg1@example.com> <msg2@example.com> <msg3@example.com>'
        );
        expect(getHeader(raw, 'In-Reply-To')).toBe('<msg3@example.com>');
    });

    it('falls back to inReplyTo when references is absent', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Fallback test',
            body: 'Reply body',
            inReplyTo: '<single@example.com>',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBe('<single@example.com>');
    });

    it('has no threading headers on new emails', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'New email',
            body: 'Fresh email body',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBeNull();
        expect(getHeader(raw, 'In-Reply-To')).toBeNull();
    });
});

describe('Source verification', () => {
    it('createEmailWithNodemailer uses references field with inReplyTo fallback', () => {
        const source = fs.readFileSync(path.join(srcDir, 'utl.ts'), 'utf-8');
        expect(source).toContain('references: validatedArgs.references || validatedArgs.inReplyTo');
    });

    // Threading-header resolution is exercised through the tools themselves: server.test.ts
    // (send_email in a thread) and cli/commands.test.ts (gmail-create-draft --thread-id).
});

describe('read_email Message-ID', () => {
    it('read_email returns Message-ID', () => {
        const headers = extractHeaders({ headers: [{ name: 'Message-ID', value: '<m@x>' }] });
        const text = formatReadEmailText({
            id: 'm', threadId: 't', messageIdHeader: headers.rfcMessageId, subject: '', from: '', to: '', cc: '', bcc: '',
            date: '', labels: [], text: '', html: '', body: '', bodySource: 'text', htmlBody: null, attachments: [],
        });
        expect(text).toContain('Message-ID: <m@x>');
    });
});
