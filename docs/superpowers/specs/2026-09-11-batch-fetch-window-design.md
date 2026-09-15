# `batch_fetch_window` MCP tool — design

Date: 2026-09-11. Source request: `docs/gmail-batch-fetch-spec.md`. This document is
self-contained: every output shape, rule and string the tool must produce is stated here, and
nothing outside this repository is a requirement.

## Goal

Give this server one tool, `batch_fetch_window`, that downloads every Gmail message received
since a watermark into a caller-supplied directory, with a manifest, window metadata and a
spam/trash/anywhere cross-check, so that any client of this server can index a mailbox window
without calling the Gmail API itself.

## Scope

In scope: one tool, its schema, handler, tests, README entry, and one note in
`docs/gmail-cli-spec.md`. Two small reusable modules that the tool needs and that the later CLI
work will share.

Out of scope: CLIs, changes to any existing tool's behaviour or output schema, auth or scope
changes, and anything outside this repository.

## Architecture

Three units, each with one job. The handler in `src/index.ts` is a single `case` that parses
input and delegates.

```
index.ts case "batch_fetch_window"
  └─ batchFetchWindow(gmail, input)            src/batch-fetch-window.ts
       ├─ getGmailEmailAddress(gmail)          src/gmail-sync.ts (new export)
       ├─ listAllGmailMessageIds(gmail, …)     src/gmail-sync.ts (new export)
       ├─ gmail.users.messages.get             per listed ID, sequential
       ├─ resolveMessageBody(gmail, id, payload)  src/message-body.ts
       └─ node:fs writes under output_dir
```

### `src/message-body.ts`

Owns MIME walking and HTML-to-text conversion. Pure functions except `resolveMessageBody`,
which takes the Gmail client for deferred body parts.

| Export | Contract |
|-|-|
| `decodeBase64Url(data)` | Empty string for falsy input; otherwise base64url decoded as UTF-8. |
| `headerValue(headers, name)` | Case-insensitive lookup; empty string when absent. |
| `extractMessageParts(payload)` | Returns `{ text, html, attachments, deferredBodies }`. Rules, in order per part: an `attachmentId` part with mime `text/plain` or `text/html` and no filename is a deferred body; any other `attachmentId` part is an attachment `{ filename, mimeType, size, attachmentId }`; a part with `body.data` and a filename is an attachment `{ filename, mimeType, size, inlineBase64 }`; a `text/plain` part with data appends to `text`; a `text/html` part with data appends to `html`. Recurse into `parts` after handling the part itself. |
| `htmlToText(html)` | A fixed regex chain applied in this order: strip `<style>…</style>` and `<script>…</script>` blocks (each replaced by a space); `<br>`/`<br/>` followed by any character other than a newline becomes `\n`; closing `</p>`, `</div>`, `</tr>`, `</li>`, `</h1>`…`</h6>` become `\n`; `<a href="…">text</a>` (double or single quotes) becomes `text [href]`; every remaining tag becomes a space; `&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&#39;`/`&apos;`, `&quot;` are decoded; runs of spaces and tabs collapse to one space; three or more newlines collapse to two; the result is trimmed. The `<br>` rule deliberately does not match a `<br>` immediately followed by a newline (no `s` flag), so that case keeps its literal newline; this is the documented behaviour and a test pins it. |
| `resolveMessageBody(gmail, messageId, payload)` | Runs the walk, fetches each deferred body with `users.messages.attachments.get`, appends decoded data to `text` or `html` by mime, and returns `{ text, html, body, attachments, failures }`. `body` is `text.trim()` when non-empty, else `htmlToText(html)`. Each fetch failure adds `{ code: 'body-part-fetch: <failureCode>', error: GmailRequestError }` to `failures` (note the space after the colon; the format is `body-part-fetch: ${failureCode}`), so the tool writes `code` into the manifest and the CLI can throw `error` with its status intact. An `isAuthError` failure rethrows instead. |

The existing `extractEmailContent` and `extractAttachments` in `src/index.ts` stay as they are.
Their semantics differ from `extractMessageParts` (they never defer bodies and they list every
`attachmentId` part as an attachment), and shipped tools depend on that.

### New exports in `src/gmail-sync.ts`

`listGmailMessageIds` and `getGmailProfile` stay unchanged. Two siblings are added.

`listAllGmailMessageIds(gmail, { query, includeSpamTrash, limit? })` calls
`users.messages.list` with `q: query`, the given `includeSpamTrash`, and
`fields: 'messages/id,nextPageToken'`, following `nextPageToken` until it is absent or `limit`
IDs have been collected. Each page requests
`maxResults: limit === undefined ? 500 : Math.min(500, limit - ids.length)`, so a limited
call never over-fetches. IDs are deduplicated in first-seen order. If a page still returns
more IDs than the remaining budget, the surplus is discarded and counts as evidence of more
results. Returns `{ ids, pages, hasMore, complete, error? }`; `hasMore` is true when `limit` was
reached and either a `nextPageToken` was present or IDs were discarded. Without `limit`,
`hasMore` is always false because the loop runs to the last page. `complete` is true when the
loop ended by exhausting pages or reaching `limit`. When a page after the first throws a
non-auth error, the function catches it, sets `complete: false`, stores the error in `error`,
and returns what it has; `pages` counts only successful pages. A failure on the first page
propagates, because the caller has nothing to work with, and an `isAuthError` failure on any
page propagates.

`getGmailEmailAddress(gmail)` calls `users.getProfile` with `fields: 'emailAddress'` and
returns the string, throwing if the response omits it.

`GmailRequestError` is an `Error` subclass exported from `src/gmail-sync.ts` with
`code?: string`, `status?: number`, `reason?: string`, and `cause: unknown`.
`toGmailRequestError(error)` wraps any googleapis error, reading `code` from a truthy
`error.code` (as a string), status through the same logic as `responseStatus` in
`src/gmail-batch.ts`, and reason from `error.errors?.[0]?.reason` or
`error.response?.data?.error?.errors?.[0]?.reason`; a `GmailRequestError` passes through
unchanged. Keeping `code` on the wrapper is what lets a network failure such as
`ECONNRESET` on a later listing page survive the wrap and still render as `ECONNRESET` in
the manifest. `failureCode(error)` renders the manifest string as
`error.code || error.response?.status || error.name`: a truthy `error.code` first, as a
string (gaxios sets it to the HTTP status such as `429`, or to a network code such as
`ECONNRESET`), else the HTTP status, else `error.name`, with no other fallback, so the
manifest strings are stable and predictable for any consumer. The `reason` field on the wrapper
exists for `isAuthError` and the CLI exit-code map, not for manifest strings. Every helper in
this design that catches and re-reports an
error keeps the `GmailRequestError` object alongside any string it derives, so no caller has
to parse a string to learn the status.

`isAuthError(error)` is the one rule for "these credentials cannot do this", used by every
tolerant catch in this design and by the CLI exit-code map. It normalises with
`toGmailRequestError` and returns true when the status is 401; or when the reason or
`response.data.error` is `invalid_grant`, `invalid_token`, `authError`, `unauthorized`,
`insufficientPermissions`, `forbidden` (Gmail's reason for a token that lacks the scope), or
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`. A 403 whose reason is `quotaExceeded`,
`rateLimitExceeded`, `userRateLimitExceeded`, or `dailyLimitExceeded` is a rate-limit
failure, not an auth failure, and stays on the tolerant path; a 403 with any other reason is
treated as an auth failure, because the credential, not the request, is what cannot be fixed
by retrying. Insufficient scope must throw for the same reason revoked credentials must: the
output directory has already been cleared by then, and a result that merely says `incomplete`
would hide that every remaining fetch is doomed.

Every catch that records a failure and continues must first test `isAuthError` and rethrow
when it is true. The tolerant catches are: later pages in `listAllGmailMessageIds`, the
per-message `messages.get` loop, the deferred body fetch in `resolveMessageBody`, and the
three cross-check listings. Revoked or expired credentials therefore always leave the tool
through the thrown-error path, as the source document requires, rather than as a result whose
`status` merely says `incomplete`.

### `src/batch-fetch-window.ts`

`batchFetchWindow(gmail, input, now = () => new Date())` returns the tool result object.
Steps:

1. `boundaryMs = Date.parse(input.watermark)`, `epoch = Math.floor(boundaryMs / 1000)`,
   `windowQuery = \`after:${epoch - 1} -in:spam -in:trash\``.
2. `emailAddress = await getGmailEmailAddress(gmail)`.
3. `windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true })`,
   with no limit, so the listing runs to exhaustion and `listed` is the true count the caller
   needs to pick a new cap. If the first page throws, the error propagates: nothing has
   succeeded yet and the caller should retry. If a later page throws,
   `listAllGmailMessageIds` returns the IDs collected so far with `complete: false` and the
   error; the tool records `{ id: 'window-listing:page-<n>', error }` in `failures` and sets
   `listingComplete: false`. `manifest.json` and the result both carry `listingComplete` so a
   partial ID list can never pass for a whole window.
4. If `windowList.ids.length > input.max_messages`, stop before any fetch or write. Nothing is
   written, not even `manifest.json`, so a stale manifest cannot pass for a fresh run. The
   result carries `truncated: true` and the true `listed`. Its `status` is `truncated` when
   `failures` is empty, and `incomplete` when the listing itself failed part-way, because the
   rule that any recorded failure yields `incomplete` takes precedence; in both cases the
   caller can see `truncated`, `listed`, `listingComplete`, and `failures` and decide.
5. Otherwise continue with the listed IDs, complete or partial. A partial listing yields
   `status: 'incomplete'` regardless of anything else below.
6. `mkdirSync(output_dir, { recursive: true })`; then remove exactly the three things the
   tool owns, before any fetch: `rmSync(manifestPath, { force: true })`,
   `rmSync(windowMetadataPath, { force: true })`,
   `rmSync(messagesDir, { recursive: true, force: true })`; then `mkdirSync(messagesDir)`.
   Nothing else in `output_dir` is read, matched, or deleted, and no wildcard is ever applied
   to the caller's directory.
   Deleting the two metadata files first is what makes the guarantee in the error section
   hold: from this point until the final writes, `output_dir` contains no manifest, so a run
   that throws part-way leaves message files without metadata, and a consumer that requires
   `manifest.json` cannot pair stale metadata with a new or partial `messages/`.
7. For each ID in listing order: `users.messages.get({ format: 'full' })`. On error push
   `{ id, error: failureCode(error) }` to `failures`. Skip and count
   in `belowBoundaryOrExcluded` when `Number(internalDate) < boundaryMs` or `labelIds` include
   `SPAM` or `TRASH`. Otherwise keep `{ data, internal, labels }`.
8. Sort kept messages by `internal` ascending. Padding width is
   `Math.max(3, String(kept.length).length)`, computed once. For each kept message in order:
   `resolveMessageBody`, append each of its `failures` as `{ id, error: failure.code }`, then write
   `messages/<NNN>.json` pretty-printed with two spaces and a trailing newline. The file shape is
   `id, threadId, internalDate, labelIds, from, to, cc, subject, dateHeader, snippet,
   attachments, body`.
9. Cross-check when `input.cross_check` is true: list `after:${epoch - 1} in:spam`,
   `after:${epoch - 1} in:trash`, and `after:${epoch - 1} in:anywhere`, each with
   `includeSpamTrash: true`. `unexplainedIds` are anywhere IDs absent from the window listing,
   the spam listing, and the trash listing. `consistent` is `unexplainedIds.length === 0`. A
   listing failure here is recorded as `{ id: 'cross-check:<query>', error }` and forces
   `status: 'incomplete'`, because files are already on disk and the caller must see them as
   unverified.
10. Write `window-metadata.json` first, then `manifest.json`, with the contents the source
    document shows. `file` values are absolute, built with
    `path.join(output_dir, 'messages', name)`. Each file is published atomically: write the
    full content to `messages/.publish-<name>` (inside the directory the tool owns, so no
    caller file can be confused with it), then `fs.renameSync` it to `output_dir/<name>`. The
    source and target share a filesystem because `messages/` is inside `output_dir`, so the
    rename is atomic and a reader never sees a partial file. A write that throws leaves only
    `messages/.publish-<name>`, which the next run's step 6 removes with the rest of
    `messages/`; the dot prefix and non-`.json` suffix keep it out of any `NNN.json` listing.
    Ordering matters: the manifest is the success signal, so it is published last; a failure
    writing `window-metadata.json` leaves no manifest, and a failure writing the manifest's
    temporary file leaves no manifest either.
11. Return the result.

### Result and status

The result is the manifest summary without the `messages` array, plus `triage` (one string per
written file, `"<file> | <from> | <subject> | <dateHeader> | <n> att"`, in file order) and
`status`:

| status | when |
|-|-|
| `ok` | listing complete, no failures, cross-check consistent or disabled, not truncated |
| `incomplete` | any failure recorded (including a part-way listing failure), or cross-check inconsistent; files are written unless `truncated` is also true |
| `truncated` | listing exceeded `max_messages` with no failures; nothing written; `messages/` untouched |

Precedence: a non-empty `failures` array always yields `incomplete`; `truncated` is only
reported as the status when `failures` is empty. The boolean `truncated` field is independent
of `status` and is what the caller must check before trusting the file set.

The manifest and the result both carry `listingComplete: boolean`.

A result with `truncated: true` carries `status` as above, `listed` (the true count),
`listingComplete`, `maxMessages`, `query`, `pages`, `watermark`, `boundaryMs`, `emailAddress`,
`checkedAt`, `failures` (empty or the listing failure), empty `triage`, `inWindow: 0`,
`belowBoundaryOrExcluded: 0`, and `crossCheck` omitted.

The handler wraps the result with `structuredResult` from `src/gmail-sync.ts`.

### Schema and registration (`src/tools.ts`)

`BatchFetchWindowSchema`, `.strict()`:

- `watermark`: string matching `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/`
  and with finite `Date.parse`. Both checks run in one `superRefine` so the error names the
  missing zone suffix when that is the problem.
- `output_dir`: string, `path.isAbsolute` must be true.
- `max_messages`: integer, minimum 1, default 2000.
- `cross_check`: boolean, default true.

`BatchFetchWindowOutputSchema`, `.strict()`, with `status` as `z.enum(['ok','incomplete','truncated'])`,
the summary fields as numbers and strings, `listingComplete` as a boolean, `failures` as an
array of `{ id, error }`, `crossCheck` optional, `triage` as an array of strings.

Tool definition: name `batch_fetch_window`, description "Downloads every message received
since a watermark into a local directory with manifest and cross-check; deletes and recreates
`messages/` under `output_dir` unless the listing exceeds `max_messages`, in which case nothing
is written and earlier outputs remain" (the `output_dir` field description carries the same
qualification, because a truncated result can coexist with stale outputs from an earlier
window and the caller must check `truncated` before trusting the files), scopes `["gmail.readonly", "gmail.modify"]`, annotations
`{ title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false }`.
The source document originally asked for `readOnlyHint: true` because the mailbox is never
modified; it was amended on 2026-09-11 to match this design, because the MCP SDK defines the
hint as "does not modify its environment", and this tool deletes a directory and overwrites
two files. Clients use the hint to skip confirmation, so it must be false. `idempotentHint` is
false because the window is open-ended: a repeat call with identical arguments writes a new
`checkedAt` and can replace `messages/` with mail that arrived since, so a client must not
retry it on the assumption that nothing further changes. The existing `download_email` and `download_attachment` definitions carry
`readOnlyHint: true` while writing files; changing them is outside this scope and is noted for
a separate fix. The definition goes after `batch_get_gmail_index_metadata` in
`toolDefinitions`.

## Error handling

- Zod rejects bad input before any API call; the handler's existing error path reports it.
- Profile lookup failure and a failure on the first page of the window listing propagate as
  thrown errors: nothing has succeeded yet.
- A failure on a later page of the window listing is recorded, `listingComplete` is false, and
  the run continues with the partial list; status is `incomplete`.
- Per-message `messages.get` failures and body-part failures are recorded and do not abort,
  except when `isAuthError` is true, in which case they rethrow.
- Cross-check listing failures are recorded as described above and do not abort, except when
  `isAuthError` is true, in which case they rethrow.
- Zod rejects bad input, and every auth failure rethrows, so the only three outcomes are: a
  thrown error (bad input, bad credentials, or nothing listed), a result with
  `status: 'truncated'`, or a result with `status` `ok` or `incomplete` and files on disk.
- Filesystem errors during writes propagate; a half-written `messages/` is acceptable because
  every run recreates it, and because step 6 removed `manifest.json` and
  `window-metadata.json` first, no stale metadata can describe it.
- Invariant: `manifest.json` exists in `output_dir` only when it was written, whole, by the
  run that produced the current `messages/` and `window-metadata.json`. Every throwing path
  after step 6 leaves it absent, because it is deleted in step 6 and published last by rename
  in step 10.

## Behaviour guarantees, stated explicitly

These are the decisions a consumer can rely on; each is pinned by a test.

1. **`belowBoundaryOrExcluded`** counts skipped messages directly (below the boundary, or
   labelled `SPAM`/`TRASH`). It is never derived from `listed - inWindow - failures.length`,
   because `failures` also holds `body-part-fetch` entries for messages that were still
   written, which would make a derived count wrong or negative.
2. **`<br>` conversion** in `htmlToText` matches `/<br\s*\/?>(?=.)/gi` without the `s` flag,
   so a `<br>` immediately followed by a newline is left alone and the literal newline stands.
   A test pins this so it cannot drift silently.
3. **Cross-check window set** is the listed window IDs, not the surviving ones, so a listed
   message whose fetch failed still counts as explained by the window and does not appear in
   `unexplainedIds`; it is reported through `failures` instead.
4. **Absolute `file` paths** in the manifest, built with `path.join(output_dir, 'messages',
   name)`, so a consumer can open a file without knowing the server's working directory.
5. **Deferred bodies** carry only `{ mimeType, attachmentId }`; no other field.
6. **Partial listing.** When a page after the first fails with a non-auth error, the run
   continues with the IDs collected so far, records `window-listing:page-<n>`, and reports
   `listingComplete: false` in both the manifest and the result. Only a first-page failure
   throws, because nothing has succeeded yet.
7. **Annotation.** `readOnlyHint` is false, `destructiveHint` is true, `idempotentHint` is
   false, for the reasons given under schema and registration.
8. **Authentication failures throw.** Any failure that `isAuthError` recognises, from the
   message loop, the body-part fetch, or the cross-check listings, rethrows; a run with dead
   or under-scoped credentials never ends as `incomplete`.
9. **Output publication.** Both metadata files are deleted before `messages/` is touched, and
   then `window-metadata.json` is published first and `manifest.json` last, each by writing
   `messages/.publish-<name>` and renaming it into place, so a failed run can never leave a
   stale manifest beside a fresh or partial `messages/`.
10. **Numbering width** is computed once per run as `Math.max(3, String(kept.length).length)`,
    so every file in a run has the same width (`001.json` … under 1000 messages;
    `0001.json` … `1000.json` at 1000 or more) and a lexical directory listing sorts by
    index.
11. **Cross-check listing failures** are recorded as `{ id: 'cross-check:<query>', error }`,
    the message files are kept, the manifest is written, and `status` is `'incomplete'`
    (auth failures still throw, per guarantee 8), because the files on disk are valid and only
    their verification is missing.
12. **`max_messages` and truncation.** Above the cap (default 2000) the tool downloads and
    writes nothing, leaves any previous `messages/`, `manifest.json` and
    `window-metadata.json` untouched, and returns `truncated: true` with the true `listed`
    count so the caller can choose a new cap or a nearer watermark.
13. **`cross_check` switch.** With `cross_check: false` the three listings are skipped and
    `crossCheck` is omitted from the result and the manifest.
14. **Result shape and location.** Output goes under the caller's `output_dir`; the MCP result
    is the manifest summary plus `triage` and `status` (`ok`, `incomplete`, `truncated`);
    `truncated`, `listingComplete` and `maxMessages` appear in both the result and the
    manifest.
15. **List request field mask.** Every `users.messages.list` call sends
    `fields: 'messages/id,nextPageToken'`, so the response carries only what the tool uses.
16. **Profile request field mask.** `getGmailEmailAddress` calls `users.getProfile` with
    `fields: 'emailAddress'`.

## Testing

`src/batch-fetch-window.test.ts` under vitest. The `gmail` argument is a plain object whose
`users.messages.list`, `users.messages.get`, `users.messages.attachments.get`, and
`users.getProfile` are `vi.fn()` implementations keyed on their arguments, in the style of
`src/gmail-batch.test.ts`. Each test writes into a fresh directory from
`fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-'))` and removes it afterwards. Cases:

1. Three-page listing with a duplicate ID across pages: `pages` is 3, the duplicate is
   fetched once.
2. Empty window: zero listed, both JSON files written with empty arrays, status `ok`.
3. Boundary: `internalDate === boundaryMs` is written; `boundaryMs - 1` is skipped and
   counted in `belowBoundaryOrExcluded`.
4. A window-listed message labelled `SPAM` is skipped.
5. One `messages.get` failure mid-run: the others are written, the failure is recorded with
   its status code, status is `incomplete`.
6. A large body delivered via `attachmentId` is fetched and appears in `body`.
7. HTML-only message yields plain text per the conversion rules (style stripped, `<br>` and
   block closers as newlines, anchor as `text [href]`, entities decoded, spaces collapsed).
8. Cross-check with one unexplained ID: `consistent` false, status `incomplete`.
9. `max_messages` exceeded across three pages: status `truncated`, no files written, an
   existing `messages/009.json` survives, `listed` is the full count across all pages, and no
   `messages.get` call was made.
10. Watermark without zone suffix is rejected by the schema.
11. Rerun replaces `messages/` completely: a stale `009.json` disappears.
12. Cross-check listing throws: entry `cross-check:<query>` recorded, status `incomplete`,
    message files still present.
13. More than 999 survivors: padding widens to four digits for every file.
14. Window listing throws on page two: the page-one IDs are fetched and written, the failure
    entry is `window-listing:page-2`, `listingComplete` is false in the manifest and the
    result, status is `incomplete`.
15. Window listing throws on page one: `batchFetchWindow` rejects and nothing is written.
16. Window listing throws on page three after the cap is already exceeded: status
    `incomplete`, `truncated: true`, `listingComplete: false`, the failure entry present,
    nothing written, existing `messages/` untouched.
17. A 401 on page two of the window listing rejects `batchFetchWindow`; nothing is written.
18. A 401 from `messages.get` mid-run rejects; `manifest.json` and `window-metadata.json`
    are absent, and `messages/` is empty because every `messages.get` completes before any
    message file is written; only a later body-part fetch can fail after some files exist,
    and no manifest exists in that case either (the caller re-runs).
19. A 401 from a deferred body fetch rejects.
20. A 401 from the spam cross-check listing rejects even though message files are on disk;
    `manifest.json` is absent so the run cannot be mistaken for complete.
21. `isAuthError` itself: true for status 401, for each listed reason string, for 403 with
    reason `insufficientPermissions`, and for 403 with an unlisted reason; false for 403 with
    each listed rate-limit reason, for 404, for 429, and for a plain `Error`.
21a. A 403 `insufficientPermissions` from `messages.get` mid-run rejects; `manifest.json` is
    absent.
22. Rerun failure with all three outputs already present from a previous successful run: a
    401 from `messages.get` on the second message rejects; afterwards `manifest.json` and
    `window-metadata.json` are absent and `messages/` exists but is empty, because the old
    content was removed in step 6 and no new file is written until every `messages.get` has
    completed.
23. Truncated rerun with all three outputs already present: all three remain byte-for-byte
    unchanged, because the truncation path returns before step 6.
24. Final-write failure: with `fs.writeFileSync` stubbed to throw on
    `messages/.publish-manifest.json`, `batchFetchWindow` rejects, `window-metadata.json`
    exists and is complete, `manifest.json` is absent, `output_dir` contains no entry other
    than `messages/` and `window-metadata.json`, and a second run against the same directory
    starts clean.
25. Final-write ordering: with `fs.writeFileSync` stubbed to throw on
    `messages/.publish-window-metadata.json`, the run rejects and neither metadata file
    exists.
26. Successful publish leaves no `.publish-` entries anywhere under `output_dir`.
27. Ownership: an unrelated caller file `output_dir/notes.txt` and an unrelated
    `output_dir/manifest.json.tmp-123` both survive a full run byte-for-byte.

`src/message-body.test.ts` covers `extractMessageParts` for each of the five part rules and
nesting, `htmlToText` for each regex line, and `resolveMessageBody` for deferred fetch
success, a 429 failure recorded as `{ code: 'body-part-fetch: 429', error }` with
`error.status === 429`, and 401 rethrown.

`src/gmail-sync.test.ts` also covers `toGmailRequestError` (status and reason extracted from
a googleapis-shaped error, pass-through of an existing instance, plain `Error` yielding
neither) and `failureCode` (`code` first, including a non-numeric `ECONNRESET`, then status,
then name; an error with only a `reason` renders as `Error`).

The handler body lives in `src/batch-fetch-window.ts` as
`handleBatchFetchWindow(gmail, args: unknown)`, which parses with `BatchFetchWindowSchema`,
calls `batchFetchWindow`, and wraps with `structuredResult`; `src/index.ts` only delegates to
it. The test suite exercises `handleBatchFetchWindow` directly (rejects bad input with a zod
error, returns `structuredContent` and matching `content[0].text` for a valid run), and the
smoke run exercises the real MCP dispatch through `dist/index.js` over stdio.

`src/gmail-sync.test.ts` (extended) covers `listAllGmailMessageIds`: unlimited three-page
run returns every ID with `hasMore: false`; `limit: 250` against a single page of 300 IDs
returns 250 with `hasMore: true` and requested `maxResults: 250`; `limit: 250` reached exactly
at a page boundary with a token present gives `hasMore: true`; `limit: 250` with 200 total IDs
gives `hasMore: false`; the second page requests `maxResults` equal to the remaining budget;
a non-auth throw on page two returns page-one IDs with `complete: false` and the error; a
401 on page two rejects; a throw on page one rejects. Existing cases stay unchanged.

The full existing suite must pass unchanged.

## Documentation

- README: add `batch_fetch_window` to the read-only tool list and to the structured index
  synchronisation table with its four inputs.
- `docs/gmail-cli-spec.md`: one line stating that the routine pass now uses
  `batch_fetch_window` and the CLIs remain optional for targeted reads.

## Definition of done

- Tool registered, typed, tested, documented; `npm test` and `npm run build` succeed; `dist/`
  rebuilt.
- Smoke run against the real mailbox with `output_dir` under a scratch directory and a
  watermark within the last day; the returned summary is pasted in the report with
  `emailAddress` replaced and the `triage` array replaced by its length, since triage lines
  carry senders and subjects. The status and, if `incomplete`, the `failures` and
  `crossCheck` fields are included as returned.
- The implementation report confirms each of the sixteen behaviour guarantees above by naming the test that pins it.
