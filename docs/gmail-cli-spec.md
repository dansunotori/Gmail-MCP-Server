# Gmail CLI — Specification

Add command-line entry points to this repo so scripts (and Claude sessions) can search, read and
download Gmail deterministically without an MCP session. The commands (`search-mail`,
`get-message`, `list-attachments`, `get-attachment-text`) follow a common CLI pattern shared with
a sibling Outlook project; this document is self-contained and the output contracts below are the
requirement.

Requested by Sasha on 2026-09-08 for clients that need scripted "list every message since
watermark" and "read message in full" operations.

Note (2026-09-11): the routine mailbox pass now uses the `batch_fetch_window` MCP tool (see
`docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md`); the CLIs below remain
optional, for targeted reads.

## Non-negotiables

- JSON on stdout on success; diagnostics and progress on stderr; on failure stdout stays empty and
  the process exits non-zero. Scripts rely on `JSON.parse(stdout)`.
- Reuse the existing OAuth machinery: `~/.gmail-mcp/gcp-oauth.keys.json` +
  `~/.gmail-mcp/credentials.json`, including the persisted `refresh_token` handling already in
  `loadCredentials()`. No new credential store, no env-var secrets.
- Do not change MCP server behaviour. The CLIs are additive.
- No write operations (send, draft, label, trash) in this iteration. Read-only surface.

## Commands and bin entries

Add to `package.json` `bin` (then `npm link` once):

| bin | purpose |
|-|-|
| `gmail-search` | Search/list messages, compact metadata list |
| `gmail-get-message` | Full content of one message by ID |
| `gmail-download-attachment` | Save one attachment to disk |

Names are prefixed `gmail-` because `search-mail`/`get-message` are already taken globally by the
Outlook CLIs.

### gmail-search

```
gmail-search --query <q> [options]

  --query, -q <text>     Gmail search query (required)
  --limit, -l <num>      Max results (default 250, hard cap 500)
  --include-spam-trash   Pass includeSpamTrash=true (default: excluded, Gmail API default)
  --output, -o <file>    Write payload to file instead of stdout
  --auth                 Run the existing OAuth flow and exit
  --help, -h             Show help
```

Query is native Gmail search syntax (`from:`, `to:`, `subject:`, `after:`, `before:`,
`has:attachment`, `in:anywhere`, …). Document in the CLI help that `after:`/`before:` accept epoch
seconds as well as `YYYY/MM/DD` — epoch seconds are what watermark scripts should use, because the
date form is midnight in the account's time zone, not UTC.

Implementation: `gmail.users.messages.list` for IDs (paginate with `pageToken` until `--limit` is
reached), then batch metadata fetches (`format: 'metadata'`, headers Subject/From/Date) — reuse or
extend `batchGetGmailIndexMetadata` from `src/gmail-batch.ts` rather than the sequential
per-message `messages.get` loop the `search_emails` MCP tool currently does.

Output:

```json
{
  "query": "after:1757203200",
  "count": 42,
  "has_more": false,
  "messages": [
    {
      "id": "1991f2ab34cd56ef",
      "thread_id": "1991f2ab34cd56ef",
      "subject": "Invoice #123",
      "from": "billing@example.com",
      "from_name": "Billing Dept",
      "date": "2026-09-07T14:00:00Z",
      "is_unread": true,
      "labels": ["INBOX", "IMPORTANT"]
    }
  ]
}
```

- `date` is UTC ISO-8601 derived from `internalDate` (epoch ms), not the RFC Date header — it must
  sort and compare reliably for watermarks.
- `from`/`from_name` are split from the From header (use the `email-addresses` dependency already
  in package.json).
- `is_unread` = labels contain `UNREAD`. `has_more` = a further page existed when `--limit` was
  reached.
- Sort ascending by `date`.

### gmail-get-message

```
gmail-get-message <message_id> [options]

  --format, -f <type>    Body format: text (default) or markdown (convert HTML when no text part)
  --no-body              Headers and attachment list only
  --output, -o <file>    Write payload to file
  --auth / --help        As above
```

Implementation: `messages.get` with `format: 'full'`; reuse `extractHeaders`,
`extractEmailContent`, `extractAttachments` from `src/index.ts` (see extraction note below). For
`--format markdown` convert the HTML part when no plain-text part exists (turndown or similar —
match what the Outlook `get-message` does).

Output:

```json
{
  "id": "1991f2ab34cd56ef",
  "thread_id": "1991f2ab34cd56ef",
  "subject": "Invoice #123",
  "from": { "email": "billing@example.com", "name": "Billing Dept" },
  "to": [{ "email": "sasha@example.com", "name": "Sasha" }],
  "cc": [],
  "date": "2026-09-07T14:00:00Z",
  "is_unread": false,
  "labels": ["INBOX"],
  "has_attachments": true,
  "attachments": [
    { "id": "ANGjdJ...", "filename": "invoice.pdf", "mime_type": "application/pdf", "size": 123456 }
  ],
  "body": "Please find attached…",
  "body_content_type": "text"
}
```

### gmail-download-attachment

```
gmail-download-attachment <message_id> <attachment_id> --output <path> [--auth|--help]
```

Implementation: same as the existing `download_attachment` MCP tool (`messages.attachments.get`,
base64url decode). `--output` may be a directory (use the attachment's filename) or a full file
path. Refuse to overwrite an existing file unless `--force` is given. Success stdout:

```json
{ "output": "/tmp/invoice.pdf", "bytes": 123456 }
```

## Extraction note (the main refactor)

`src/index.ts` runs the MCP server at module load and holds `loadCredentials()`, `oauth2Client`,
`extractHeaders`, `extractEmailContent`, `extractAttachments` internally. CLI entry points must not
import `index.ts` (that would start the server). Extract the shared pieces into a module the server
and CLIs both import, e.g.:

- `src/auth.ts` — `loadCredentials()` returning a ready `OAuth2Client`, plus the interactive auth
  flow for `--auth`.
- `src/message-utils.ts` — header/content/attachment extraction (move from `index.ts`, keep
  existing tests passing).
- `src/cli/gmail-search.ts`, `src/cli/gmail-get-message.ts`, `src/cli/gmail-download-attachment.ts`.

Keep the diff against upstream as small as the extraction allows — this repo is a fork and wants to
stay mergeable. Pure moves plus new files; avoid reformatting.

## Errors and exit codes

| Code | Meaning |
|-:|-|
| 0 | Success |
| 1 | Network/unexpected error |
| 2 | Usage or validation error |
| 3 | Missing/invalid credentials (stderr suggests `gmail-search --auth`) |
| 4 | Rate limited (Gmail 429 / quotaExceeded) |
| 5 | Message or attachment not found (404) |

Never print tokens or full request headers to stderr.

## Tests

- Unit-test the From-header split, `internalDate` → ISO conversion, `is_unread`/`has_more`
  derivation, and pagination stop conditions with mocked Gmail responses.
- The existing vitest suite must still pass after the extraction (it covers the moved helpers).
- Smoke test (manual, real account): `gmail-search -q "after:<epoch minus 1 day>"`, pipe one ID to
  `gmail-get-message`, download one attachment, verify JSON shapes.
