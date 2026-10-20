/**
 * Email export utilities for converting Gmail messages to various formats
 */

import emailAddresses from "email-addresses";
import { headerValue, selectBody, type BodySource } from "./message-body.js";

// Types
export interface ParsedAddress {
    name: string;
    email: string;
}

export interface EmailAttachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
}

export interface EmailJson {
    messageId: string;
    threadId: string;
    subject: string;
    from: ParsedAddress;
    to: ParsedAddress[];
    cc: ParsedAddress[];
    bcc: ParsedAddress[];
    date: string;
    labels: string[];
    snippet: string;
    // text is the body as a text file carries it (see bodyAsText); plain and html are the
    // message's parts as they are.
    body: {
        text: string;
        plain: string;
        html: string;
    };
    bodySource: BodySource;
    attachments: EmailAttachment[];
    headers: Record<string, string>;
}

/**
 * Parse email address string into name and email components
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
export function parseEmailAddress(address: string): ParsedAddress {
    if (!address) return { name: "", email: "" };

    const parsed = emailAddresses.parseOneAddress(address);
    if (parsed && parsed.type === "mailbox") {
        return {
            name: parsed.name || "",
            email: parsed.address || "",
        };
    }
    return { name: "", email: address.trim() };
}

/**
 * Parse comma-separated list of email addresses
 * Uses RFC 5322 compliant parser (email-addresses package)
 */
export function parseEmailAddresses(addresses: string | undefined): ParsedAddress[] {
    if (!addresses) return [];

    const parsed = emailAddresses.parseAddressList(addresses);
    if (!parsed) return [];

    return parsed
        .filter((entry): entry is emailAddresses.ParsedMailbox => entry.type === "mailbox")
        .map((entry) => ({
            name: entry.name || "",
            email: entry.address || "",
        }));
}

// The body a text format carries: the plain part, or the HTML part converted to text when there
// is no plain part or the plain part is only a stub.
function bodyAsText(emailContent: { text: string; html: string }) {
    return selectBody(emailContent.text, emailContent.html, "convert-html");
}

/**
 * Convert Gmail API message to structured JSON
 */
export function gmailMessageToJson(
    message: any,
    emailContent: { text: string; html: string },
    attachments: EmailAttachment[]
): EmailJson {
    const getHeader = (name: string) => headerValue(message.payload?.headers, name);

    const dateStr = getHeader("date");
    let isoDate = "";
    try {
        isoDate = new Date(dateStr).toISOString();
    } catch {
        isoDate = dateStr; // Keep original if parsing fails
    }
    const { body, bodySource } = bodyAsText(emailContent);

    return {
        messageId: message.id,
        threadId: message.threadId,
        subject: getHeader("subject"),
        from: parseEmailAddress(getHeader("from")),
        to: parseEmailAddresses(getHeader("to")),
        cc: parseEmailAddresses(getHeader("cc")),
        bcc: parseEmailAddresses(getHeader("bcc")),
        date: isoDate,
        labels: message.labelIds || [],
        snippet: message.snippet || "",
        body: {
            text: body,
            plain: emailContent.text,
            html: emailContent.html,
        },
        bodySource,
        attachments,
        headers: {
            "Message-ID": getHeader("message-id"),
            "In-Reply-To": getHeader("in-reply-to"),
            References: getHeader("references"),
        },
    };
}

/**
 * Format address for display
 */
function formatAddress(a: ParsedAddress): string {
    return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Format list of addresses for display
 */
function formatAddresses(addrs: ParsedAddress[]): string {
    return addrs.map(formatAddress).join(", ");
}

/**
 * Convert email to plain text format
 */
export function emailToTxt(
    message: any,
    emailContent: { text: string; html: string },
    attachments: EmailAttachment[]
): string {
    const getHeader = (name: string) => headerValue(message.payload?.headers, name);

    const from = getHeader("from");
    const to = getHeader("to");
    const cc = getHeader("cc");
    const subject = getHeader("subject");
    const date = getHeader("date");

    const lines = [`From: ${from}`, `To: ${to}`];

    if (cc) {
        lines.push(`CC: ${cc}`);
    }

    lines.push(`Subject: ${subject}`);
    lines.push(`Date: ${date}`);
    lines.push("");
    lines.push(bodyAsText(emailContent).body || "[No plain text content]");

    if (attachments.length > 0) {
        lines.push("");
        lines.push("---");
        lines.push(`Attachments: ${attachments.map((a) => a.filename).join(", ")}`);
    }

    return lines.join("\n");
}

/**
 * Extract HTML content from email, or throw if none exists
 */
export function emailToHtml(emailContent: { text: string; html: string }): string {
    if (!emailContent.html) {
        throw new Error("This email has no HTML content");
    }
    return emailContent.html;
}
