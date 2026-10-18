# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 25. Watch the CI run of the commit just pushed

After each push the CI run is found with `gh run list --branch main --limit 1` and watched with `gh run watch <id>`, and nothing confirms that the listed run is the one for the pushed commit rather than an earlier one still queued.

Done when:

- `npm run ci:watch` finds the CI run whose head commit is `HEAD`, waiting for it to appear, watches it to the end and exits with its result, naming the run and the failed step when it fails.
- It refuses, with a clear message, when `HEAD` is not pushed.

## 26. Keep the command list in the docs and package.json in step with the code

A new command means a `CommandSpec` in `src/cli/commands.ts`, an entry in `COMMANDS`, a `src/cli/gmail-*.ts` entry file, a `bin` in `package.json`, a row in the README's command table and in `docs/gmail-cli-spec.md`'s bin table, and the command counts in both texts, all kept in step by hand.

Done when:

- A test fails when `COMMANDS`, `package.json` `bin`, the `src/cli/gmail-*.ts` entry files, the README command table and the spec's bin table do not name the same commands, or when either text's command count differs from `COMMANDS.length`.

## 27. CLIs for the remaining read-only tools

`list_inbox_threads`, `get_gmail_profile`, `list_gmail_message_ids`, `list_gmail_added_history`, `batch_get_gmail_index_metadata`, `list_email_labels`, `list_filters` and `get_filter` only read Gmail but have no CLI, so a script needs an MCP session to call them, against the rule at the top of this file.

Done when:

- Each has a `gmail-*` command over the same core function as its MCP handler, covered by the parity test in `src/cli/tool-cli-parity.test.ts`, with help, examples and the shared exit codes.
- Live, each prints the tool's result for this mailbox.

## 28. Calendar reply fields in get_thread, get_inbox_with_threads and download_email

`read_email`, `gmail-get-message` and `batch_fetch_window` report `calendarMethod` and `calendarReply` from a message's `text/calendar` part (`resolveCalendarPart` in `src/calendar-part.ts`), but the messages of `get_thread`, `get_inbox_with_threads` and their CLIs, and the json file of `download_email`, carry neither, so a thread read cannot tell a meeting response from ordinary mail.

Done when:

- Those tools and CLIs carry the same fields, and `calendarFailures` for a part that cannot be read, from the same reader, and a message without a calendar part carries none of them.
- Live, the acceptance and decline between your own two accounts show `REPLY` with the right partstat through `gmail-get-thread` and `gmail-download-email --format json`.