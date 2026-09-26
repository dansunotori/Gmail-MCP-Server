# Gmail CLI — Specification

Four command-line tools, each exposing an existing MCP tool with the same semantics and nothing
more, installed as bins of the package. Scripts (and Claude sessions) can then search, read,
download and fetch a window of Gmail without an MCP session. This document is self-contained and
the output contracts below are the requirement.

Revised on 2026-09-25: each CLI now mirrors one MCP tool exactly, including
`batch_fetch_window`, in place of the 2026-09-08 design with its own output shapes.

## Non-negotiables

- JSON on stdout on success; diagnostics and progress on stderr; on failure stdout stays empty and
  the process exits non-zero. Scripts rely on `JSON.parse(stdout)`.
- `--output`/`-o <file>` writes the JSON to the file instead of stdout. A file the command writes
  or relies on (the saved credentials, the OAuth keys, including `gcp-oauth.keys.json` in the
  current directory, the downloaded attachment, or the batch
  output directory, manifest, window metadata and `messages/`) is refused as a usage error before
  anything is fetched or written, however the path is spelt, including through a symlink whose
  target does not exist yet. The path is resolved as the operating system resolves it, left to
  right, so a symlink is followed before a later `..` (`link/../x` is beside the link's target,
  not beside the link); the JSON is written to that resolved file; and on macOS and Windows,
  whose disks are case-insensitive by default, capitalisation is ignored. An existing output file
  is also compared by identity (device and inode) with every existing reserved file, including
  each file under `messages/`, so a hard link to one is refused too.
- `--auth` signs in (the server's OAuth flow) and exits; `--help`/`-h` shows help with one example
  per flag.
- Same semantics as the MCP tool: the CLI calls the same core function the server calls, so the
  Gmail calls, defaults, guards and retry policy cannot drift apart.
- Reuse the existing OAuth machinery: `~/.gmail-mcp/gcp-oauth.keys.json` +
  `~/.gmail-mcp/credentials.json` (or `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH`), including the
  persisted `refresh_token` handling in `loadCredentials()`. A tool the saved scopes do not grant is
  refused with the server's own message.
- Do not change MCP server behaviour. The CLIs are additive.
- Sending mail stays out of scope: no CLI sends, replies, forwards, labels, trashes or modifies a
  message.

## Commands and bin entries

| bin | MCP tool |
|-|-|
| `gmail-search` | `search_emails` |
| `gmail-get-message` | `read_email` |
| `gmail-download-attachment` | `download_attachment` |
| `gmail-batch-fetch-window` | `batch_fetch_window` |

Names are prefixed `gmail-` so that they cannot clash with generic mail CLIs a user may already
have installed globally.

Install with `npm run install-cli`: it builds, then symlinks every `bin` of `package.json` into
`~/.local/bin`, which is on `PATH` whatever Node version is active. It replaces only links that
already point into this checkout and reports any other entry of the same name. Never `npm link` or
`npm install -g`: those install into one Node version's directory and vanish with it.

### gmail-search

```
gmail-search '<gmail query>' [--max-results N] [-o <file>]
```

Exposes `search_emails`: `messages.list` with the query and `maxResults` (default 10), then one
metadata fetch per message. Prints the tool's listing as JSON, with ids exactly as Gmail returns
them:

```json
{
  "query": "from:billing@example.com",
  "count": 1,
  "messages": [
    { "id": "1991f2ab34cd56ef", "subject": "Invoice #123", "from": "Billing <billing@example.com>", "date": "Mon, 07 Sep 2026 14:00:00 +0000" }
  ]
}
```

`subject`, `from` and `date` are the headers as the tool prints them (`date` is the RFC Date
header); a missing header is `""`. A query that starts with `-` goes after `--`.

### gmail-get-message

```
gmail-get-message <message_id> [--format text|markdown] [-o <file>]
```

Exposes `read_email` (`messages.get` with `format: 'full'`). Prints:

```json
{
  "id": "1991f2ab34cd56ef",
  "threadId": "1991f2ab34cd56ef",
  "subject": "Invoice #123",
  "from": "Billing <billing@example.com>",
  "to": "me@example.com",
  "cc": "",
  "date": "Mon, 07 Sep 2026 14:00:00 +0000",
  "labels": ["INBOX", "UNREAD"],
  "body": "Please find attached…",
  "attachments": [
    { "id": "ANGjdJ...", "filename": "invoice.pdf", "mimeType": "application/pdf", "size": 123456 }
  ]
}
```

`body` is the tool's body: the plain-text part, or the HTML when there is none. With
`--format markdown` it is the HTML part converted to Markdown (turndown, with `head`, `style` and
`script` removed), or the plain text when the message has no HTML part.

### gmail-download-attachment

```
gmail-download-attachment <message_id> <attachment_id> --save-path <dir> [--filename <name>] [-o <file>]
```

Exposes `download_attachment`: same Gmail calls, the same default filename (the attachment's own,
else `attachment-<id>`), the same base-name reduction and path-containment check. Saves the file
and prints:

```json
{ "path": "/tmp/attachments/invoice.pdf", "size": 123456, "mimeType": "application/pdf" }
```

A download the server reports as failed is an error (non-zero exit, empty stdout), whether the
server reports it as an error result or as text.

### gmail-batch-fetch-window

```
gmail-batch-fetch-window --watermark <ISO 8601 with zone> --output-dir <absolute dir> [--no-cross-check] [--max-messages N] [-o <file>]
```

Exposes `batch_fetch_window` with the same parameters, defaults (`cross_check` true,
`max_messages` 2000), validation and guards: the `messages/` marker check before anything is
deleted, and a truncated run writing nothing. Prints the tool's result JSON unchanged: `status`,
`listed`, `inWindow`, `belowBoundaryOrExcluded`, `failures` `[{id, error, operation, status,
attempts}]`, `crossCheck` `{status, consistent, unexplainedIds, errors, …}`, `truncated` and the
rest of the tool's result, and leaves `manifest.json`, `window-metadata.json` and `messages/` under
the output directory exactly as the tool writes them. See `README.md` for the full result contract.

## Shared code

`src/index.ts` runs the MCP server at module load, so the CLIs never import it. The server and the
CLIs share:

- `src/auth.ts`: `loadCredentials()` and the interactive `authenticate()` flow, with progress lines
  through an injected logger (stdout for the server, stderr for the CLIs).
- `src/read-tools.ts`: `searchEmails`, `readEmail` and `downloadAttachment`, each returning
  structured data, plus the formatters that render the exact text the server returns.
- `src/batch-fetch-window.ts`: `batchFetchWindow`, unchanged.
- `src/cli/common.ts` (parsing, help, output, exit codes) and `src/cli/commands.ts` (the four
  commands); `src/cli/gmail-*.ts` are the bin entry points.

## Errors and exit codes

| Code | Meaning |
|-:|-|
| 0 | Success |
| 1 | Network/unexpected error |
| 2 | Usage or validation error |
| 3 | Missing/invalid credentials, Gmail auth failure, or a scope the credentials lack (sign in with `--auth`) |
| 4 | Rate limited (Gmail 429, or a 403 with a rate-limit reason) |
| 5 | Message or attachment not found (404) |

Never print tokens or full request headers to stderr.

## Tests

- `src/read-tools.test.ts`: the exact text each MCP tool returns, and the download's filename,
  MIME-type and path-traversal handling.
- `src/cli/commands.test.ts`: every command's output shape, flags, defaults, usage errors, exit
  codes, `--help` (one example per flag), `--auth` and `--output` (including a symlink followed
  by `..`, a hard link, and capitalisation on case-insensitive platforms), with a fake Gmail client;
  `gmail-batch-fetch-window` against a temporary directory, including the guard refusal.
- `scripts/install-cli.test.ts`: links are created, own links replaced, and a foreign link, a
  regular file or a missing build left alone and reported.
- The existing vitest suite passes after the extraction.
