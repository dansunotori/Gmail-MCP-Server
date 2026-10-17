# Roadmap

Work to implement, in order. Items 1 to 6 come from the prompts in `figaro-pa-predecessor/docs/prompts/gmail-*.md`; each item keeps its prompt's contract and done-when criteria. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional.

## 1. Errors that say why

Source: `gmail-error-detail.md`

A failed call prints `error: <message>` and exits with a mapped code, but the message does not reliably carry the upstream status, Gmail's error reason or the parameter Gmail rejected. Make every error result carry them, on every MCP tool and every CLI (`gmail-search`, `gmail-get-message`, `gmail-download-attachment`, `gmail-batch-fetch-window` and any CLI added later).

Contract:

- The one stderr line (and the tool's error text) takes the form `Failed to <action>: <message> (code <reason>, HTTP <status>; rejected parameter: <name>, ...)`, each part present when Gmail supplies it and left out when it does not.
- Exit codes and their mapping stay as they are; stdout stays empty on failure.
- No token, credential or request header ever appears in the text.

Done when:

- Live, a search with an invalid query, a get of a message id that does not exist and a download with a malformed attachment id each print the form above with the status and reason Gmail returned.
- The README's error section documents the form.

## 2. Message-ID header in the window fetch

Source: `gmail-message-id-header.md`

The message files and manifest written by `batch_fetch_window` carry Gmail's `id` and `threadId` but not the RFC 822 `Message-ID` header, so a caller cannot tell when two Gmail ids hold one message (a self-addressed message kept as a sent copy and a received copy). Add the header to `batch_fetch_window` and `gmail-batch-fetch-window`, and to `read_email` and `gmail-get-message`.

Contract:

- Each message file, and each manifest entry, carries `messageIdHeader`: the `Message-ID` header value as the message holds it, or `null` when the message has none.
- `gmail-get-message` and `read_email` return the same field.
- Nothing else in the output changes.

Done when:

- Live, a self-addressed message fetched in one window appears as two entries with different `id` values and the same `messageIdHeader`.
- A message with no `Message-ID` header carries `null`.

## 3. Body from the HTML part when the plain part is a stub

Source: `gmail-html-stub-body.md`

Some senders put only a stub in the text/plain part ("sent to you as HTML-only", "view it in your browser", "plain text version not available") and the real content in the text/html part. The delivered body is then the stub. Change the body selection in `batch_fetch_window` and `read_email`, and in `gmail-batch-fetch-window` and `gmail-get-message`.

Contract:

- When the text/plain part is a stub (short, and matching stub wording the server keeps in one list) and the text/html part is non-empty, the delivered `body` is the text conversion of the HTML part, by the same conversion rules an HTML-only message already gets.
- The message records which part the body came from: `bodySource`: `"text"`, `"html"` (HTML-only message) or `"html-over-stub"`.
- Whether such messages occur in a real mailbox is answered from the server's own fetch over a recent window, and reported with a count.

Done when:

- Live, a message whose plain part is a stub and whose HTML part holds content is delivered with the converted HTML as `body` and `bodySource: "html-over-stub"`, through both tools and both CLIs.
- A message with a real plain part is delivered unchanged with `bodySource: "text"`.

## 4. Calendar reply fields in the window fetch

Source: `gmail-calendar-reply-fields.md`

A message carrying a `text/calendar` part (an invitation, a cancellation, an acceptance or decline) is written by `batch_fetch_window` like any other message, so a caller cannot tell a meeting response from ordinary mail without reading the body. Add the calendar part's method and reply fields to the message file written by `batch_fetch_window` and `gmail-batch-fetch-window`.

Contract:

- For a message with a `text/calendar` part, its message file carries `calendarMethod` (the part's `METHOD`, for example `REQUEST`, `CANCEL`, `REPLY`) and, for a `REPLY`, `calendarReply`: `{"attendee": "<address>", "partstat": "<PARTSTAT>"}`, both read from the part itself.
- A message without such a part carries neither field.
- A calendar part that cannot be parsed is recorded in `failures` like any other part failure, never silently dropped.

Done when:

- Live, an invitation, a cancellation, an acceptance and a decline in one window each carry the right `calendarMethod`, the two replies with the replying attendee and `ACCEPTED` or `DECLINED`.
- An ordinary message in the same window carries neither field.

## 5. A CLI for creating a draft

Source: `gmail-create-draft-cli.md`

`draft_email` creates a draft through the MCP tool only, so a script cannot create a draft and read its own result back. Add the CLI `gmail-create-draft` over the same logic as `draft_email`: every option the tool takes is a CLI option, and the tool and the CLI stay in step from now on.

Contract:

- One option per `draft_email` input: `--to`, `--cc`, `--bcc` (comma-separated addresses), `--subject`, `--body` or `--body-file <path>`, `--html-body` or `--html-body-file <path>`, `--mime-type text/plain|text/html|multipart/alternative`, `--attachment <path>` (repeatable), `--inline-image cid=<cid>,path=<path>` (repeatable, needs an HTML body), `--from <send-as address>`, `--thread-id`, `--in-reply-to`, plus `--input <file>` taking the tool's JSON request (options override its fields) and `--output <file>`. A body is read from a file as UTF-8, so no body ever passes through a shell argument.
- Output, one JSON document on stdout: `{"draft_id", "message_id", "thread_id", "to", "cc", "bcc", "subject", "attachments": [{"name", "size"}]}`, read back from the saved draft, not echoed from the input.
- Failure: non-zero exit with empty stdout and one stderr line; an unknown option, a missing required one or an attachment path that cannot be read exits 2 before anything is sent to Gmail. The CLI never sends.

Done when:

- Live, a draft with a body file and one attachment is created, its read-back fields match the input, and it appears in Gmail's Drafts.
- `gmail-create-draft --help` documents every option, the output and the exit codes.

## 6. Attachment text extraction

Source: `gmail-attachment-text.md` (related: issue #48)

The server can download an attachment (`download_attachment`, `gmail-download-attachment`) but cannot return its text, so a caller must convert every format itself and cannot read a Word file or a spreadsheet at all. Add the MCP tool `get_attachment_text` and the CLI `gmail-get-attachment-text`.

Contract:

- Input: a message id and an attachment id (CLI: `gmail-get-attachment-text <message_id> <attachment_id>`).
- Formats: PDF, DOCX, XLSX, XLSM, XLS, CSV, and text parts (TXT, MD, any `text/*`) returned verbatim, UTF-8 or Windows-1252 decoded.
- Output, one JSON document on stdout: `{"name", "format", "text", "truncated": <bool>, "sheets": [{"name", "rows", "columns"}] | null}`. A spreadsheet's text is one `## Sheet: <name>` heading per sheet followed by tab-separated rows (display values, cached formula results, merged cells once at top-left, leading and trailing empty rows and columns trimmed); `sheets` gives each sheet's populated span. A size ceiling, when reached, cuts on a row or line boundary and sets `truncated: true`.
- Failure: a protected, encrypted, corrupt or unsupported file exits non-zero with empty stdout and one stderr line naming that cause in those words, so a caller can tell a file fault from a sign-in, network or service fault, which exits with its own code.

Done when:

- Live, a PDF, a DOCX and a two-sheet XLSX attachment each return their text, the XLSX with both sheets and their spans.
- Live, a password-protected PDF exits non-zero naming it protected.
- `gmail-get-attachment-text --help` documents the formats, the output and the exit codes.

## 7. Script to import Gmail prompts into this roadmap

Picking this server's prompts out of `figaro-pa-predecessor/docs/prompts` and copying them here was done by hand: the files were selected by their `gmail-` prefix and each one was transcribed into a section. Add `scripts/import-prompts.mjs`, which takes the prompts directory, selects `gmail-*.md`, skips any prompt whose `Source:` line already appears in `ROADMAP.md`, and appends each new prompt as a numbered section with its `Source:` line. That makes the import repeatable and avoids transcription errors.

Done when:

- Running it twice against the same prompts directory adds nothing the second time.
- A new `gmail-*.md` prompt is appended verbatim under the next number, and prompts for other servers are ignored.

## 8. Retire the staging branch (done)

This is not a public repository, so the two-branch model (`main` stable plus a staging branch for contributor PRs) added a promotion step with no audience. Work lands on `main` directly.

Done when:

- The staging branch is merged into `main` and deleted locally and on `origin`.
- `CLAUDE.md`, `README.md` and `.claude/skills/pr-review-sop/SKILL.md` describe a single-branch workflow: no staging branch, no promotion or soak step; CI is checked after every push to `main`.
- `.github/workflows/ci.yml` triggers only on `main` (pushes and PRs) and on manual runs.
- No file in the repository still names the staging branch.

## 9. Upgrade nodemailer and googleapis past their advisories

`npm audit` still reports advisories that only a major upgrade fixes: `nodemailer` 7 (high; fixed in 10.1.2), which builds every message this server sends, drafts or replies with attachments, and `uuid` through `googleapis` 129 (moderate; fixed by moving to a current `googleapis`). CI passes only because it fails on critical advisories alone.

Done when:

- `nodemailer` and `googleapis` are on releases with no open advisory, and `npm audit` reports nothing above low for production dependencies.
- The MIME builder tests (`utl.test.ts`, `inline-images.test.ts`, `reply-all-helpers.test.ts`) and the draft lifecycle script pass unchanged, and a live draft with an attachment and an inline image renders correctly in Gmail.
- The lockfile is generated so that `npm ci` succeeds under the npm 10 that CI runs (npm 11 prunes optional esbuild entries npm 10 needs; `npx npm@10 install --package-lock-only` restores them).
