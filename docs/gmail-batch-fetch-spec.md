# `batch_fetch_window` MCP tool: specification

## Why

A client of this server may want a routine "mailbox pass": download every message received since
a stored watermark to disk, so the files can be read one by one, without the client calling the
Gmail API itself. This server provides that capability as a tool.

This document is the complete statement of the required behaviour and output files. Nothing
outside this repository is a requirement, and the tool must serve any client equally.

## Scope

`batch_fetch_window` is defined in `src/tools.ts`. Its core, `batchFetchWindow` in
`src/batch-fetch-window.ts`, is called by both the MCP handler and the `gmail-batch-fetch-window`
CLI. Scopes: `["gmail.readonly", "gmail.modify"]`; `gmail.readonly` suffices.

## Tool contract

Name: `batch_fetch_window`

Annotations: `{ title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false }`.
The tool never modifies the mailbox, but it deletes and recreates `messages/` and overwrites
two files under the caller-supplied directory, and the MCP SDK defines `readOnlyHint` as "does
not modify its environment".

### Input schema (zod)

- `watermark` (string, required): an ISO 8601 UTC timestamp with a `Z` suffix, e.g.
  `2026-09-10T14:03:22Z`. Reject anything `Date.parse` cannot parse; reject values without an
  explicit `Z` or offset so a naive local time can never be interpreted silently.
- `output_dir` (string, required): absolute path of the directory to write into. The tool creates
  it if missing. Inside it the tool owns exactly three things: `messages/` (a directory),
  `manifest.json` and `window-metadata.json`. It must delete and recreate `messages/` on every
  run (numbered files are replaced each fetch) and must not touch anything else in `output_dir`.
  Guard: before deleting anything, the tool checks
  that `messages/` is absent, empty, or holds the `.batch-fetch-window` marker file the tool
  writes into `messages/` immediately after creating it on every run and nothing but regular
  files named `NNN.json` or `.publish-*`. If `messages/` has no marker, holds anything else (a
  foreign name, or a directory or symlink under an owned name), or exists but is not a
  directory, the tool throws `refusing to delete …` naming the offending entry and leaves
  every earlier output in place, so an `output_dir` pointed at the wrong place cannot erase
  data that is not the tool's own. The marker is private to the tool.
- `max_messages` (integer, optional, default 2000): a hard cap on how many window IDs the tool
  will download. If the listing exceeds it, the tool stops, downloads nothing, and returns
  `truncated: true` with the listed count so the caller can rerun with a larger cap. Never
  silently download a subset.
- `cross_check` (boolean, optional, default true): whether to run the spam, trash and
  `in:anywhere` consistency check described below.

### Behaviour

1. Compute `boundaryMs = Date.parse(watermark)` and `epoch = floor(boundaryMs / 1000)`.
2. Window query: `after:${epoch - 1} -in:spam -in:trash`. Gmail's `after:` has one-second
   resolution, so query one second early and filter client-side on
   `internalDate >= boundaryMs`. The boundary is inclusive: a message whose `internalDate` equals
   the watermark exactly is in the window. (A client that advances its own watermark decides
   what to do with an equal-candidate message; the tool's job is only to never drop one.)
3. List with `users.messages.list`, `includeSpamTrash: true`, `maxResults: 500`, following
   `nextPageToken` until exhausted. Deduplicate IDs. Record the page count. A page that still
   fails after its retries (below) fails the whole call: throw an error naming the query, the
   1-based page and the final status (`window listing failed: query "…" page N status S after
   A attempts`), before the guard runs and before anything is deleted or written. A window
   whose listing is incomplete is never written.
4. If listed count exceeds `max_messages`, return the truncation result (see Output) and stop.
5. For every listed ID, `users.messages.get` with `format: "full"`. Skip (do not write) any
   message whose `internalDate < boundaryMs` or whose `labelIds` include `SPAM` or `TRASH`.
   Record per-message fetch failures as `{ id, error, operation, status, attempts }` (see
   Tool result); a failure must not abort the run.

   Retry policy, applied through one helper to every Gmail call the tool
   makes (the profile lookup, every listing page, `messages.get` and `attachments.get`): retry
   on 429, on any 5xx, on a 403 whose reason is a Gmail rate limit, and on network errors
   (connection reset, refused or aborted, timeout, DNS failure, host or network unreachable);
   do not retry any other 4xx. At most 5 attempts per call, exponential backoff with full jitter from a
   500 ms ceiling doubling to a 30 s cap; a `Retry-After` header is honoured up to the same
   cap. A call that succeeds on a later attempt gives exactly the result of a first-attempt
   success. Auth errors are never retried and abort the run.
6. Sort the surviving messages by `internalDate` ascending. Number them from `001` upwards and
   write `messages/NNN.json` for each (zero-padded to three digits; if more than 999 survive,
   widen the padding for the whole run so ordering by filename stays correct).
7. Body extraction: walk the MIME tree; concatenate `text/plain` parts
   into `text` and `text/html` parts into `html`, each decoded from base64url as UTF-8, since
   Gmail delivers a `format: 'full'` text part in UTF-8 whatever charset its `Content-Type`
   names; when a body part is delivered as an
   `attachmentId` with no filename (Gmail does this for large bodies), fetch it with
   `users.messages.attachments.get` and append it; parts with a filename are attachments and
   are listed with `filename`, `mimeType`, `size` and `attachmentId` (or `inlineBase64` when the
   data is inline). `body` is the plain-text part trimmed, or the HTML converted to text when
   there is no plain part or the plain part is a stub (see `bodySource`). The conversion
   (`htmlToText` in `src/message-body.ts`) applies, in this order: CRLF and lone CR line
   endings become LF (again after references are decoded, so `&#13;` adds none); remove style and script
   blocks; a `<br>` that is not immediately followed by a newline becomes a newline; closing
   `p`, `div`, `tr`, `li` and `h1`–`h6` tags become newlines; `<a href="…">text</a>`, with double
   or single quotes, becomes `text [href]`; every other tag becomes a space; character
   references are decoded in one pass, so `&amp;lt;` becomes `&lt;`: decimal (`&#8217;`) and
   hexadecimal (`&#x2019;`) references, the five XML names (`&amp;` `&lt;` `&gt;` `&quot;`
   `&apos;`), HTML's Latin-1 names (`&eacute;`, `&copy;`, …) and common punctuation names
   (`&rsquo;`, `&ndash;`, `&hellip;`, `&euro;`, …), with a no-break space in any spelling becoming
   a plain space, and a reference naming no character (unknown name, no closing `;`, code point
   0, a surrogate or one beyond U+10FFFF) left as written; runs of spaces and tabs collapse to one
   space; each line's leading and trailing spaces are dropped, so a line of only spaces is blank;
   three or more newlines collapse to two; the result is trimmed. A body-part fetch failure is recorded in `failures` with the prefix
   `body-part-fetch:` and the message is still written with whatever was recovered.
8. Cross-check (when enabled): list `after:${epoch - 1} in:spam`, `after:${epoch - 1} in:trash`
   and `after:${epoch - 1} in:anywhere` with the same pagination and retries. `unexplainedIds`
   is every anywhere ID that is in none of window, spam or trash. `complete` is true when all
   three listings ran to their last page (the window listing is always complete by step 3).
   `status` is `"failed"` when any listing did not complete (`errors` then holds one
   `{ query, page, status, attempts }` per failed listing, and the same failure is recorded in
   `failures` with `id: "cross-check:<query>"`), `"inconsistent"` when all completed and
   `unexplainedIds` is non-empty, `"consistent"` otherwise, and `"skipped"` when the check did
   not run (`cross_check: false`, or a truncated window). `consistent` is true only for
   `"consistent"`: a listing that failed cannot explain or reveal anything, and a skipped check
   verified nothing, so a caller that reads only the boolean fails closed. A failed cross-check
   does not stop the window from being written and does not make the call an error.

### Output files

`messages/NNN.json`, one per surviving message, pretty-printed with trailing newline:

```json
{
  "id": "...", "threadId": "...", "internalDate": "1757600000000", "labelIds": ["INBOX", "UNREAD"],
  "from": "...", "to": "...", "cc": "...", "subject": "...", "dateHeader": "...", "messageIdHeader": "<...@...>",
  "snippet": "...", "attachments": [ { "filename": "...", "mimeType": "...", "size": 0, "attachmentId": "..." } ],
  "body": "...", "bodySource": "text", "htmlBody": "<html>...</html>"
}
```

`bodySource` is `text` (the plain-text part), `html` (no plain part; the HTML part converted to text) or `html-over-stub` (the plain part is only a stub pointing at the HTML part, so the HTML part converted to text is the body).

`htmlBody` is the message's `text/html` part as delivered (the `html` of step 7, decoded from base64url as UTF-8, markup included), whatever `body` is, so a message whose plain part is full but stale still delivers its HTML content. It is `null` when the message has no `text/html` part; a `text/html` part with a filename is an attachment, not the HTML part. When the HTML part is an `attachmentId` whose fetch fails, `htmlBody` is `null` and `htmlBodyError` gives the `body-part-fetch:` code of that failure, which is also a `failures` entry; no other message carries `htmlBodyError`. `read_email` and `gmail-get-message` deliver the same `htmlBody` and `htmlBodyError` for the same message.

`messageIdHeader` is the RFC 822 `Message-ID` header exactly as the message holds it, or `null` when it has none. Two message files with different `id` and the same `messageIdHeader` hold one message, for example the sent and received copies of a self-addressed message. The manifest entry carries the same field.

A message with a `text/calendar` part also carries `"calendarMethod": "REQUEST"` (the part's `METHOD`) and, for a `REPLY`, `"calendarReply": { "attendee": "<address>", "partstat": "ACCEPTED" }`, read from the part itself, inline or fetched as an attachment. A message without such a part carries neither field. A calendar part that cannot be fetched or parsed is a `failures` entry with `operation` `"calendar-part"`.

`manifest.json`:

```json
{
  "checkedAt": "<ISO UTC now>", "emailAddress": "<profile address>", "watermark": "<input>",
  "boundaryMs": 0, "query": "after:... -in:spam -in:trash", "pages": 1,
  "listed": 0, "inWindow": 0, "belowBoundaryOrExcluded": 0, "truncated": false, "listingComplete": true, "maxMessages": 2000,
  "failures": [ { "id": "...", "error": "503", "operation": "messages.get", "status": 503, "attempts": 5 } ],
  "crossCheck": {
    "status": "consistent", "consistent": true, "complete": true, "unexplainedIds": [], "errors": [],
    "counts": { "window": 0, "spam": 0, "trash": 0, "anywhere": 0 },
    "window": 0, "spam": 0, "trash": 0, "anywhere": 0
  },
  "messages": [ { "file": "<output_dir>/messages/001.json", "id": "...", "internalDate": "...", "labelIds": [], "from": "...", "subject": "...", "dateHeader": "...", "messageIdHeader": "<...@...>", "attachments": 0 } ]
}
```

`failures[]`: `id` is the listed message ID or `cross-check:<query>`; `error` is the failure
string (HTTP status, network code or error name, prefixed `body-part-fetch: ` for a body
part and `calendar-part-fetch: ` for a calendar part, or `calendar-part: <reason>` for a
calendar part that could not be parsed); `operation` is `"messages.get"`, `"body-part-fetch"`,
`"calendar-part"` or `"cross-check"`; `status` is the numeric HTTP status, the network code /
error name as a string, or `"unparseable"`; `attempts` is the number of calls made (1 when not
retryable, otherwise up to 5).

`crossCheck` is always present. When the check ran it has the shape above with `status`
`"consistent"`, `"inconsistent"` or `"failed"`, `errors[]` entries of
`{ query, page?, status, attempts }`, and the four counts both under `counts` and flat. When it
did not run it is exactly
`{ "status": "skipped", "consistent": false, "complete": false, "unexplainedIds": [], "errors": [] }`.

`messages/` also holds the `.batch-fetch-window` marker file (see the guard); it is not a
message file and is not listed in the manifest.

`window-metadata.json` (what a client reads to decide whether to advance its own watermark; keep it minimal):

```json
{
  "checkedAt": "...", "emailAddress": "...", "watermark": "...", "boundaryMs": 0,
  "messages": [ { "id": "...", "internalDate": "...", "labelIds": [], "headers": [ { "name": "From", "value": "..." } ] } ]
}
```

`headers` carries only `From`, `To`, `Subject` and `Date`.

`file` paths in the manifest must be absolute (built from `output_dir`), not relative to the
server's cwd: the MCP server makes no guarantee about its working directory, and a client must
be able to open a file straight from the manifest.

### Tool result

Return a structured result (use `structuredResult` from `src/gmail-sync.ts` if it fits) containing
the manifest summary without the `messages` array, plus a `triage` array of one-line strings
`"<file> | <from> | <subject> | <dateHeader> | <n> att"` in file order, and a `status` field:

- `"ok"`: no failures, cross-check consistent (or skipped), not truncated.
- `"incomplete"`: any failure recorded, or `crossCheck.status` is `"inconsistent"` or
  `"failed"`. Files are still written.
- `"truncated"`: listing exceeded `max_messages`; no files written; `messages/` left untouched.

The status must be explicit so the caller can refuse to advance a watermark on anything but
`"ok"`. Do not throw for `"incomplete"` or `"truncated"`; throw only for input validation
failures, auth failures, a guard refusal, and a profile lookup or window listing page that
still fails after its retries (the server reports each as an MCP error with `isError: true`).
Every Gmail call (profile lookup, listing pages, `messages.get`, `attachments.get`, cross-check
listings) completes before anything under `output_dir` is deleted or written, so every throw
above leaves the previous outputs untouched. Only a local file-system error can interrupt the
run after the deletion; `messages/` then holds the marker and the new message files, with no
manifest or window metadata, and a rerun replaces that state.

## Testing

`src/batch-fetch-window.test.ts` (vitest, Gmail client mocked as in `gmail-batch.test.ts`) must
cover at least:

- multi-page listing (three pages, duplicate ID across pages deduplicated);
- empty window (zero listed, files written with empty arrays, status `ok`);
- boundary: a message with `internalDate` exactly equal to `boundaryMs` is included, one
  millisecond earlier is excluded and counted in `belowBoundaryOrExcluded`;
- a message labelled `SPAM` returned by the window query is excluded;
- one `messages.get` failure mid-run: the others are written, the failure is recorded, status
  `incomplete`;
- a large body delivered via `attachmentId` is fetched and included in `body`;
- HTML-only message produces plain text `body` per the conversion rules;
- cross-check with one unexplained ID gives `status: "inconsistent"`, `consistent: false` and
  status `incomplete`; a cross-check listing that fails after retries gives `status: "failed"`,
  `consistent: false`, an `errors` entry naming the query, and the window is still written;
  `cross_check: false` gives `status: "skipped"`, `consistent: false` and no spam, trash or
  anywhere listing calls;
- a `messages.get` that returns 429 twice then 200 is written with no failure; one that fails
  on every attempt is recorded with `status` and `attempts: 5` while the rest is written; a
  404 is not retried and is recorded with `attempts: 1`; a `Retry-After: 2` on a 429 delays the
  retry by 2 s;
- a window page that fails on every attempt rejects with an error naming the page and leaves
  every file under `output_dir` byte-for-byte unchanged;
- the guard refuses a `messages/` holding a foreign file, writing and deleting nothing, and
  accepts one holding only a previous run's files;
- `max_messages` exceeded gives status `truncated`, writes nothing, and leaves an existing
  `messages/` directory intact;
- input validation rejects a watermark without zone suffix;
- rerun replaces `messages/` completely (a stale `009.json` from a previous run disappears).
