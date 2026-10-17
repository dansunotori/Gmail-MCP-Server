# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 16. Run the roadmap check before every commit

`scripts/check-roadmap.mjs` runs in CI and as the project's PreToolUse hook on Write and Edit, so a roadmap change made another way (a shell command, a merge, an editor) is checked only after it is pushed. Nothing in this repository runs it at commit time, and agents on this machine may not change `.git/hooks` or `.git/config`, where a git pre-commit hook would be installed, so that step is the maintainer's.

Done when:

- A git pre-commit hook runs `npm run roadmap:check` on the staged `ROADMAP.md` and refuses the commit on a finding, without weakening any review that already runs at commit time.
- A commit with finished-work wording in a staged `ROADMAP.md` is refused locally, whatever made the change.

## 21. CLIs for get_thread, get_inbox_with_threads and download_email

These tools return or write message bodies but have no CLI, so a script cannot use them without an MCP session, and their behaviour can be checked live only through a running MCP server, which picks up a rebuild only when a new Claude session starts it.

Done when:

- `gmail-get-thread`, `gmail-get-inbox-with-threads` and `gmail-download-email` expose their tools one to one, over the same handlers, with help, examples and the shared exit codes.
- Live, each returns or writes the converted HTML part, with `bodySource` `html-over-stub`, for a thread holding a stubbed message.

## 22. Whitespace-only lines in text converted from HTML

`htmlToText` collapses runs of spaces and tabs to one space and three or more `\n` to two, but a line left holding only spaces (a tag between two line breaks becomes a space) is not blank to that rule, so a converted body reads `"Re Itamin,\n\n \nWe have…"` (live, an AJ Bell secure-message notice through `gmail-get-message`): an extra line of one space between paragraphs.

Done when:

- Spaces and tabs at the start and end of each converted line are removed before blank lines collapse, so no converted line holds only whitespace.
- The conversion test pins the case, and `docs/gmail-batch-fetch-spec.md` lists the step; the message-file shape changes for such bodies.