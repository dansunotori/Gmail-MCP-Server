# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. A live cross-check of the window files against gmail-get-message

Checking live that `batch_fetch_window` and `read_email` agree on a message takes hand-written `jq` filters per message and field, and a tally over a whole window does not fit in one shell command. Add `npm run window:compare -- <output-dir> [--limit N]`, a script that reads every `messages/NNN.json` under the directory and runs `gmail-get-message` for each message (or the first N). For each message it compares `bodySource`, `htmlBody`, `htmlBodyError`, `messageIdHeader` and the calendar fields, and prints one JSON report. The report gives counts per `bodySource`, the number of messages with and without an HTML part, the number with `htmlBodyError`, and every message whose fields differ, naming the fields. `body` is compared too, except for HTML-only messages, where the two tools differ by design. Exit 0 when nothing differs, 1 when something does, and 2 on usage or Gmail errors. Test it against a fake `gmail-get-message` and a fixture window.

## 2. read_email reads deferred body parts for body, not only for htmlBody

`readEmail` takes `body` from `extractEmailContent`, which skips body parts that Gmail delivers as an `attachmentId`. So a message whose only plain part is deferred gets an empty plain text, and `body` falls back to the HTML or comes out empty, while `batch_fetch_window` fetches that part and uses it. Take `text` and `html` for `body` from `resolveMessageBody` as well, keep `selectBody`'s keep-HTML rule for an HTML-only message, and drop the separate `extractEmailContent` read in `readEmail`. Then the deferred parts are fetched once and used for both `body` and `htmlBody`. Test a message whose plain part is deferred.

## 3. read_email lists deferred body parts as attachments

`extractAttachments` treats every part with an `attachmentId` as an attachment. So `read_email` and `gmail-get-message` list a deferred, unnamed `text/plain` or `text/html` body part as an attachment called `attachment-<id>`, while `batch_fetch_window`'s `walk` treats the same part as body. List as attachments only the parts that `walk` lists (a part with a filename, or one that is not an unnamed text/plain or text/html part), in `read_email`, `get_thread`, `get_inbox_with_threads` and `download_email`. Test this with the deferred-HTML fixture in `src/read-tools.test.ts`.

## 4. The HTML part decoded by its charset

`htmlBody`, and the HTML that `body` is chosen from, are decoded as UTF-8 whatever the part's `Content-Type` charset says. So a part in `windows-1252`, `iso-8859-1` or `koi8-r` comes out with replacement characters. Check from a live message in a non-UTF-8 charset whether the Gmail API returns the part's original bytes. If it does, decode text/plain and text/html parts with `TextDecoder` using the charset parameter, falling back to UTF-8 when there is none. An unknown charset puts the reason in `htmlBodyError` (and a body failure in `failures`), never an empty part.

## 5. htmlBody in get_thread, get_inbox_with_threads and download_email

`get_thread`, expanded `get_inbox_with_threads` and the json file of `download_email` choose each message's `body` as `read_email` does, but carry no `htmlBody`. So a message whose plain part is stale still hides its HTML content there. Give each message read in full the same `htmlBody` and `htmlBodyError` through `resolveMessageBody`, in the MCP tools and in `gmail-get-thread`, `gmail-get-inbox-with-threads` and `gmail-download-email`. Document the fields in their help, the README and `docs/gmail-cli-spec.md`.
