# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

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