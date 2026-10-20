# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. One command for the pre-commit graph check

`detect_changes` maps diff hunks against the last GitNexus index, so after several commits it names the wrong symbols (unrelated functions at shifted line numbers) until `node .gitnexus/run.cjs analyze --index-only` runs first. Add `npm run graph:check` (a script in `scripts/`) that runs the index refresh, then `node .gitnexus/run.cjs detect-changes --scope all --repo .`, and exits non-zero when the result carries `partial: true` or `truncated: true`, printing the changed symbols and the risk level. Add it to `npm run verify` after `install-cli`, so the check that CLAUDE.md requires before each commit always runs against a fresh index. Test the exit codes with a stubbed runner in `scripts/`.

## 2. A repeatable live check of charset decoding

Whether Gmail converts a part to UTF-8 depends on how it delivers it: an inline `format=full` part arrives in UTF-8, a part served by `attachments.get` in the charset it names. That was settled with throwaway scripts. Add `npm run live:charset-check`: a script that inserts one unsent, unlabelled message (gmail.modify, `users.messages.insert`) with a 4 MB windows-1251 plain part and HTML part, plus a small KOI8-R one delivered inline, reads each through `readEmail` from `dist/`, prints only counts (length, replacement characters, Cyrillic letters, whether the text equals what was sent), moves the messages to Bin in a `finally`, and exits 1 when any text differs from what was sent. Document it in `docs/gmail-cli-spec.md` beside `window:compare`, and test its report and exit code with a stubbed Gmail client.

## 3. Result fields and their documentation kept in step by a test

Each field added to a read result (`htmlBody`, `htmlBodyError`, `plainBodyError`, the calendar fields) has to be named by hand in the command help, the MCP tool description, the README command table and `docs/gmail-cli-spec.md`, and only `htmlBody` and `htmlBodyError` in the help are checked by a test. Add one table in a test, mapping each command (`gmail-get-message`, `gmail-get-thread`, `gmail-get-inbox-with-threads`, `gmail-download-email`, `gmail-batch-fetch-window`) to the optional result fields it can emit, and assert for each field that it appears in the command's `--help`, its tool's description in `src/tools.ts`, the command's README table row and its section of `docs/gmail-cli-spec.md`. A field missing from any of them fails the test with the place named.

## 4. plainBodyError in the batch_fetch_window message files

`read_email`, the thread reads and the `download_email` json carry `plainBodyError` when a deferred plain part cannot be fetched or decoded, but a `batch_fetch_window` message file records it only as a `failures` entry, so the file read alone looks complete. Write `plainBodyError` into the message file as `htmlBodyError` is written, add it to the `FIELDS` that `scripts/window-compare.mjs` compares, and document it in `docs/gmail-batch-fetch-spec.md` and the README. Test a window whose message has a plain part that cannot be fetched.

## 5. download_email txt refuses a stub whose HTML part cannot be fetched

The txt format refuses a message whose plain part cannot be fetched, but when the plain part is only a stub and the HTML part it points at cannot be fetched, the txt file is saved holding the stub, with nothing saying the real content is missing. Refuse the txt format in that case too, with the HTML failure's own `GmailRequestError` wrapped by `withContext` so the exit code follows Gmail's status, and test it in `src/read-tools.test.ts` and `src/cli/commands.test.ts`.
