# Gmail read-only CLIs — design

Date: 2026-09-11. Source request: `docs/gmail-cli-spec.md`. Depends on the
`batch_fetch_window` design of the same date, which introduces `src/message-body.ts` and the
`listAllGmailMessageIds` export this design reuses.

## Goal

Add three command-line entry points, `gmail-search`, `gmail-get-message`, and
`gmail-download-attachment`, so scripts and Claude sessions can search, read, and download
Gmail without an MCP session. The output contracts are defined in full in this document.

## Non-negotiables

- JSON on stdout on success; diagnostics on stderr; empty stdout and a non-zero exit on
  failure.
- Reuse `~/.gmail-mcp/gcp-oauth.keys.json` and `~/.gmail-mcp/credentials.json`, including the
  refresh-token persistence in `loadCredentials`. No new credential store.
- MCP server behaviour unchanged. No write operations.
- The CLIs never import `src/index.ts`, which starts the server at module load.

## Architecture

```
src/auth.ts                     loadCredentials, authenticate (moved from index.ts)
src/cli/common.ts               parseArgs wrapper, emitJson, runCli, mapErrorToExitCode
src/cli/gmail-search.ts         bin: gmail-search
src/cli/gmail-get-message.ts    bin: gmail-get-message
src/cli/gmail-download-attachment.ts   bin: gmail-download-attachment
src/gmail-batch.ts              + batchGetGmailMessageSummaries (shares request/parse code)
src/gmail-sync.ts               listAllGmailMessageIds (from the batch-fetch design)
src/message-body.ts             resolveMessageBody, htmlToText, headerValue (from the batch-fetch design)
src/email-export.ts             parseEmailAddress, parseEmailAddresses (existing)
```

### `src/auth.ts` (extraction from `src/index.ts`)

Move `CONFIG_DIR`, `OAUTH_PATH`, `CREDENTIALS_PATH`, `loadCredentials`, and `authenticate`
out of `src/index.ts` as a pure move, with these changes:

- `loadCredentials({ callbackUrl?, requireCredentials })` returns `{ oauth2Client, authorizedScopes, callbackUrl }`
  instead of mutating module-level variables. It throws `CredentialsError` with `kind` one of
  `missing-oauth-keys`, `invalid-oauth-keys`, or `missing-credentials` instead of calling
  `process.exit`. The current-directory copy of `gcp-oauth.keys.json`, the legacy and v1.2.0
  credential shapes, and the `tokens` listener that persists refreshed tokens move unchanged.
- `missing-credentials` is thrown only when the caller passes `{ requireCredentials: true }`.
  The server passes `false` because it can run the `auth` subcommand without a credentials
  file; the CLIs pass `true` except when handling `--auth`.
- Both functions today write progress with `console.log`: the "OAuth keys found in current
  directory" notice, the https-callback notice, "Requesting scopes", "Please visit this URL",
  and "Credentials saved". In `auth.ts` every such line goes through an injected
  `log: (line: string) => void` in the options object. `src/index.ts` passes `console.log`, so
  the server's output is unchanged. The CLIs pass a function that writes to `process.stderr`,
  so stdout stays JSON-only on the normal path and empty on the `--auth` path. `console.error`
  calls (token-persistence failure) stay as they are, since stderr is correct for both callers.
- `authenticate(oauth2Client, callbackUrl, scopes, log)` is otherwise unchanged.
- `src/index.ts` calls `loadCredentials` in `main`, keeps the argv scan for an `http://` or
  `https://` callback and passes it in, assigns the returned client and scopes to its existing
  module variables, and catches `CredentialsError` to print the same messages and exit 1 as
  today. The `auth` subcommand path calls `authenticate` with the new arguments.

`GMAIL_OAUTH_PATH` and `GMAIL_CREDENTIALS_PATH` keep their meaning.

`extractHeaders`, `extractEmailContent`, and `extractAttachments` stay in `src/index.ts`
with their current text. `src/download-email.test.ts` lines 247 to 330 read `index.ts` as a
string and assert on the literal `function extractHeaders` declaration, its return type, and
the two destructuring call sites; moving `loadCredentials` and `authenticate` leaves every one
of those strings in place, so those tests keep passing without edits. Anyone who later moves
`extractHeaders` must replace those source-inspection tests with behavioural tests against the
new module; that is not part of this work.

### `src/cli/common.ts`

| Export | Contract |
|-|-|
| `parseCliArgs(argv, options)` | Wraps `node:util` `parseArgs` with `strict: true` and `allowPositionals: true`. Unknown flags and missing values become `UsageError`. |
| `emitJson(payload, outputPath?)` | Serialises with two-space indentation and a trailing newline. Writes to `outputPath` with `fs.writeFileSync` when given, else to `process.stdout`. |
| `runCli(main)` | Awaits `main()`. On error prints one line to stderr, `error: <message>`, and exits with `mapErrorToExitCode(error)`. Never prints tokens or request headers. |
| `mapErrorToExitCode(error)` | See exit codes below. |
| `printHelpAndExit(text)` | Writes help to stdout and exits 0. Help is the only non-JSON stdout. |
| `runAuthFlow(argv)` | Shared `--auth` handling; see below. |
| `stderrLog(line)` | Writes `line` plus a newline to `process.stderr`. Passed as `log` to `loadCredentials` and `authenticate`. |

`node:util` `parseArgs` exists from Node 18.3, so `engines.node` in `package.json` becomes
`>=18.3.0` and the README states the requirement. Raising the floor by three patch releases
of a line that is already end-of-life costs nothing and stops an install on 18.0 to 18.2 from
failing at runtime.

### Exit codes

| Code | Trigger |
|-:|-|
| 0 | Success |
| 1 | Anything not listed below |
| 2 | `UsageError`: unknown flag, missing required argument, bad `--limit`, bad `--format`, refusing to overwrite without `--force` |
| 3 | `CredentialsError`, or `isAuthError(error)` from `src/gmail-sync.ts` (HTTP 401, the listed auth reasons, or a 403 that is not a rate-limit reason; see the batch-fetch design) |
| 4 | HTTP 429, or an error reason of `quotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, or `dailyLimitExceeded` |
| 5 | HTTP 404 |

`mapErrorToExitCode` runs its checks in this order, and the order is part of the contract:
`UsageError` returns 2 and `CredentialsError` returns 3 by `instanceof`, before anything
else, because both are local errors with no HTTP shape and normalising them would discard
their identity. Only then is the error normalised with `toGmailRequestError` from
`src/gmail-sync.ts`, so a raw googleapis error and a `GmailRequestError` thrown by a helper are
read the same way through `status` and `reason`: `isAuthError` returns 3, then the rate-limit
rule returns 4, then 404 returns 5, and everything else returns 1. The auth test is the same
`isAuthError` the tool uses, so the two surfaces never disagree about what counts as bad
credentials.

### `--auth`

Any CLI accepts `--auth [--scopes=<a,b>]`. It calls `loadCredentials({ requireCredentials: false })`,
then `authenticate` with `DEFAULT_SCOPES` or the parsed and validated `--scopes` list, using
`parseScopes` and `validateScopes` from `src/scopes.ts` exactly as `src/index.ts` does. It then
exits 0. The help text warns that the credentials file is shared with the MCP server, so a
narrower scope set here also narrows the server's tools until the next `gmail-mcp auth`.

## `gmail-search`

```
gmail-search --query <q> [--limit <n>] [--include-spam-trash] [--output <file>] [--auth] [--help]
```

Flow:

1. `loadCredentials({ requireCredentials: true })`; build `gmail` with `google.gmail({ version: 'v1', auth })`.
2. `listAllGmailMessageIds(gmail, { query, includeSpamTrash, limit })`. `limit` defaults to
   250 and is capped at 500; a value outside 1 to 500 is a `UsageError`. If the result has
   `complete: false`, the CLI throws the stored `error` so `runCli` maps it and stdout stays
   empty: a script must never receive a partial list with exit 0. The tolerant partial return
   exists for `batch_fetch_window`, which reports `listingComplete` explicitly; the CLI has no
   such field and therefore no tolerant mode.
3. `batchGetGmailMessageSummaries(oauth2Client, ids)` in chunks of 50, results concatenated.
   IDs the batch reports missing are dropped and counted in one stderr line.
4. Shape each message: `id`, `thread_id`, `subject` and `from` header values, `from` split by
   `parseEmailAddress` into `from` (email) and `from_name`, `date` as
   `new Date(Number(internalDate)).toISOString()`, `is_unread` as `labelIds.includes('UNREAD')`,
   `labels` as `labelIds`.
5. Sort ascending by `internalDate`. Emit `{ query, count, has_more, messages }`.

Help text documents that `after:` and `before:` accept epoch seconds and that epoch seconds
are the right form for watermarks because `YYYY/MM/DD` means local midnight in the account's
time zone.

### `batchGetGmailMessageSummaries` in `src/gmail-batch.ts`

`batchGetGmailIndexMetadata` keeps its signature and output. Its body is split into an internal
`runBatch(auth, ids, { path, fields, schema }, sleep)` that owns the request building, retry
policy, and multipart parsing, parameterised on the per-message GET query string and the zod
schema that validates each 200 body. `batchGetGmailIndexMetadata` calls `runBatch` with its
current query and `GmailIndexMetadataOutputSchema`'s message shape, so its behaviour and tests
are unchanged. One change inside `runBatch` applies to both callers: when retries are
exhausted, it throws `new GmailRequestError('Gmail batch failed after three attempts', { status, reason, cause })`
with the last transient status (429 or 5xx) instead of a plain `Error`. The message is
unchanged, so the existing `gmail-batch.test.ts` assertions still hold, and the CLI exit-code
map can see the 429. A per-part non-transient HTTP status likewise throws a
`GmailRequestError` carrying that status. `batchGetGmailMessageSummaries(auth, ids, sleep?)` calls `runBatch` with
`format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&fields=id,threadId,internalDate,labelIds,payload/headers`
and a schema that keeps `payload.headers` as an array of `{ name, value }`. It returns
`{ messages, missingMessageIds }` in the same style.

## `gmail-get-message`

```
gmail-get-message <message_id> [--format text|markdown] [--no-body] [--output <file>] [--auth] [--help]
```

Flow: one `users.messages.get({ format: 'full' })`. Headers via `headerValue`. `from` via
`parseEmailAddress`; `to` and `cc` via `parseEmailAddresses`. `date` from `internalDate` as in
`gmail-search`. `is_unread` and `labels` as in `gmail-search`. Body and attachments via
`resolveMessageBody`.

- `--format text` (default): `body` is `resolveMessageBody(...).body`, `body_content_type` is
  `"text"`.
- `--format markdown`: when plain text is non-empty, `body` is `text.trim()` and
  `body_content_type` is `"text"`; otherwise `body` is `new TurndownService().turndown(html)`
  and `body_content_type` is `"markdown"`.
- `--no-body`: `body` and `body_content_type` are omitted, and the CLI calls
  `extractMessageParts` instead of `resolveMessageBody`, so no deferred body part is fetched
  and no body-fetch warning can appear. Attachments come from the same walk either way.
- `has_attachments` is `attachments.length > 0`. Each attachment is
  `{ id, filename, mime_type, size }` where `id` is the `attachmentId` or `null` for inline data.
- A body-part fetch failure is a failure of the command: `resolveMessageBody` reports it in
  `failures` as `{ code, error }` where `error` is a `GmailRequestError`, and the CLI throws
  `failures[0].error` so `runCli` maps its status (429 to 4, 404 to 5, otherwise 1) and stdout
  stays empty. Unlike `batch_fetch_window`, which
  has an explicit `incomplete` status for the caller to inspect, the CLI contract is JSON only
  on success, so a document with a missing body must not be emitted. `--no-body` never
  fetches body parts and is unaffected.

Dependencies added: `turndown` (runtime) and `@types/turndown` (dev) for HTML-to-Markdown
conversion.

## `gmail-download-attachment`

```
gmail-download-attachment <message_id> <attachment_id> --output <path> [--force] [--auth] [--help]
```

Flow:

1. `users.messages.attachments.get`; decode with `Buffer.from(data, 'base64url')`. A response
   without `data` is exit 1.
2. Resolve the target. If `--output` is an existing directory or ends with `path.sep`, fetch
   the message with `format: 'full'`, walk `parts` for the part whose `body.attachmentId`
   matches, and take its `filename` or `attachment-<id>`. The Gmail-supplied name is untrusted:
   reduce it with `path.basename`, and if the result is empty, `.`, or `..`, use
   `attachment-<id>`. Then `fullPath = path.resolve(dir, name)` and require
   `fullPath.startsWith(path.resolve(dir) + path.sep)`; otherwise throw `UsageError`
   (`Invalid filename: path traversal detected`). This is the same rule as
   `download_attachment` in `src/index.ts`. After `basename` and the `.`/`..` fallback the
   containment check cannot fail for a non-root directory; it stays as defence in depth and is
   not a tested branch. Otherwise `--output` is the file path as the user
   gave it, resolved with `path.resolve`; user-supplied paths are trusted and only the
   directory branch is containment-checked. Parent directories are created after the
   containment check passes.
3. If the target exists and `--force` is absent, throw `UsageError` (exit 2) before writing.
4. `fs.writeFileSync`; emit `{ output: <absolute path>, bytes }`.

The resolution logic is one exported function, `resolveAttachmentTarget(outputArg, gmailFilename, attachmentId)`,
so the traversal case is unit-tested without a filesystem write.

## `package.json`

```json
"bin": {
  "gmail-mcp": "./dist/index.js",
  "gmail-search": "./dist/cli/gmail-search.js",
  "gmail-get-message": "./dist/cli/gmail-get-message.js",
  "gmail-download-attachment": "./dist/cli/gmail-download-attachment.js"
}
```

Each CLI source starts with `#!/usr/bin/env node`; `tsc` preserves it and `npm link` sets the
executable bit.

## Error handling summary

- All errors reach `runCli`, which prints one stderr line and exits with the mapped code.
  Stdout stays empty on failure because `emitJson` is the last statement of every `main`.
- `--output` write failures are exit 1 with the OS message.
- `gmail-get-message` and `gmail-search` never partially print; they build the whole payload
  first.

## Testing

All under vitest with mocked clients; no test touches the network or `~/.gmail-mcp`.

- `src/auth.test.ts`: with `GMAIL_OAUTH_PATH` and `GMAIL_CREDENTIALS_PATH` pointed at temp
  files, each `CredentialsError` kind; legacy and v1.2.0 credential shapes both load;
  `requireCredentials: false` tolerates a missing credentials file; every progress line
  reaches the injected `log` and nothing reaches a spied `process.stdout.write`, both when a
  local `gcp-oauth.keys.json` is copied and when an https callback is given.
- `src/cli/common.test.ts` also covers `runAuthFlow(argv, deps)`, where `deps` carries
  `loadCredentials`, `authenticate`, and `log` so the test injects fakes. It asserts the fakes
  receive `DEFAULT_SCOPES` or the parsed `--scopes`, that every progress line arrives through
  `log`, and that a spied `process.stdout.write` is never called. The three CLI `main`
  functions take the same `deps` shape with production defaults, so the search, get-message,
  and download tests each also assert that stdout receives exactly one JSON document.
- `src/cli/common.test.ts`: `mapErrorToExitCode` for each row of the table, including a
  `CredentialsError` of each kind mapping to 3 and a `UsageError` mapping to 2 (both with no
  `status` or `reason` and therefore only reachable by the `instanceof` checks that run before
  normalisation), a 401 mapping to 3 ahead of any other rule, a 403 `insufficientPermissions`
  mapping to 3, and a 403 `quotaExceeded` mapping to 4; `emitJson` to a file and to a stub
  stdout; `parseCliArgs` rejects an unknown flag with `UsageError`.
- `src/gmail-batch.test.ts` (extended): `batchGetGmailMessageSummaries` parses headers and
  reports missing IDs; an exhausted 429 rejects with a `GmailRequestError` whose `status` is
  429 and whose message is still `Gmail batch failed after three attempts`; a per-part 400
  rejects with `status` 400; existing cases unchanged.
- `src/cli/gmail-search.test.ts` also covers an exhausted 429 from the batch step mapping to
  exit 4 with nothing on stdout.
- `src/cli/gmail-search.test.ts`: From split, ISO date, `is_unread`, `has_more` true only when a
  page token remained at the limit, ascending order, pagination stops at `limit` and at the
  last page, missing IDs dropped, and a page-two listing failure rejects with the original
  error and emits nothing on a spied stdout. The search logic is exported as
  `searchMessages(gmail, auth, options)` so the test needs no process spawn.
- `src/cli/gmail-get-message.test.ts`: text format with a plain part, text format falling back
  to `htmlToText`, markdown format falling back to turndown, `--no-body` with a deferred body
  part present asserting `users.messages.attachments.get` is never called and the attachment
  list is still complete, a deferred body fetch that fails with 429 rejects and maps to exit 4
  with nothing on stdout, inline attachment with `id: null`. Logic exported as
  `getMessage(gmail, id, options)`.
- `src/cli/gmail-download-attachment.test.ts`: directory target resolves the filename, file
  target used as given, existing target refused without `--force`, written with `--force`, byte
  count correct. Traversal: a Gmail filename of `../../etc/passwd` becomes `passwd` inside the
  directory; an absolute filename `/etc/passwd` becomes `passwd` inside the directory; a
  filename of `..`, `.`, or an empty string falls back to `attachment-<id>`; in every case the
  resolved target starts with the directory path plus separator. Logic exported as
  `downloadAttachment(gmail, ids, options)` and `resolveAttachmentTarget`.

The full existing suite must pass after the extraction.

## Documentation

- `docs/gmail-cli.md`: setup (`npm run build`, `gmail-search --auth`, `npm link`), the three
  usage blocks, output shapes, exit codes, and the epoch-seconds note.
- README: a "Command-line tools" section linking to `docs/gmail-cli.md` and stating the Node
  18.3 requirement. `package.json` `engines.node` is `>=18.3.0`.

## Definition of done

- `npm test`, `npm run build`, and `npm link` succeed.
- Smoke run against a live mailbox: `gmail-search -q "after:<epoch minus 1 day>"`, one ID
  piped to `gmail-get-message`, one attachment downloaded to a scratch directory, and the JSON
  shapes checked against this document. The commands and their stderr are in the report;
  stdout is summarised, not pasted, to keep mailbox content out of the transcript.
- The MCP server still starts and `read_email`, `search_emails`, and `download_attachment`
  behave as before, checked by the existing tests and one manual server start over stdio that
  returns the tool list.
