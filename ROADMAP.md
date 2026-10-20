# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 3. Result fields and their documentation kept in step by a test

Each field added to a read result (`htmlBody`, `htmlBodyError`, `plainBodyError`, the calendar fields) has to be named by hand in the command help, the MCP tool description, the README command table and `docs/gmail-cli-spec.md`, and only `htmlBody` and `htmlBodyError` in the help are checked by a test. Add one table in a test, mapping each command (`gmail-get-message`, `gmail-get-thread`, `gmail-get-inbox-with-threads`, `gmail-download-email`, `gmail-batch-fetch-window`) to the optional result fields it can emit, and assert for each field that it appears in the command's `--help`, its tool's description in `src/tools.ts`, the command's README table row and its section of `docs/gmail-cli-spec.md`. A field missing from any of them fails the test with the place named.

## 4. plainBodyError in the batch_fetch_window message files

`read_email`, the thread reads and the `download_email` json carry `plainBodyError` when a deferred plain part cannot be fetched or decoded, but a `batch_fetch_window` message file records it only as a `failures` entry, so the file read alone looks complete. Write `plainBodyError` into the message file as `htmlBodyError` is written, add it to the `FIELDS` that `scripts/window-compare.mjs` compares, and document it in `docs/gmail-batch-fetch-spec.md` and the README. Test a window whose message has a plain part that cannot be fetched.

## 5. download_email txt refuses a stub whose HTML part cannot be fetched

The txt format refuses a message whose plain part cannot be fetched, but when the plain part is only a stub and the HTML part it points at cannot be fetched, the txt file is saved holding the stub, with nothing saying the real content is missing. Refuse the txt format in that case too, with the HTML failure's own `GmailRequestError` wrapped by `withContext` so the exit code follows Gmail's status, and test it in `src/read-tools.test.ts` and `src/cli/commands.test.ts`.
