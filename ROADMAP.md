# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file once it is implemented.

## 11. Decode numeric character references in the HTML-to-text conversion

`htmlToText` (`src/message-body.ts`) decodes five named entities and leaves numeric references as they are, so a body converted from HTML can read `&#8199;&#8199;` or `&#x2019;` where the sender wrote a space or an apostrophe. Live, marketing mail delivered through `html-over-stub` and HTML-only messages shows them. The conversion is pinned as a stable output shape for message files, so this changes that shape on purpose.

Done when:

- Decimal (`&#8217;`) and hexadecimal (`&#x2019;`) references, and the common named entities beyond the five handled today (`&rsquo;`, `&ndash;`, `&hellip;`, `&copy;`), decode to their characters; an invalid reference is left as written.
- The test that pins the conversion is updated with the new cases, and the README and spec describe how numeric and named references are decoded.

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

## 14. Refuse unknown MCP tool arguments

Most input schemas in `src/tools.ts` are plain `z.object`, which drops keys it does not know, so a misnamed argument (`message_id` for `messageId`, `max_results` for `maxResults`) is silently ignored and the call runs without it. `outlook-claude-mcp` makes every input schema strict and names the accepted arguments in the refusal, with the likely intended one (`src/mcp/strict-input.ts`: `strictInputSchema`, `suggestReplacement`, `unknownArgumentsMessage`).

Done when:

- Every MCP tool refuses an unknown argument with an error result naming it, the accepted arguments, and the intended one where a spelling or prefix match makes it evident (`message_id (use messageId instead)`).
- The CLIs' `--input` refuses an unknown field the same way, with the same wording.
- A test walks `toolDefinitions` and fails for any input schema that is not strict.

## 15. Tool-to-CLI parity test

`outlook-claude-mcp`'s `src/cli/tool-cli-parity.test.ts` proves each CLI exposes its tool one to one: every schema field is a positional or a same-named kebab-case flag (`--<field>-file` for a file), every alias points at a real flag, and every help example parses. Here only "every flag has an example" is checked; nothing stops `draft_email` gaining an input that `gmail-create-draft` lacks, or a help example that no longer parses.

Done when:

- A test fails when a schema field of a command's MCP tool has no matching flag or positional, unless the command declares it input-only.
- Every example line in every command's `--help` is parsed by the command's own parser without error.

## 16. Guard the roadmap against finished-work wording

Item 10's rule (no changelogs, history or reports in the repository) is enforced by review alone. `outlook-claude-mcp`'s `scripts/check-roadmap.mjs` enforces it deterministically for its roadmap: a word list ("fixed", "shipped", "landed", "implemented", "no longer", ticked boxes, struck-through text, `**Done:**`) checked by a pre-commit step and a Claude Code PreToolUse hook on the roadmap file.

Done when:

- A script local to this repository refuses `ROADMAP.md` content that reports finished work, run as a pre-commit check and as a project-level PreToolUse hook on edits to that file, with fenced and inline code exempt.
- Its tests cover each pattern and the exemptions.

## 17. download_attachment loses the attachment's name and type

Gmail issues a new attachment id each time a message is read, so the id a caller holds almost never appears in the fresh `messages.get` that `downloadAttachment` (`src/read-tools.ts`) searches for the attachment's part. The part is then not found: without `filename` the file is saved as `attachment-<id>`, and the reported `mimeType` (always looked up by `gmail-download-attachment`) is `application/octet-stream`, whatever the attachment is. `get_attachment_text` already finds the part by exact id, else by the bytes' size, else as the only attachment (`findPart` in `src/attachment-text/attachment-text.ts`).

Done when:

- `download_attachment` and `gmail-download-attachment` find the part the way `get_attachment_text` does, through one shared function, and save the file under its real name with its real type.
- Live, downloading an attachment by an id from an earlier read of the message saves it under its own name and reports its own MIME type.

## 18. Wrap a command's own exit codes in the CLI help

`renderHelp` (`src/cli/common.ts`) appends a command's `exitCodes` to the shared exit-code line without rewrapping it, so `gmail-get-attachment-text --help` prints one line of about 150 characters ("… 6 attachment protected, encrypted, corrupt or unsupported. On failure nothing is written to stdout, and stderr"), where every other help line keeps under 100.

Done when:

- The exit-code paragraph is wrapped after the command's codes are added, at the width the rest of the help uses.
- A test fails when any line of any command's `--help` exceeds that width.

## 19. Drop or replace mcp-evals, whose dependencies carry unfixed advisories

`mcp-evals` (a dev dependency, used only by `src/evals/evals.ts`) pulls in `ai`, `@ai-sdk/*` and `jsondiffpatch`, for which `npm audit` reports a high advisory (`jsondiffpatch`: XSS and prototype pollution) and a moderate one (`@ai-sdk/provider-utils`), both with no fix available. Production dependencies are clean; CI passes only because its audit step fails on critical advisories alone.

Done when:

- `npm audit` reports nothing above low for all dependencies, dev included, with the evals either moved to a maintained runner or removed along with `src/evals/`.
- CI's audit step fails on high advisories, not only critical ones.