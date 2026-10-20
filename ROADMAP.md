# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 5. htmlBody in get_thread, get_inbox_with_threads and download_email

`get_thread`, expanded `get_inbox_with_threads` and the json file of `download_email` choose each message's `body` as `read_email` does, but carry no `htmlBody`. So a message whose plain part is stale still hides its HTML content there. Give each message read in full the same `htmlBody` and `htmlBodyError` through `resolveMessageBody`, in the MCP tools and in `gmail-get-thread`, `gmail-get-inbox-with-threads` and `gmail-download-email`. Document the fields in their help, the README and `docs/gmail-cli-spec.md`.
