# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file once it is implemented.

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

The rule in `CLAUDE.md` and `AGENTS.md` (no changelogs, history, reports or self-praise in the repository) is enforced by review alone. `outlook-claude-mcp`'s `scripts/check-roadmap.mjs` enforces it deterministically for its roadmap: a word list ("fixed", "shipped", "landed", "implemented", "no longer", ticked boxes, struck-through text, `**Done:**`) checked by a pre-commit step and a Claude Code PreToolUse hook on the roadmap file.

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

## 20. Carriage returns survive the HTML-to-text conversion

`htmlToText` (`src/message-body.ts`) collapses runs of spaces and tabs and of three or more `\n`, but HTML parts with CRLF line endings keep their `\r`, so a converted body reads `"Re Itamin,\n\r\n\r\n \r\nWe have…"` (live, an AJ Bell secure-message notice through `gmail-get-message`): the `\r` breaks up the blank-line collapse and leaves stray carriage returns in message files and tool output.

Done when:

- CRLF and lone CR in the HTML part become `\n` before the whitespace rules apply, so converted text holds no `\r` and blank lines collapse as they do for `\n` input.
- The conversion test pins a CRLF case, and `docs/gmail-batch-fetch-spec.md` lists the step.

## 21. CLIs for get_thread, get_inbox_with_threads and download_email

These tools return or write message bodies but have no CLI, so a script cannot use them without an MCP session, and their behaviour can be checked live only through a running MCP server, which picks up a rebuild only when a new Claude session starts it.

Done when:

- `gmail-get-thread`, `gmail-get-inbox-with-threads` and `gmail-download-email` expose their tools one to one, over the same handlers, with help, examples and the shared exit codes.
- Live, each returns or writes the converted HTML part, with `bodySource` `html-over-stub`, for a thread holding a stubbed message.