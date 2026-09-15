# Task: add a `batch_fetch_window` MCP tool to this Gmail MCP server

## Why

Clients of this server need a routine "mailbox pass": download every message received since a
stored watermark to disk, so a model can read the files one by one, without the client calling
the Gmail API itself. Your job is to make this server provide that capability as a tool.

This document, together with the design document it produced
(`docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md`), is the complete statement of
the required behaviour and output files. Nothing outside this repository is a requirement, and
the tool must serve any client equally.

## Scope

One new read-only tool, `batch_fetch_window`, registered in `src/tools.ts` alongside the existing
tools, with its schema, handler, tests and README entry. Nothing else. Do not add CLIs, do not
touch unrelated tools, do not change auth or scopes beyond what the tool needs
(`gmail.readonly` suffices; list it as `["gmail.readonly", "gmail.modify"]` to match the pattern
used by `download_email`).

Before writing code, read `AGENTS.md` and `CLAUDE.md` in this repository and follow their rules.
Reuse existing modules where they fit: `getGmailProfile` and `listGmailMessageIds` in
`src/gmail-sync.ts`, the body and attachment extraction in `src/email-export.ts`
(`gmailMessageToJson`), and the batching helpers in `src/gmail-batch.ts`. If an existing helper
almost fits, extend it rather than duplicating it. If reuse would change an existing tool's
behaviour, do not do it; add a new function instead.

## Tool contract

Name: `batch_fetch_window`

Annotations: `{ title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false }`.
The tool never modifies the mailbox, but it deletes and recreates `messages/` and overwrites
two files under the caller-supplied directory, and the MCP SDK defines `readOnlyHint` as "does
not modify its environment". (Amended 2026-09-11 during design review; the original text asked
for `readOnlyHint: true`.)

### Input schema (zod)

- `watermark` (string, required): an ISO 8601 UTC timestamp with a `Z` suffix, e.g.
  `2026-09-10T14:03:22Z`. Reject anything `Date.parse` cannot parse; reject values without an
  explicit `Z` or offset so a naive local time can never be interpreted silently.
- `output_dir` (string, required): absolute path of the directory to write into. The tool creates
  it if missing. Inside it the tool owns exactly three things: `messages/` (a directory),
  `manifest.json` and `window-metadata.json`. It must delete and recreate `messages/` on every
  run (numbered files are replaced each fetch) and must not touch anything else in `output_dir`.
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
   `nextPageToken` until exhausted. Deduplicate IDs. Record the page count.
4. If listed count exceeds `max_messages`, return the truncation result (see Output) and stop.
5. For every listed ID, `users.messages.get` with `format: "full"`. Skip (do not write) any
   message whose `internalDate < boundaryMs` or whose `labelIds` include `SPAM` or `TRASH`.
   Record per-message fetch failures as `{ id, error }` where `error` is the HTTP status or
   error name; a failure must not abort the run.
6. Sort the surviving messages by `internalDate` ascending. Number them from `001` upwards and
   write `messages/NNN.json` for each (zero-padded to three digits; if more than 999 survive,
   widen the padding for the whole run so ordering by filename stays correct).
7. Body extraction: walk the MIME tree; concatenate `text/plain` parts
   into `text` and `text/html` parts into `html`; when a body part is delivered as an
   `attachmentId` with no filename (Gmail does this for large bodies), fetch it with
   `users.messages.attachments.get` and append it; parts with a filename are attachments and
   are listed with `filename`, `mimeType`, `size` and `attachmentId` (or `inlineBase64` when the
   data is inline). `body` is `text.trim()` if non-empty, otherwise the HTML converted to plain
   text with the `htmlToText` rules the design document specifies (strip style and script,
   `<br>` and block closers become newlines, anchors become `text [href]`, entities decoded,
   whitespace collapsed). A body-part fetch failure is recorded in `failures` with the prefix
   `body-part-fetch:` and the message is still written with whatever was recovered.
8. Cross-check (when enabled): list `after:${epoch - 1} in:spam`, `after:${epoch - 1} in:trash`
   and `after:${epoch - 1} in:anywhere` with the same pagination. `unexplainedIds` is every
   anywhere ID that is in none of window, spam or trash. `consistent` is true when that list is
   empty.

### Output files

`messages/NNN.json`, one per surviving message, pretty-printed with trailing newline:

```json
{
  "id": "...", "threadId": "...", "internalDate": "1757600000000", "labelIds": ["INBOX", "UNREAD"],
  "from": "...", "to": "...", "cc": "...", "subject": "...", "dateHeader": "...",
  "snippet": "...", "attachments": [ { "filename": "...", "mimeType": "...", "size": 0, "attachmentId": "..." } ],
  "body": "..."
}
```

`manifest.json`:

```json
{
  "checkedAt": "<ISO UTC now>", "emailAddress": "<profile address>", "watermark": "<input>",
  "boundaryMs": 0, "query": "after:... -in:spam -in:trash", "pages": 1,
  "listed": 0, "inWindow": 0, "belowBoundaryOrExcluded": 0, "truncated": false, "maxMessages": 2000,
  "failures": [ { "id": "...", "error": "..." } ],
  "crossCheck": { "window": 0, "spam": 0, "trash": 0, "anywhere": 0, "unexplainedIds": [], "consistent": true },
  "messages": [ { "file": "<output_dir>/messages/001.json", "id": "...", "internalDate": "...", "labelIds": [], "from": "...", "subject": "...", "dateHeader": "...", "attachments": 0 } ]
}
```

`window-metadata.json` (the watermark-advancement source; keep it minimal):

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

- `"ok"`: no failures, cross-check consistent (or disabled), not truncated.
- `"incomplete"`: any failure recorded, or cross-check inconsistent. Files are still written.
- `"truncated"`: listing exceeded `max_messages`; no files written; `messages/` left untouched.

The status must be explicit so the caller can refuse to advance a watermark on anything but
`"ok"`. Do not throw for `"incomplete"` or `"truncated"`; throw only for input validation
failures, auth failures and errors before any listing succeeded.

## Testing

Add `src/batch-fetch-window.test.ts` under vitest, mocking the Gmail client the way the existing
`gmail-batch.test.ts` and `download-email.test.ts` do. Cover at least:

- multi-page listing (three pages, duplicate ID across pages deduplicated);
- empty window (zero listed, files written with empty arrays, status `ok`);
- boundary: a message with `internalDate` exactly equal to `boundaryMs` is included, one
  millisecond earlier is excluded and counted in `belowBoundaryOrExcluded`;
- a message labelled `SPAM` returned by the window query is excluded;
- one `messages.get` failure mid-run: the others are written, the failure is recorded, status
  `incomplete`;
- a large body delivered via `attachmentId` is fetched and included in `body`;
- HTML-only message produces plain text `body` per the conversion rules;
- cross-check with one unexplained ID gives `consistent: false` and status `incomplete`;
- `max_messages` exceeded gives status `truncated`, writes nothing, and leaves an existing
  `messages/` directory intact;
- input validation rejects a watermark without zone suffix;
- rerun replaces `messages/` completely (a stale `009.json` from a previous run disappears).

Run the full existing suite too and make sure nothing regresses. Report the exact test command
and its output.

## Documentation

- Add the tool to the README tool list with a short description and the input fields.
- Add a line to `docs/gmail-cli-spec.md` noting that the routine pass now uses
  `batch_fetch_window` and the CLIs there remain optional for targeted reads.

## Definition of done

- `batch_fetch_window` is registered, typed, tested and documented.
- `npm run build` succeeds and `dist/` is rebuilt so the registered server in `~/.claude.json`
  (which points at this install) picks it up.
- A manual smoke run against the real mailbox with `output_dir` set to a scratch directory and a
  recent watermark produces the three outputs and a `status` of `ok` or `incomplete` with the
  reason visible. Paste the returned summary (redact addresses if you like) in your report.
- Report every behaviour guarantee the design document lists and name the test that pins it, so
  a client can rely on the documented behaviour rather than on reading the code.

Commit policy (amended 2026-09-11 by Sasha's instruction to follow the brainstorming,
writing-plans and subagent-driven-development skills in full): each implementation task ends
in its own commit on its feature branch, which is integrated into `experimental` at finish,
and review happens through git history rather than an uncommitted working tree. The original
text here said "Do not commit. Leave the working tree for review."
