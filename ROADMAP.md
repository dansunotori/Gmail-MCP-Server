# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 16. Run the roadmap check before every commit

`scripts/check-roadmap.mjs` runs in CI and as the project's PreToolUse hook on Write and Edit, so a roadmap change made another way (a shell command, a merge, an editor) is checked only after it is pushed. Nothing in this repository runs it at commit time, and agents on this machine may not change `.git/hooks` or `.git/config`, where a git pre-commit hook would be installed, so that step is the maintainer's.

Done when:

- A git pre-commit hook runs `npm run roadmap:check` on the staged `ROADMAP.md` and refuses the commit on a finding, without weakening any review that already runs at commit time.
- A commit with finished-work wording in a staged `ROADMAP.md` is refused locally, whatever made the change.

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