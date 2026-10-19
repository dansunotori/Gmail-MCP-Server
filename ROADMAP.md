# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. The HTML part delivered beside the text part

Source: `gmail-html-part.md`

`read_email` (CLI `gmail-get-message`) and `batch_fetch_window` (CLI `gmail-batch-fetch-window`) return one `body` per message, with `bodySource` saying which part it came from: `text` (the text/plain part), `html` or `html-over-stub` (the HTML part, the latter when the text part is only a stub). When a message carries both parts, a full text/plain part is returned and the HTML part is not delivered at all. Some senders' text/plain part is stale: observed on a sender's check-in mail, whose text part is the same pick-up reminder from an earlier year under every new subject, while the real content is in the HTML part. A caller has no way to reach that content. Deliver the HTML part too. This is a server and CLI change; the server and its two CLIs are the whole deliverable.

### Contract

- Every message result of `read_email` and `batch_fetch_window`, and the JSON the two CLIs print, carries `htmlBody`: the text/html part as delivered (decoded from its transfer encoding into a string), or `null` when the message has no HTML part.
- `body` and `bodySource` keep their current meaning and values, so a caller reading them today sees no change.
- A message whose HTML part cannot be decoded carries `htmlBody: null` and the reason in `htmlBodyError`, never an empty string that looks like an empty part.
- The two CLIs' `--help` document both fields.

### Done when

- Live, a message with both parts returns its text part in `body` with `bodySource: "text"` and its HTML part in `htmlBody`; a text-only message returns `htmlBody: null`; an HTML-only message returns the same `body` and `bodySource` as today and its HTML part in `htmlBody`.
- `batch_fetch_window` over a window holding all three kinds returns the same values per message as `read_email` does for each.
