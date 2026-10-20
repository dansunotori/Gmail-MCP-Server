# Gmail CLI — Specification

Seventeen command-line tools, each exposing an existing MCP tool with the same semantics and
nothing more, installed as bins of the package. Scripts (and Claude sessions) can then search,
read messages and threads, list threads, labels and filters, page through message IDs and the
history of added messages, download attachments and messages, read attachment text, fetch a
window of Gmail and save a draft without an MCP session.
This document is self-contained and the output contracts below are the requirement.

## Non-negotiables

- JSON on stdout on success; diagnostics and progress on stderr; on failure stdout stays empty and
  the process exits non-zero. Scripts rely on `JSON.parse(stdout)`.
- `--output`/`-o <file>` writes the JSON to the file instead of stdout. A file the command writes
  or relies on (the saved credentials, the OAuth keys, including `gcp-oauth.keys.json` in the
  current directory, the downloaded attachment or email, or the batch
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
- Do not change MCP server behaviour.
- Sending mail stays out of scope: no CLI sends, replies, forwards, labels, trashes or modifies a
  message, and none creates, changes or deletes a label or filter. `gmail-create-draft` saves a
  draft and never sends it.

## Commands and bin entries

| bin | MCP tool |
|-|-|
| `gmail-search` | `search_emails` |
| `gmail-get-message` | `read_email` |
| `gmail-download-attachment` | `download_attachment` |
| `gmail-get-attachment-text` | `get_attachment_text` |
| `gmail-batch-fetch-window` | `batch_fetch_window` |
| `gmail-create-draft` | `draft_email` |
| `gmail-get-thread` | `get_thread` |
| `gmail-get-inbox-with-threads` | `get_inbox_with_threads` |
| `gmail-download-email` | `download_email` |
| `gmail-list-inbox-threads` | `list_inbox_threads` |
| `gmail-get-profile` | `get_gmail_profile` |
| `gmail-list-message-ids` | `list_gmail_message_ids` |
| `gmail-list-added-history` | `list_gmail_added_history` |
| `gmail-batch-get-index-metadata` | `batch_get_gmail_index_metadata` |
| `gmail-list-labels` | `list_email_labels` |
| `gmail-list-filters` | `list_filters` |
| `gmail-get-filter` | `get_filter` |

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
  "messageIdHeader": "<CAB123@mail.example.com>",
  "labels": ["INBOX", "UNREAD"],
  "body": "Please find attached…",
  "bodySource": "text",
  "htmlBody": "<p>Please find attached…</p>",
  "attachments": [
    { "id": "ANGjdJ...", "filename": "invoice.pdf", "mimeType": "application/pdf", "size": 123456 }
  ]
}
```

`body` is the tool's body: the plain-text part; the HTML part as it is, markup included, when
there is no plain part (`bodySource` `html`); or the HTML part converted to text when the plain
part is only a stub (`bodySource` `html-over-stub`), each part fetched when Gmail defers it, as
`gmail-batch-fetch-window` fetches it; when the plain part's fetch fails, the body is chosen
without it and `plainBodyError` gives the reason, which no other message carries. `htmlBody` is
the `text/html` part as
delivered, markup included, whatever `body` is, fetched when Gmail defers it, and `null` when the
message has no HTML part; when that fetch fails, `htmlBody` is `null` and `htmlBodyError` gives the
reason. It is the `htmlBody` that `gmail-batch-fetch-window` writes for the same message, and it
does not change with `--format`. `messageIdHeader` is the RFC 822 `Message-ID` header, or `null`. A message with a
`text/calendar` part also carries `calendarMethod` and, for a reply, `calendarReply` `{attendee,
partstat}`, read as `batch_fetch_window` reads them, and `calendarFailures` when the part cannot be
read; other mail carries none of them. With
`--format markdown` the body is the HTML part converted to Markdown (turndown, with `head`, `style`
and `script` removed), or the plain text when the message has no HTML part.

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

### gmail-get-attachment-text

```
gmail-get-attachment-text <message_id> <attachment_id> [-o <file>]
```

Exposes `get_attachment_text`. Prints `{name, format, text, truncated, sheets}`; an attachment
that is protected, encrypted, corrupt or unsupported exits 6. `README.md` gives the formats and
the spreadsheet layout.

### gmail-create-draft

```
gmail-create-draft --to <addresses> --subject <text> (--body <text> | --body-file <file>) [options] [-o <file>]
```

Exposes `draft_email` through the same compose code, with one option per tool input, and prints
the draft read back from Gmail. It never sends. `gmail-create-draft --help` lists every option.

### gmail-get-thread

```
gmail-get-thread <thread_id> [--format full|metadata|minimal] [-o <file>]
```

Exposes `get_thread` (`threads.get`, format `full` by default) and prints its result:
`{threadId, messageCount, messages}`, each message with `body` and `bodySource` read and chosen
as `gmail-get-message` reads and chooses them, a part Gmail defers fetched, with its
`plainBodyError` when the plain part cannot be fetched, and no body for `minimal`. A message read in `full` also carries `gmail-get-message`'s `htmlBody`: the
`text/html` part as delivered, `null` when the message has no HTML part, and `null` with
`htmlBodyError` giving the reason when the part cannot be fetched; `metadata` and `minimal` carry
no `htmlBody`. A message read in `full` with a `text/calendar` part also carries
`gmail-get-message`'s `calendarMethod`, `calendarReply` and `calendarFailures`, from the same
reader.

### gmail-get-inbox-with-threads

```
gmail-get-inbox-with-threads [--query '<gmail query>'] [--max-results N] [--no-expand-threads] [-o <file>]
```

Exposes `get_inbox_with_threads` with its defaults (`in:inbox`, 50 threads, expanded) and prints
`{resultCount, threads}`, each expanded message with the `htmlBody`, `htmlBodyError`,
`plainBodyError`, `calendarMethod`, `calendarReply` and `calendarFailures` that `gmail-get-thread`
gives it in `full`; `--no-expand-threads` gives each thread as a summary of its latest message
instead of its messages.

### gmail-download-email

```
gmail-download-email <message_id> --save-path <dir> [--format json|eml|txt|html] [-o <file>]
```

Exposes `download_email`: saves `<dir>/<message_id>.<format>` (json by default) and prints the
tool's result, `{status, path, size, messageId, subject, from, date, attachments}`. The json,
txt and html files read the parts as `gmail-get-message` does, a part Gmail defers fetched. The
json file carries `gmail-get-message`'s `htmlBody` and, when the HTML part cannot be fetched,
`htmlBodyError`, `plainBodyError` when the plain part cannot be fetched, and the
`calendarMethod`, `calendarReply` and `calendarFailures` `gmail-get-message` prints, for a message
with a `text/calendar` part. The txt format is an error when the plain part cannot be fetched, or
when the plain part is missing or only a stub and the HTML part it would be made from cannot be
fetched, and the html format when the message has no HTML part or
that part cannot be fetched, each carrying Gmail's status for the exit code. An `--output` naming the file it saves is refused before any Gmail call.

### gmail-list-inbox-threads

```
gmail-list-inbox-threads [--query '<gmail query>'] [--max-results N] [-o <file>]
```

Exposes `list_inbox_threads` with its defaults (`in:inbox`, 50 threads) and prints
`{resultCount, threads}`, each thread `{threadId, snippet, historyId, messageCount,
latestMessage: {from, subject, date}}`. The server and the command share `listInboxThreads`, which
is `getInboxWithThreads` without expanding the threads.

### gmail-get-profile

```
gmail-get-profile [-o <file>]
```

Exposes `get_gmail_profile` and prints `{historyId}`, the mailbox's current history ID.

### gmail-list-message-ids

```
gmail-list-message-ids [--page-token <token>] [--max-results N] [-o <file>]
```

Exposes `list_gmail_message_ids`: one page of message IDs, spam and trash excluded, 500 by default
and at most 500, printed as `{messageIds, nextPageToken}`; `nextPageToken` is absent on the last
page.

### gmail-list-added-history

```
gmail-list-added-history <start_history_id> [--page-token <token>] [--max-results N] [-o <file>]
```

Exposes `list_gmail_added_history` and prints `{status: "ok", messageIds, nextPageToken,
historyId}`, or `{status: "cursor_expired", startHistoryId}` when Gmail no longer keeps history
from that ID (it answers 404), which is a result, not an error.

### gmail-batch-get-index-metadata

```
gmail-batch-get-index-metadata <message_id>... [-o <file>]
```

Exposes `batch_get_gmail_index_metadata` for 1 to 50 message IDs, sent as one Gmail batch request
through the signed-in OAuth client, and prints `{messages: [{id, internalDate, labelIds}],
missingMessageIds}` in the order given. No ID, or more than 50, is a usage error before any
request.

### gmail-list-labels

```
gmail-list-labels [-o <file>]
```

Exposes `list_email_labels` and prints `{count: {total, system, user}, system, user}`, each label
as Gmail returns it.

### gmail-list-filters

```
gmail-list-filters [-o <file>]
```

Exposes `list_filters` and prints `{count, filters: [{id, criteria, action}]}`.

### gmail-get-filter

```
gmail-get-filter <filter_id> [-o <file>]
```

Exposes `get_filter` and prints `{id, criteria, action}`; an unknown ID exits 5 with
`Failed to get filter: Filter with ID "<id>" not found. (…)`.

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
the output directory exactly as the tool writes them. Each message file carries `htmlBody`,
`htmlBodyError` when the HTML part cannot be fetched, `plainBodyError` when the plain part cannot
be fetched or decoded, and `calendarMethod` and `calendarReply` for
a message with a `text/calendar` part. See `README.md` for the full result contract.

## Shared code

`src/index.ts` runs the MCP server at module load, so the CLIs never import it. The server and the
CLIs share:

- `src/auth.ts`: `loadCredentials()` and the interactive `authenticate()` flow, with progress lines
  through an injected logger (stdout for the server, stderr for the CLIs).
- `src/read-tools.ts`: `searchEmails`, `readEmail`, `downloadAttachment`, `getThread`,
  `getInboxWithThreads`, `listInboxThreads` and `downloadEmail`, each returning
  structured data, plus the formatters that render the exact text the server returns.
- `src/gmail-sync.ts`: `getGmailProfile`, `listGmailMessageIds` and `listGmailAddedHistory`;
  `src/gmail-batch.ts`: `batchGetGmailIndexMetadata`.
- `src/label-manager.ts`: `listLabels`; `src/filter-manager.ts`: `listFilters` and `getFilter`.
- `src/batch-fetch-window.ts`: `batchFetchWindow`.
- `src/attachment-text/`: `getAttachmentText` and the extraction worker.
- `src/compose.ts`: the draft and send logic `draft_email` uses.
- `src/cli/common.ts` (parsing, help, output, exit codes) and `src/cli/commands.ts` (the seventeen
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
| 6 | `gmail-get-attachment-text` only: the attachment is protected, encrypted, corrupt or unsupported |

Never print tokens or full request headers to stderr.

## Tests

- `src/read-tools.test.ts`: the exact text each MCP tool returns, and the download's filename,
  MIME-type and path-traversal handling.
- `src/cli/commands.test.ts`: every command's output shape, flags, defaults, usage errors, exit
  codes, `--help` (one example per flag), `--auth` and `--output` (including a symlink followed
  by `..`, a hard link, and capitalisation on case-insensitive platforms), with a fake Gmail client;
  `gmail-batch-fetch-window` against a temporary directory, including the guard refusal.
- `src/cli/tool-cli-parity.test.ts`: every input of a command's MCP tool has a flag or positional
  (the field in kebab case, `--<field>-file`, the singular for a list, `--no-<field>` for a
  boolean, or one the command's spec maps in `fields`), unless the spec lists it in `inputOnly`
  with a reason; and every example in every command's `--help` parses with the command's own
  parser.
- `src/cli/command-list-parity.test.ts`: `COMMANDS`, `package.json`'s `bin`, the
  `src/cli/gmail-*.ts` entry files, the README's command table and this document's bin table
  name the same commands with the same MCP tools, and both texts count them as `COMMANDS` does.
- `scripts/install-cli.test.ts`: links are created, own links replaced, and a foreign link, a
  regular file or a missing build left alone and reported.
- The full vitest suite must pass.
- Live: `npm run window:compare -- <output-dir> [--limit N]` (`scripts/window-compare.mjs`) runs
  `gmail-get-message` for each message file a `gmail-batch-fetch-window` run wrote under
  `<output-dir>` (or the first N), and prints one JSON report: counts per `bodySource`, of messages
  with and without `htmlBody` and with `htmlBodyError`, every message whose `bodySource`,
  `htmlBody`, `htmlBodyError`, `plainBodyError`, `messageIdHeader`, `calendarMethod`, `calendarReply` or `body`
  differs (`body` with surrounding whitespace ignored, and not for an HTML-only message, which the
  two tools deliver differently), and every read that failed. It exits 0 when every compared
  message agrees, 1 when one differs, and 2 on a usage error or a failed read.
  `scripts/window-compare.test.ts` tests it against fixture windows.
- Live: `npm run live:charset-check` (`scripts/live-charset-check.mjs`) builds, then checks that
  `read_email` decodes a body part by the charset it names however Gmail serves it. It inserts
  one unsent, unlabelled message per case (a 4 MiB windows-1251 message, whose parts Gmail serves
  through `attachments.get` in their own bytes, and a 2 KiB KOI8-R one, whose parts arrive inline
  already in UTF-8; `gmail.modify` scope), records how each part was served, reads the message
  with `readEmail`, and moves it to Bin whatever happens. It prints counts only (length,
  replacement characters, whether each of `body` and `htmlBody` equals what was sent, and any
  `plainBodyError` or `htmlBodyError`), never message text, and exits 0 when every part reads back
  as sent and was served as its case expects, 1 when one did not (a `body-part-charset:` error
  included), and 2 when a Gmail call failed, a part Gmail did not serve (`body-part-fetch:`)
  included.
  `scripts/live-charset-check.test.ts` tests it against a stubbed Gmail with the real reader.
