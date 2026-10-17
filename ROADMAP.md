# Roadmap

Work to implement, in order. Item 6 comes from the prompt `figaro-pa-predecessor/docs/prompts/gmail-attachment-text.md` and keeps its contract and done-when criteria. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file once it is implemented.

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

## 9. Upgrade nodemailer and googleapis past their advisories

`npm audit` still reports advisories that only a major upgrade fixes: `nodemailer` 7 (high; fixed in 10.1.2), which builds every message this server sends, drafts or replies with attachments, and `uuid` through `googleapis` 129 (moderate; fixed by moving to a current `googleapis`). CI passes only because it fails on critical advisories alone.

Done when:

- `nodemailer` and `googleapis` are on releases with no open advisory, and `npm audit` reports nothing above low for production dependencies.
- The MIME builder tests (`utl.test.ts`, `inline-images.test.ts`, `reply-all-helpers.test.ts`) and the draft lifecycle script pass unchanged, and a live draft with an attachment and an inline image renders correctly in Gmail.
- The lockfile is generated so that `npm ci` succeeds under the npm 10 that CI runs (npm 11 prunes optional esbuild entries npm 10 needs; `npx npm@10 install --package-lock-only` restores them).

## 10. Remove changelogs, history, reports, and trumpet-blowing

- Add standing rules that no changelogs, history, reports, or trumpet-blowing survive in this repository files or code comments. 
- Double-check model logic for reporting preservation and close those gaps in the repo instructions, too
- Review every documend and code file for the violations and remove changelogs, history, reports, and trumpet-blowing.

## 11. Decode numeric character references in the HTML-to-text conversion

`htmlToText` (`src/message-body.ts`) decodes five named entities and leaves numeric references as they are, so a body converted from HTML can read `&#8199;&#8199;` or `&#x2019;` where the sender wrote a space or an apostrophe. Live, marketing mail delivered through `html-over-stub` and HTML-only messages shows them. The conversion is pinned as a stable output shape for message files, so this changes that shape on purpose.

Done when:

- Decimal (`&#8217;`) and hexadecimal (`&#x2019;`) references, and the common named entities beyond the five handled today (`&rsquo;`, `&ndash;`, `&hellip;`, `&copy;`), decode to their characters; an invalid reference is left as written.
- The test that pins the conversion is updated with the new cases, and the README and spec say the conversion changed shape.

## 12. One body rule for every tool that returns a body

`read_email` and `batch_fetch_window` choose the body with `bodySourceOf` (stub detection, `bodySource`), but `get_thread`, `get_inbox_with_threads` and `download_email` still take `text || html`: a stubbed message comes back as its stub through them, and they report no `bodySource`.

Done when:

- Those three tools choose the body through `bodySourceOf` and report `bodySource` per message.
- A thread holding a stubbed message returns the converted HTML part for it through `get_thread` and `get_inbox_with_threads`, and `download_email` writes it in the txt and json formats.

## 13. HTML bodies dropped by the MCP compose tools' text/plain default

`SendEmailSchema` and `UpdateDraftSchema` default `mimeType` to `text/plain`, and `createEmailMessage` (`src/utl.ts`) then writes only the plain body, so `send_email`, `draft_email` and `update_draft` called with `htmlBody` and no `mimeType` send or save no HTML at all (an HTML-only call produces an empty message). Mail with attachments goes through nodemailer, which keeps the HTML, so the result also depends on whether a file is attached. `gmail-create-draft` already infers the type from the bodies given and refuses `text/plain` beside an HTML body.

Done when:

- With no `mimeType`, the MCP tools pick it the way `gmail-create-draft` does (`text/html` for an HTML body alone, `multipart/alternative` for both), with and without attachments, and an explicit `text/plain` beside `htmlBody` is an error result rather than a silently dropped body.
- The schema descriptions and README say so, and `server.test.ts` covers each tool's HTML-only and both-bodies cases.