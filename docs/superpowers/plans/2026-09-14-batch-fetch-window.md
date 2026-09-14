# `batch_fetch_window` Implementation Plan (reordered)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. This is mandatory, not a recommendation: `docs/gmail-batch-fetch-spec.md` records Sasha's instruction that the brainstorming, writing-plans and subagent-driven-development skills be followed in full. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one MCP tool, `batch_fetch_window`, that downloads every Gmail message received since a watermark into a caller-supplied directory with a manifest, window metadata, and a spam/trash/anywhere cross-check, so the PA repository can delete its direct-API script.

**Architecture:** Three new units. `src/message-body.ts` owns the MIME walk, deferred-body fetch and HTML-to-text rules copied from the reference script (done). `src/gmail-sync.ts` gained an error type, an auth-failure predicate, an exhaustive lister and a profile-address lookup (done). `src/batch-fetch-window.ts` orchestrates listing, fetching, filtering, atomic file publication and the cross-check, and returns a status the caller can trust; it is built up one behaviour per task with its own input and result types, unregistered. The last code task adds the zod schemas to `src/tools.ts`, the registry entry, the handler, the `src/index.ts` `case` and the docs, at which point the tool does everything its schema describes.

**Why this order (read before judging any task):** every commit is reviewed by a Codex pre-commit gate as a finished unit of work. The previous plan (`2026-09-11`) registered the schema and tool definition in Task 4, so each early commit *declared* behaviour (`max_messages`, `cross_check`, "deletes and recreates `messages/`", `truncated`, `failures`) that later tasks were still to implement, and the gate refused every such commit as half-done. The gate was right. This plan therefore obeys two rules. **A commit never declares, describes, types, registers or documents a behaviour it does not implement:** the module's input type gains `cross_check` in the task that honours it and `max_messages` in the task that enforces it; the result type gains `belowBoundaryOrExcluded`, `failures`, `status`, `crossCheck`, `truncated`, `maxMessages` and `listingComplete` only in the tasks that compute them; registration, the zod schemas, the README and the CLI-spec note wait for Task 12. **A commit never leaves a window in which its own outputs can lie:** the first version of the module already deletes the three paths it owns before any fetch and publishes `window-metadata.json` then `manifest.json` by atomic rename, so no commit can leave a stale manifest describing deleted or partial files; `status` is introduced together with the failures it reports, and the cross-check lands with its inconsistency and listing-failure handling in the same commit, so `status` is trustworthy in every commit that has one. An unregistered, tested module is a complete unit (Task 3's `src/message-body.ts` passed the gate the same way).

**Tech Stack:** TypeScript 5 (ES2020 modules, `strict`), `googleapis` Gmail v1 client, `zod` 3, `vitest` 4, Node `node:fs`/`node:path`. Tests run with `npx vitest run <file>`; the whole suite with `npm test`; build with `npm run build`. `tsconfig.json` excludes `src/**/*.test.ts` from `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md` (read it first; it explains every rule below and lists the sixteen deliberate deviations from the reference script that the final report must repeat).

## Global Constraints

- Do not change the behaviour, signature, or output schema of any existing tool or exported function. `listGmailMessageIds`, `getGmailProfile`, `extractEmailContent`, `extractAttachments`, `extractHeaders` stay exactly as they are.
- Do not add CLIs. Do not touch auth or scopes.
- Scopes for the new tool: `["gmail.readonly", "gmail.modify"]`. Annotations: `{ title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false }`.
- The tool owns exactly three things under `output_dir`: `messages/`, `manifest.json`, `window-metadata.json`. Nothing else is read, matched, or deleted there. All three are deleted before any fetch, in every version of the module from Task 4 on, with one exception: a truncated run (Task 10) returns before any filesystem operation and leaves all three as they were, so every public description of the tool (schema field, tool description, README) must say so rather than promise an unconditional replacement.
- `manifest.json` is written last, by atomic rename from `messages/.publish-manifest.json`, and `window-metadata.json` is written first, the same way. From Task 4 on.
- Every catch that records a failure and continues must first call `isAuthError` and rethrow when it is true.
- Message files are pretty-printed with two-space indentation and a trailing newline.
- **Commit policy:** each task ends in its own commit on `feat/batch-fetch-window` (the worktree branch; it is integrated into `experimental` at finish through finishing-a-development-branch). The Codex pre-commit gate reviews each commit as a finished unit; a gate finding is a defect to fix inside the same task, never a reason to bypass. `--no-verify`, `git commit -n`, `-F`, and every other bypass are banned by the repository hooks.
- **Honesty rule:** a commit never declares, describes, types, registers or documents a behaviour it does not implement, and never leaves a window in which its own outputs can misrepresent a run. Concretely: no zod schema, `toolDefinitions` entry, `index.ts` `case`, README or CLI-spec text before Task 12; no input field before the task that honours it; no result or manifest field before the task that computes it; no `status` value before the task that can produce it; no `status` that ignores a signal the same commit computes.
- Repository rules from `CLAUDE.md`: run the GitNexus `impact` tool on any existing function you modify before editing it, and run `detect_changes` before every commit. Bash rules: one command per call, no `&&`/`;`/`||`, no output redirection, single-line commit messages with `-m`.
- **Index freshness and impact analysis:** the name `Gmail-MCP-Server` is registered twice in GitNexus, for the main checkout (`/Users/sasha/Projects/Gmail-MCP-Server`, whose only indexed branch is `experimental`) and for this worktree. Resolving by name from the MCP server picks the main checkout, which does not contain this branch's symbols (verified on 2026-09-14: `impact` with `repo: "Gmail-MCP-Server", branch: "feat/batch-fetch-window"` answers `Branch "feat/batch-fetch-window" is not indexed for "Gmail-MCP-Server"`, and the CLI without `--branch` answers `Target 'resolveMessageBody' not found`). The worktree path with a pinned branch slot resolves them (verified the same day: `resolveMessageBody` found, `epistemic: "exact"`). So every task that edits an existing symbol first refreshes that slot and then measures the blast radius against it. Concretely, Tasks 5 to 12 each start with Step 0: run `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root (pins the checked-out tree into the `feat/batch-fetch-window` slot of this worktree's index), then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"` (CLI equivalent: `npx gitnexus impact batchFetchWindow --direction upstream --repo /Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window --branch feat/batch-fetch-window`), and record the callers and risk in the task report. A `Target … not found` answer means the refresh did not run or targeted the wrong index: fix that, never proceed on it. Until Task 12 the only caller is the test file, so LOW is expected; if HIGH or CRITICAL is reported, stop and report before editing. Task 12 additionally analyses `toolDefinitions` and `main`. `detect_changes` (same `repo` and `branch`) after the edit is not a substitute for `impact` before it.
- `failureCode` must reproduce the reference's `error.code || error.response?.status || error.name` exactly; body-part failure codes are `body-part-fetch: <code>` with a space after the colon, as in the reference.
- Use `Read`/`Edit`/`Write` for files, never shell readers or `sed`.
- Full existing suite (`npm test`) must pass after every task.
- Every test in Tasks 4 to 12 must be seen failing before the implementation step of its task, except the ones labelled "regression guard", whose reason for passing already is stated next to them. If any other test passes before its implementation step, stop: either the test is wrong or an earlier task over-implemented; say which in your report and fix it before continuing.

## Starting state

Tasks 1 to 3 are committed on `feat/batch-fetch-window` (`b22f5c5`, `0d00d7f`, `65402ab`). The working tree also holds an unstaged, uncommitted attempt at the old plan's Tasks 4, 5 and 16 (`src/tools.ts`, `src/index.ts`, `src/batch-fetch-window.ts`, `src/batch-fetch-window.test.ts`) that the gate refused. Before Task 4 starts, the controller discards those four paths so Task 4 begins from the committed tree:

```bash
git checkout -- src/tools.ts src/index.ts
rm src/batch-fetch-window.ts
rm src/batch-fetch-window.test.ts
```

The one genuine improvement from that attempt, calendar validation of the watermark (the old schema accepted `2026-02-30`), is carried into Task 12's schema code below. Unstaged one-line edits to `CLAUDE.md` and `AGENTS.md` are GitNexus symbol-count rewrites; leave them alone and never add them to a commit.

---

## Tasks 1 to 3: complete

Do not redo these. Later tasks consume the interfaces they produced.

- **Task 1** (`b22f5c5`, `src/gmail-sync.ts`): `class GmailRequestError extends Error { readonly code?: string; readonly status?: number; readonly reason?: string; readonly cause: unknown }`, `toGmailRequestError(error: unknown): GmailRequestError`, `failureCode(error: unknown): string`, `isAuthError(error: unknown): boolean`.
- **Task 2** (`0d00d7f`, `src/gmail-sync.ts`): `interface ListAllMessageIdsOptions { query: string; includeSpamTrash: boolean; limit?: number }`, `interface ListAllMessageIdsResult { ids: string[]; pages: number; hasMore: boolean; complete: boolean; error?: GmailRequestError }`, `listAllGmailMessageIds(gmail, options): Promise<ListAllMessageIdsResult>` (rethrows a first-page failure and any auth failure; returns `complete: false` with `error` set on a later-page non-auth failure), `getGmailEmailAddress(gmail): Promise<string>`.
- **Task 3** (`65402ab`, `src/message-body.ts`): `interface MessageHeader`, `interface MessagePart`, `interface MessageAttachment { filename; mimeType; size; attachmentId?; inlineBase64? }`, `interface ExtractedParts { text; html; attachments; deferredBodies }`, `interface BodyFailure { code: string; error: GmailRequestError }`, `interface ResolvedBody extends ExtractedParts { body: string; failures: BodyFailure[] }`, `decodeBase64Url`, `headerValue(headers, name): string`, `extractMessageParts(payload): ExtractedParts`, `htmlToText(html): string`, `resolveMessageBody(gmail, messageId, payload): Promise<ResolvedBody>` (rethrows auth failures; records other deferred-body failures as `body-part-fetch: <code>`).

---

## Tasks 4 to 11: growing `src/batch-fetch-window.ts` one behaviour at a time

Every task in this range follows the same shape: one or more RED/GREEN cycles, each of which appends one `describe` block to `src/batch-fetch-window.test.ts`, runs the file and sees the new block fail, changes `src/batch-fetch-window.ts` by exactly the blocks shown, and runs the file again to see everything pass; then, once per task, `npm test` and `npm run typecheck`, GitNexus `detect_changes`, and a single commit. A task with several cycles still ends in one commit, because only the finished task is an honest unit. Where a task also adds a test that already passes, it is labelled "regression guard" and the reason it passes already is stated.

The shared test helpers are written once in Task 4 and reused by every later block. The `run` helper's defaults grow with the input type: Task 9 adds `cross_check: true`, Task 10 adds `max_messages: 2000`.

---

### Task 4: Module core — listing, fetching, owned-path cleanup, and atomic publication of the three output files

**Files:**
- Create: `src/batch-fetch-window.ts`
- Create: `src/batch-fetch-window.test.ts`

**Interfaces:**
- Consumes: `getGmailEmailAddress`, `listAllGmailMessageIds` (Task 2); `extractMessageParts`, `headerValue`, `MessagePart`, `MessageHeader` (Task 3).
- Produces:
  - `interface BatchFetchWindowInput { watermark: string; output_dir: string }`
  - `interface BatchFetchWindowResult { checkedAt: string; emailAddress: string; watermark: string; boundaryMs: number; query: string; pages: number; listed: number; inWindow: number; triage: string[] }`
  - `async function batchFetchWindow(gmail: gmail_v1.Gmail, input: BatchFetchWindowInput, now?: () => Date): Promise<BatchFetchWindowResult>`
  - Private helpers `writeJson(target, value)` and `publishJson(messagesDir, target, value)`.
  - Test helpers at module scope of `src/batch-fetch-window.test.ts`: `WATERMARK`, `BOUNDARY`, `EPOCH`, `WINDOW_QUERY`, `SPAM_QUERY`, `TRASH_QUERY`, `ANYWHERE_QUERY`, `FIXED_NOW`, `b64`, `httpError`, `message`, `fakeGmail`, `windowOnly`, `run`, `readJson`.

This first version lists, fetches every listed ID, keeps all of them, writes plain-text bodies, and numbers with three digits. It already owns its outputs safely: before any fetch it removes exactly `manifest.json`, `window-metadata.json` and `messages/` and recreates `messages/`; after the message files it publishes `window-metadata.json` first and `manifest.json` last, each through `messages/.publish-<name>` and an atomic rename. A listing that stopped early is refused (thrown) before anything is deleted, because nothing in this version can report it; Task 11 replaces that with a recorded failure.

- [ ] **Step 1: Write the helpers and the failing tests**

Create `src/batch-fetch-window.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';

const WATERMARK = '2026-09-07T12:00:00Z';
const BOUNDARY = Date.parse(WATERMARK);
const EPOCH = Math.floor(BOUNDARY / 1000);
const WINDOW_QUERY = `after:${EPOCH - 1} -in:spam -in:trash`;
const SPAM_QUERY = `after:${EPOCH - 1} in:spam`;
const TRASH_QUERY = `after:${EPOCH - 1} in:trash`;
const ANYWHERE_QUERY = `after:${EPOCH - 1} in:anywhere`;
const FIXED_NOW = () => new Date('2026-09-11T12:00:00.000Z');

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function httpError(status: number, reason?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: reason ? { error: { errors: [{ reason }] } } : {} },
  });
}

type Page = { ids: string[] } | Error;
type FakeMessage = Record<string, unknown>;

function message(id: string, internalDate: number, extra: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(internalDate),
    labelIds: ['INBOX'],
    snippet: `snippet ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `${id}@example.com` },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
        { name: 'X-Other', value: 'dropped from metadata' },
      ],
      body: { data: b64(`body of ${id}`) },
    },
    ...extra,
  };
}

function fakeGmail(config: {
  lists: Record<string, Page[]>;
  messages?: Record<string, FakeMessage | Error>;
  attachments?: Record<string, string | Error>;
}) {
  const list = vi.fn(async (params: { q: string; pageToken?: string }) => {
    const pages = config.lists[params.q];
    if (!pages) throw new Error(`unexpected query ${params.q}`);
    const index = params.pageToken ? Number(params.pageToken.slice('page-'.length)) : 0;
    const page = pages[index];
    if (page instanceof Error) throw page;
    const next = index + 1 < pages.length ? `page-${index + 1}` : undefined;
    return { data: { messages: page.ids.map(id => ({ id })), ...(next ? { nextPageToken: next } : {}) } };
  });
  const get = vi.fn(async ({ id }: { id: string }) => {
    const found = config.messages?.[id];
    if (found === undefined) throw new Error(`unexpected message ${id}`);
    if (found instanceof Error) throw found;
    return { data: found };
  });
  const attachmentsGet = vi.fn(async ({ id }: { id: string }) => {
    const found = config.attachments?.[id];
    if (found === undefined) throw new Error(`unexpected attachment ${id}`);
    if (found instanceof Error) throw found;
    return { data: { data: found } };
  });
  const getProfile = vi.fn(async () => ({ data: { emailAddress: 'me@example.com' } }));
  return {
    users: { getProfile, messages: { list, get, attachments: { get: attachmentsGet } } },
    list,
    get,
    attachmentsGet,
  };
}

function windowOnly(ids: string[], extra: Partial<Record<string, Page[]>> = {}) {
  return {
    [WINDOW_QUERY]: [{ ids }],
    [SPAM_QUERY]: [{ ids: [] }],
    [TRASH_QUERY]: [{ ids: [] }],
    [ANYWHERE_QUERY]: [{ ids }],
    ...extra,
  };
}

function run(gmail: ReturnType<typeof fakeGmail>, dir: string, overrides: Partial<BatchFetchWindowInput> = {}) {
  return batchFetchWindow(gmail as never, {
    watermark: WATERMARK,
    output_dir: dir,
    ...overrides,
  }, FIXED_NOW);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('batchFetchWindow: listing, fetching and output files', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists three pages, deduplicates, fetches each ID once, and writes ordered files', async () => {
    const gmail = fakeGmail({
      lists: {
        [WINDOW_QUERY]: [{ ids: ['b', 'a'] }, { ids: ['a', 'c'] }, { ids: [] }],
      },
      messages: {
        a: message('a', BOUNDARY + 1000),
        b: message('b', BOUNDARY + 3000),
        c: message('c', BOUNDARY + 2000),
      },
    });
    const result = await run(gmail, dir);

    expect(result.pages).toBe(3);
    expect(result.listed).toBe(3);
    expect(result.inWindow).toBe(3);
    expect(gmail.get).toHaveBeenCalledTimes(3);
    expect(gmail.get).toHaveBeenCalledWith({ userId: 'me', id: 'a', format: 'full' });
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual(['001.json', '002.json', '003.json']);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('a');
    expect(readJson(path.join(dir, 'messages', '002.json')).id).toBe('c');
    expect(readJson(path.join(dir, 'messages', '003.json')).id).toBe('b');
    expect(result.triage).toEqual([
      `${path.join(dir, 'messages', '001.json')} | a@example.com | Subject a | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '002.json')} | c@example.com | Subject c | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
      `${path.join(dir, 'messages', '003.json')} | b@example.com | Subject b | Mon, 07 Sep 2026 14:00:00 +0000 | 0 att`,
    ]);
  });

  it('writes the reference shapes for the message file and window metadata, and lists the file in the manifest', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1000, { labelIds: ['INBOX', 'UNREAD'] }) },
    });
    const result = await run(gmail, dir);
    const file = path.join(dir, 'messages', '001.json');
    const raw = fs.readFileSync(file, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
    expect(JSON.parse(raw)).toEqual({
      id: 'a',
      threadId: 't-a',
      internalDate: String(BOUNDARY + 1000),
      labelIds: ['INBOX', 'UNREAD'],
      from: 'a@example.com',
      to: 'me@example.com',
      cc: '',
      subject: 'Subject a',
      dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
      snippet: 'snippet a',
      attachments: [],
      body: 'body of a',
    });

    expect(readJson(path.join(dir, 'window-metadata.json'))).toEqual({
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      messages: [{
        id: 'a',
        internalDate: String(BOUNDARY + 1000),
        labelIds: ['INBOX', 'UNREAD'],
        headers: [
          { name: 'From', value: 'a@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Subject', value: 'Subject a' },
          { name: 'Date', value: 'Mon, 07 Sep 2026 14:00:00 +0000' },
        ],
      }],
    });

    const manifest = readJson(path.join(dir, 'manifest.json'));
    expect(manifest.messages).toEqual([{
      file,
      id: 'a',
      internalDate: String(BOUNDARY + 1000),
      labelIds: ['INBOX', 'UNREAD'],
      from: 'a@example.com',
      subject: 'Subject a',
      dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
      attachments: 0,
    }]);
    expect(path.isAbsolute(manifest.messages[0].file)).toBe(true);
    const summary = {
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      query: WINDOW_QUERY,
      pages: 1,
      listed: 1,
      inWindow: 1,
    };
    expect(manifest).toMatchObject(summary);
    expect(result).toMatchObject(summary);
  });

  it('handles an empty window with empty files', async () => {
    const gmail = fakeGmail({ lists: windowOnly([]) });
    const result = await run(gmail, dir);

    expect(result.listed).toBe(0);
    expect(result.inWindow).toBe(0);
    expect(result.triage).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
    expect(readJson(path.join(dir, 'manifest.json')).messages).toEqual([]);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toEqual([]);
  });

  it('rejects when the first window page fails and writes nothing', async () => {
    const failure = new Error('network down');
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [failure] } });
    await expect(run(gmail, dir)).rejects.toBe(failure);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects when a later window page fails and writes nothing', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a'] }, httpError(503)] } });
    await expect(run(gmail, dir)).rejects.toMatchObject({ name: 'GmailRequestError', status: 503 });
    expect(gmail.get).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, cannot resolve `./batch-fetch-window.js`.

- [ ] **Step 3: Create the module with the listing, fetching and writing flow**

Create `src/batch-fetch-window.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { getGmailEmailAddress, listAllGmailMessageIds } from './gmail-sync.js';
import { extractMessageParts, headerValue, type MessageHeader, type MessagePart } from './message-body.js';

export interface BatchFetchWindowInput {
  // ISO 8601 timestamp with an explicit zone; the window is inclusive of this instant.
  watermark: string;
  // Absolute directory that receives messages/, manifest.json and window-metadata.json.
  output_dir: string;
}

export interface BatchFetchWindowResult {
  checkedAt: string;
  emailAddress: string;
  watermark: string;
  boundaryMs: number;
  query: string;
  pages: number;
  listed: number;
  inWindow: number;
  triage: string[];
}

type KeptMessage = {
  data: gmail_v1.Schema$Message;
  internal: number;
  labels: string[];
};

type ManifestEntry = {
  file: string;
  id: string;
  internalDate: string | null | undefined;
  labelIds: string[];
  from: string;
  subject: string;
  dateHeader: string;
  attachments: number;
};

const METADATA_HEADERS = new Set(['From', 'To', 'Subject', 'Date']);

function writeJson(target: string, value: unknown): void {
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

export async function batchFetchWindow(
  gmail: gmail_v1.Gmail,
  input: BatchFetchWindowInput,
  now: () => Date = () => new Date(),
): Promise<BatchFetchWindowResult> {
  const boundaryMs = Date.parse(input.watermark);
  const epoch = Math.floor(boundaryMs / 1000);
  const windowQuery = `after:${epoch - 1} -in:spam -in:trash`;

  const emailAddress = await getGmailEmailAddress(gmail);
  const windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true });
  // A listing that stopped early cannot be reported by this result, so it is refused
  // rather than passed off as a complete window.
  if (!windowList.complete && windowList.error) {
    throw windowList.error;
  }

  const base = {
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowList.ids.length,
  };

  const outputDir = input.output_dir;
  const messagesDir = path.join(outputDir, 'messages');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const windowMetadataPath = path.join(outputDir, 'window-metadata.json');
  fs.mkdirSync(messagesDir, { recursive: true });

  const kept: KeptMessage[] = [];
  for (const id of windowList.ids) {
    const data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    kept.push({ data, internal: Number(data.internalDate), labels: data.labelIds ?? [] });
  }

  kept.sort((left, right) => left.internal - right.internal);
  const width = 3;
  const manifestMessages: ManifestEntry[] = [];
  const metadataMessages: Array<Record<string, unknown>> = [];

  for (const [index, { data, labels }] of kept.entries()) {
    const id = data.id ?? '';
    const headers = (data.payload?.headers ?? []) as MessageHeader[];
    const parts = extractMessageParts(data.payload as MessagePart | undefined);
    const body = parts.text.trim();
    const attachments = parts.attachments;
    const from = headerValue(headers, 'From');
    const subject = headerValue(headers, 'Subject');
    const dateHeader = headerValue(headers, 'Date');
    const file = path.join(messagesDir, `${String(index + 1).padStart(width, '0')}.json`);
    writeJson(file, {
      id,
      threadId: data.threadId,
      internalDate: data.internalDate,
      labelIds: labels,
      from,
      to: headerValue(headers, 'To'),
      cc: headerValue(headers, 'Cc'),
      subject,
      dateHeader,
      snippet: data.snippet ?? '',
      attachments,
      body,
    });
    manifestMessages.push({
      file,
      id,
      internalDate: data.internalDate,
      labelIds: labels,
      from,
      subject,
      dateHeader,
      attachments: attachments.length,
    });
    metadataMessages.push({
      id,
      internalDate: data.internalDate,
      labelIds: labels,
      headers: headers.filter(header => METADATA_HEADERS.has(header.name ?? '')),
    });
  }

  // Stamped after every fetch, immediately before publication, as the reference does.
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
  };

  writeJson(windowMetadataPath, {
    checkedAt: summary.checkedAt,
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    messages: metadataMessages,
  });
  writeJson(manifestPath, { ...summary, messages: manifestMessages });

  const triage = manifestMessages.map(entry =>
    [entry.file, entry.from, entry.subject, entry.dateHeader, `${entry.attachments} att`].join(' | ')
  );
  return { ...summary, triage };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing owned-path and publication tests**

Append to `src/batch-fetch-window.test.ts`:

```ts
describe('batchFetchWindow: owned paths and atomic publication', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('replaces messages/ completely on rerun', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await run(gmail, dir);

    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['001.json']);
  });

  it('clears old outputs before a rerun that then fails part-way', async () => {
    const first = fakeGmail({ lists: windowOnly(['old']), messages: { old: message('old', BOUNDARY + 1) } });
    await run(first, dir);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);

    const unauthorised = httpError(401);
    const second = fakeGmail({
      lists: windowOnly(['a', 'b']),
      messages: { a: message('a', BOUNDARY + 1), b: unauthorised },
    });
    await expect(run(second, dir)).rejects.toBe(unauthorised);

    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    // Every fetch completes before any message file is written, so the failed rerun leaves
    // messages/ present but empty: the old content was removed, and nothing new was written.
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
  });

  it('leaves window-metadata but no manifest when the manifest publish fails', async () => {
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.publish-manifest.json')) throw new Error('disk full');
      return original(file, data, options);
    });
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(true);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['messages', 'window-metadata.json']);

    vi.restoreAllMocks();
    const again = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(again, dir);
    expect(result.inWindow).toBe(1);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });

  it('leaves neither metadata file when the window-metadata publish fails', async () => {
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.publish-window-metadata.json')) throw new Error('disk full');
      return original(file, data, options);
    });
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await expect(run(gmail, dir)).rejects.toThrow('disk full');

    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // Regression guard: passes already, because Step 3 touches nothing outside the three owned
  // paths; it protects that property against the deletions Step 7 adds.
  it('leaves no publish temporaries and never touches unrelated caller files', async () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp-123'), 'also keep me');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await run(gmail, dir);

    expect(fs.readdirSync(dir).sort()).toEqual(['manifest.json', 'manifest.json.tmp-123', 'messages', 'notes.txt', 'window-metadata.json']);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(dir, 'manifest.json.tmp-123'), 'utf8')).toBe('also keep me');
    expect(fs.readdirSync(path.join(dir, 'messages')).filter(name => name.startsWith('.publish-'))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the test file to verify the new block fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on four of the five new cases: the stale `009.json` survives the rerun; the old `manifest.json` survives the failed rerun; the two publish-failure cases never throw `disk full` because no `.publish-` temporary is written, so `manifest.json` exists when it must not, and in the second of them `window-metadata.json` exists when it must not. The ownership guard passes. The five Step 1 tests still pass.

Known subtlety: `vi.spyOn(fs, 'writeFileSync')` works because both the test and the module import the same default `fs` object from `node:fs`. If the spy does not intercept after Step 7, check that `src/batch-fetch-window.ts` uses `import fs from 'node:fs'` and calls `fs.writeFileSync`, not a destructured import.

- [ ] **Step 7: Delete the owned paths first and publish by rename**

In `src/batch-fetch-window.ts`, add below the `writeJson` helper:

```ts
// Publish through a temporary file inside messages/ (which the tool owns) and an atomic
// rename, so a reader never sees a partial metadata file and a failed write leaves only a
// temporary that the next run's cleanup of messages/ removes.
function publishJson(messagesDir: string, target: string, value: unknown): void {
  const temporary = path.join(messagesDir, `.publish-${path.basename(target)}`);
  writeJson(temporary, value);
  fs.renameSync(temporary, target);
}
```

Replace

```ts
  fs.mkdirSync(messagesDir, { recursive: true });
```

with

```ts
  // Remove exactly the three paths the tool owns, metadata first, so that from here until
  // the final publish no manifest exists that could describe deleted or partial files.
  // Nothing else under output_dir is read, matched or deleted.
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(windowMetadataPath, { force: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
```

Replace

```ts
  writeJson(windowMetadataPath, {
```

with

```ts
  publishJson(messagesDir, windowMetadataPath, {
```

and

```ts
  writeJson(manifestPath, { ...summary, messages: manifestMessages });
```

with

```ts
  publishJson(messagesDir, manifestPath, { ...summary, messages: manifestMessages });
```

Message files keep using `writeJson` directly.

- [ ] **Step 8: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 9: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 10: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`). Expected: one new module plus its test; no existing symbol changed.

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Add batchFetchWindow core: list a window, fetch messages, publish owned output files atomically"
```

---

### Task 5: Boundary and label filtering

**Files:**
- Modify: `src/batch-fetch-window.ts` (the result interface, the fetch loop, the `summary` block)
- Test: `src/batch-fetch-window.test.ts` (append)

**Interfaces:**
- Produces: `belowBoundaryOrExcluded: number` on `BatchFetchWindowResult` and in `manifest.json`.

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('batchFetchWindow: boundary and label filtering', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('includes the exact boundary and excludes one millisecond before it', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['on', 'before']),
      messages: { on: message('on', BOUNDARY), before: message('before', BOUNDARY - 1) },
    });
    const result = await run(gmail, dir);

    expect(result.inWindow).toBe(1);
    expect(result.belowBoundaryOrExcluded).toBe(1);
    expect(readJson(path.join(dir, 'manifest.json')).belowBoundaryOrExcluded).toBe(1);
    expect(readJson(path.join(dir, 'messages', '001.json')).id).toBe('on');
  });

  it('skips a listed message labelled SPAM', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['s', 'a']),
      messages: {
        s: message('s', BOUNDARY + 1, { labelIds: ['SPAM'] }),
        a: message('a', BOUNDARY + 2),
      },
    });
    const result = await run(gmail, dir);

    expect(result.inWindow).toBe(1);
    expect(result.belowBoundaryOrExcluded).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['001.json']);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on both new cases: `inWindow` is 2 and `belowBoundaryOrExcluded` is `undefined`.

- [ ] **Step 3: Filter by boundary and label**

In `src/batch-fetch-window.ts`, in `BatchFetchWindowResult`, add directly after the line `  inWindow: number;`:

```ts
  belowBoundaryOrExcluded: number;
```

Replace

```ts
  const kept: KeptMessage[] = [];
  for (const id of windowList.ids) {
    const data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    kept.push({ data, internal: Number(data.internalDate), labels: data.labelIds ?? [] });
  }
```

with

```ts
  const kept: KeptMessage[] = [];
  let belowBoundaryOrExcluded = 0;
  for (const id of windowList.ids) {
    const data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    const internal = Number(data.internalDate);
    const labels = data.labelIds ?? [];
    if (internal < boundaryMs || labels.includes('SPAM') || labels.includes('TRASH')) {
      belowBoundaryOrExcluded += 1;
      continue;
    }
    kept.push({ data, internal, labels });
  }
```

Replace

```ts
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
  };
```

with

```ts
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
  };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Filter batchFetchWindow messages by boundary and spam or trash labels"
```

---

### Task 6: Body resolution

**Files:**
- Modify: `src/batch-fetch-window.ts` (imports and the write loop)
- Test: `src/batch-fetch-window.test.ts` (append)

**Interfaces:**
- Consumes: `resolveMessageBody` (Task 3).

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('batchFetchWindow: body resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('fetches a large body delivered through attachmentId', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@example.com' }],
            body: { attachmentId: 'big', size: 9 },
          },
        }),
      },
      attachments: { big: b64('the large body') },
    });
    await run(gmail, dir);

    expect(gmail.attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'a', id: 'big' });
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('the large body');
  });

  it('converts an HTML-only message to plain text with the reference rules', async () => {
    const html = '<style>p{}</style><p>Hello<br>there</p><a href="https://x.test">link</a>&amp;&nbsp;done';
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'From', value: 'a@example.com' }],
            body: { data: b64(html) },
          },
        }),
      },
    });
    await run(gmail, dir);

    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('Hello\nthere\nlink [https://x.test]& done');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on both: `body` is `''` because Task 4 uses only the inline plain-text part.

- [ ] **Step 3: Use `resolveMessageBody`**

In `src/batch-fetch-window.ts`, change the `./message-body.js` import to:

```ts
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
```

and replace

```ts
    const parts = extractMessageParts(data.payload as MessagePart | undefined);
    const body = parts.text.trim();
    const attachments = parts.attachments;
```

with

```ts
    const resolved = await resolveMessageBody(gmail, id, data.payload as MessagePart | undefined);
    const body = resolved.body;
    const attachments = resolved.attachments;
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Resolve deferred and HTML bodies in batchFetchWindow"
```

---

### Task 7: Numbering width

**Files:**
- Modify: `src/batch-fetch-window.ts` (`width`)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe('batchFetchWindow: numbering width', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('widens padding to four digits when more than 999 messages survive', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `m${index}`);
    const messages = Object.fromEntries(ids.map((id, index) => [id, message(id, BOUNDARY + index)]));
    const gmail = fakeGmail({ lists: windowOnly(ids), messages });
    await run(gmail, dir);

    const files = fs.readdirSync(path.join(dir, 'messages')).sort();
    expect(files).toHaveLength(1000);
    expect(files[0]).toBe('0001.json');
    expect(files[999]).toBe('1000.json');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL: the thousandth file is `1000.json` next to `001.json` so `files[0]` is `001.json`.

- [ ] **Step 3: Widen the padding**

In `src/batch-fetch-window.ts`, replace

```ts
  const width = 3;
```

with

```ts
  const width = Math.max(3, String(kept.length).length);
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS. The 1000-message case takes a few seconds; that is expected.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Widen batchFetchWindow file numbering above 999 messages"
```

---

### Task 8: Per-message and body-part failures, with authentication failures rethrown

**Files:**
- Modify: `src/batch-fetch-window.ts` (imports, result interface, the fetch loop, the write loop, the `summary` block, the return)
- Test: `src/batch-fetch-window.test.ts` (append)

**Interfaces:**
- Consumes: `failureCode`, `isAuthError` (Task 1); `ResolvedBody.failures` (Task 3).
- Produces: `type Failure = { id: string; error: string }`; `failures: Failure[]` and `status: 'ok' | 'incomplete'` on `BatchFetchWindowResult`; `failures` in `manifest.json`.

This task introduces the first tolerant `catch` in the module, so it also introduces the rule that every tolerant catch calls `isAuthError` first and rethrows; the two never ship apart. It also introduces `status`, derived from the only signal that exists at this point: the `failures` array.

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('batchFetchWindow: per-message failures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records one messages.get failure with its status and still writes the rest', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'bad', 'c']),
      messages: { a: message('a', BOUNDARY + 1), bad: httpError(500), c: message('c', BOUNDARY + 2) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: 'bad', error: '500' }]);
    expect(result.inWindow).toBe(2);
    expect(result.belowBoundaryOrExcluded).toBe(0);
    expect(readJson(path.join(dir, 'manifest.json')).failures).toEqual([{ id: 'bad', error: '500' }]);
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual(['001.json', '002.json']);
  });

  it('reports status ok with no failures for a clean run', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
  });

  it('rejects on a 401 from messages.get and leaves no files', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a', 'b']),
      messages: { a: message('a', BOUNDARY + 1), b: unauthorised },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'window-metadata.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
  });

  it('rejects on a 403 insufficientPermissions from messages.get', async () => {
    const forbidden = httpError(403, 'insufficientPermissions');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: forbidden } });
    await expect(run(gmail, dir)).rejects.toBe(forbidden);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  // Regression guard: passes already, because Task 2's lister rethrows auth errors on any page.
  it('rejects on a 401 on window page two and writes nothing', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a'] }, unauthorised] } });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first two: the 500 case rejects with `HTTP 500` because the fetch loop has no catch; the clean-run case finds `status` and `failures` `undefined`. The 401 and 403 `messages.get` cases pass at this point only because there is no catch yet; they exist to fail the moment Step 3 adds a catch without the `isAuthError` rethrow, so keep them and confirm they still pass after Step 3. The page-two guard passes.

- [ ] **Step 3: Record `messages.get` failures, rethrow auth failures, and derive the status**

In `src/batch-fetch-window.ts`, change the `./gmail-sync.js` import to:

```ts
import { failureCode, getGmailEmailAddress, isAuthError, listAllGmailMessageIds } from './gmail-sync.js';
```

Add directly above `export interface BatchFetchWindowResult {`:

```ts
type Failure = { id: string; error: string };

```

In `BatchFetchWindowResult`, add directly after the opening line `export interface BatchFetchWindowResult {`:

```ts
  status: 'ok' | 'incomplete';
```

and directly before the line `  triage: string[];`:

```ts
  failures: Failure[];
```

Directly after the line `  const emailAddress = await getGmailEmailAddress(gmail);` add:

```ts
  const failures: Failure[] = [];
```

Replace the fetch loop head

```ts
  for (const id of windowList.ids) {
    const data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    const internal = Number(data.internalDate);
```

with

```ts
  for (const id of windowList.ids) {
    let data: gmail_v1.Schema$Message;
    try {
      data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push({ id, error: failureCode(error) });
      continue;
    }
    const internal = Number(data.internalDate);
```

In the `summary` object, add the line `    failures,` directly after `    belowBoundaryOrExcluded,`.

Replace the final `return { ...summary, triage };` with:

```ts
  const status = failures.length > 0 ? 'incomplete' : 'ok';
  return { ...summary, status, triage };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS, including the 401 and 403 `messages.get` cases.

- [ ] **Step 5: Write the failing body-part failure tests**

Append:

```ts
describe('batchFetchWindow: body-part failures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('records a body-part failure by code and still writes the message', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: {
        a: message('a', BOUNDARY + 1, {
          payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'big' } },
        }),
      },
      attachments: { big: httpError(429) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: 'a', error: 'body-part-fetch: 429' }]);
    expect(readJson(path.join(dir, 'messages', '001.json')).body).toBe('');
  });

  // Regression guard: passes already, because Task 3's resolveMessageBody rethrows auth errors.
  it('rejects on a 401 from a deferred body fetch', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1, { payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'big' } } }) },
      attachments: { big: unauthorised },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
  });
});
```

- [ ] **Step 6: Run the test file to verify the new block fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on "records a body-part failure…": `status` is `ok` and `failures` is empty, because `resolveMessageBody` recorded the failure but the module does not yet copy it. The guard passes.

- [ ] **Step 7: Record body-part failures**

In the write loop of `src/batch-fetch-window.ts`, directly after the `const resolved = await resolveMessageBody(...)` line add:

```ts
    for (const failure of resolved.failures) {
      failures.push({ id, error: failure.code });
    }
```

- [ ] **Step 8: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 10: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Record per-message and body-part failures in batchFetchWindow and rethrow auth failures"
```

---

### Task 9: The cross-check, complete: switch, consistency, and tolerated listing failures

**Files:**
- Modify: `src/batch-fetch-window.ts` (input and result interfaces, new `crossCheckListing` helper, the `summary` block, the status)
- Test: `src/batch-fetch-window.test.ts` (the `run` helper; append)

**Interfaces:**
- Consumes: `Failure`, `failures`, `failureCode`, `isAuthError` (Task 8).
- Produces: `cross_check: boolean` on `BatchFetchWindowInput`; `interface CrossCheck { window: number; spam: number; trash: number; anywhere: number; unexplainedIds: string[]; consistent: boolean }`; `crossCheck?: CrossCheck` on `BatchFetchWindowResult` and in `manifest.json`; `cross-check:<query>` failure entries; `status` now also reflects `crossCheck.consistent`.

The cross-check lands whole in one commit: the switch, the counts, the fold of `consistent: false` into `status`, and the tolerant-with-`isAuthError` handling of its three listings (including a partial listing, whose `complete: false` and `error` are recorded rather than accepted). A commit with a cross-check whose inconsistency or failure did not reach `status` would report `ok` for an unverified window.

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Extend the `run` helper and write the failing tests**

In `src/batch-fetch-window.test.ts`, in the `run` helper, add the line `    cross_check: true,` directly after `    output_dir: dir,`.

Append:

```ts
describe('batchFetchWindow: cross-check', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists spam, trash and anywhere and reports a consistent cross-check in the result and the manifest', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(gmail, dir);

    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: SPAM_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: TRASH_QUERY, includeSpamTrash: true }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: ANYWHERE_QUERY, includeSpamTrash: true }));
    const expected = { window: 1, spam: 0, trash: 0, anywhere: 1, unexplainedIds: [], consistent: true };
    expect(result.status).toBe('ok');
    expect(result.crossCheck).toEqual(expected);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toEqual(expected);
  });

  // Regression guard: passes already, because nothing lists spam, trash or anywhere before
  // Step 3; it fails the moment Step 3 runs those listings without honouring cross_check.
  it('skips the cross-check when disabled', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: [] }] } });
    const result = await run(gmail, dir, { cross_check: false });

    expect(result.status).toBe('ok');
    expect(result.crossCheck).toBeUndefined();
    expect(gmail.list).toHaveBeenCalledTimes(1);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on "lists spam, trash and anywhere…" at the first `list` call assertion. The disabled-switch guard passes.

- [ ] **Step 3: Add the switch and the counts**

In `src/batch-fetch-window.ts`, in `BatchFetchWindowInput`, add directly after the line `  output_dir: string;`:

```ts
  // Also list spam, trash and in:anywhere since the watermark to detect silently dropped messages.
  cross_check: boolean;
```

Add directly above `type Failure = { id: string; error: string };`:

```ts
export interface CrossCheck {
  window: number;
  spam: number;
  trash: number;
  anywhere: number;
  unexplainedIds: string[];
  consistent: boolean;
}

```

In `BatchFetchWindowResult`, add directly after the line `  failures: Failure[];`:

```ts
  crossCheck?: CrossCheck;
```

Replace

```ts
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
  };
```

with

```ts
  let crossCheck: CrossCheck | undefined;
  if (input.cross_check) {
    const spam = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:spam`, includeSpamTrash: true })).ids);
    const trash = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:trash`, includeSpamTrash: true })).ids);
    const anywhere = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:anywhere`, includeSpamTrash: true })).ids);
    const windowIds = new Set(windowList.ids);
    const unexplainedIds = [...anywhere].filter(id => !windowIds.has(id) && !spam.has(id) && !trash.has(id));
    crossCheck = {
      window: windowList.ids.length,
      spam: spam.size,
      trash: trash.size,
      anywhere: anywhere.size,
      unexplainedIds,
      consistent: unexplainedIds.length === 0,
    };
  }

  // Stamped after every fetch and check, immediately before publication, as the reference does.
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
    ...(crossCheck ? { crossCheck } : {}),
  };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing outcome tests**

Append:

```ts
describe('batchFetchWindow: cross-check outcomes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('flags an unexplained anywhere ID as inconsistent', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [ANYWHERE_QUERY]: [{ ids: ['a', 'ghost'] }] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.crossCheck).toEqual({ window: 1, spam: 0, trash: 0, anywhere: 2, unexplainedIds: ['ghost'], consistent: false });
    expect(result.failures).toEqual([]);
  });

  it('records a cross-check listing failure and keeps the message files', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [SPAM_QUERY]: [httpError(503)] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: `cross-check:${SPAM_QUERY}`, error: '503' }]);
    expect(result.crossCheck?.spam).toBe(0);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  it('reports the network error code for a later cross-check page failure', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [TRASH_QUERY]: [{ ids: [] }, reset] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.failures).toEqual([{ id: `cross-check:${TRASH_QUERY}`, error: 'ECONNRESET' }]);
  });

  // Passes at this point only because Step 3's listings have no catch, so the 401 propagates;
  // it exists to fail the moment Step 7 adds a catch without the isAuthError rethrow.
  it('rejects on a 401 from the spam cross-check and leaves no manifest', async () => {
    const unauthorised = httpError(401);
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [SPAM_QUERY]: [unauthorised] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    await expect(run(gmail, dir)).rejects.toBe(unauthorised);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test file to verify the new block fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first three: "flags an unexplained anywhere ID…" reports `status` `ok` because the status ignores `crossCheck.consistent`; "records a cross-check listing failure…" rejects with `HTTP 503` because the listings have no catch; "reports the network error code…" reports `status` `ok` with empty `failures` because a partial cross-check listing is silently accepted. The 401 case passes, for the reason stated next to it; keep it and confirm it still passes after Step 7.

- [ ] **Step 7: Tolerate cross-check listing failures, rethrow auth failures, and fold consistency into the status**

In `src/batch-fetch-window.ts`, add directly above `export async function batchFetchWindow`:

```ts
async function crossCheckListing(
  gmail: gmail_v1.Gmail,
  query: string,
  failures: Failure[],
): Promise<Set<string>> {
  try {
    const result = await listAllGmailMessageIds(gmail, { query, includeSpamTrash: true });
    if (!result.complete && result.error) {
      failures.push({ id: `cross-check:${query}`, error: failureCode(result.error) });
    }
    return new Set(result.ids);
  } catch (error) {
    if (isAuthError(error)) {
      throw error;
    }
    failures.push({ id: `cross-check:${query}`, error: failureCode(error) });
    return new Set();
  }
}

```

Replace the three lines

```ts
    const spam = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:spam`, includeSpamTrash: true })).ids);
    const trash = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:trash`, includeSpamTrash: true })).ids);
    const anywhere = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:anywhere`, includeSpamTrash: true })).ids);
```

with

```ts
    const spam = await crossCheckListing(gmail, `after:${epoch - 1} in:spam`, failures);
    const trash = await crossCheckListing(gmail, `after:${epoch - 1} in:trash`, failures);
    const anywhere = await crossCheckListing(gmail, `after:${epoch - 1} in:anywhere`, failures);
```

Replace

```ts
  const status = failures.length > 0 ? 'incomplete' : 'ok';
```

with

```ts
  const status = failures.length > 0 || (crossCheck !== undefined && !crossCheck.consistent)
    ? 'incomplete'
    : 'ok';
```

- [ ] **Step 8: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS, including the 401 case.

- [ ] **Step 9: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 10: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Add the optional spam, trash and anywhere cross-check to batchFetchWindow with failure handling"
```

---

### Task 10: Truncation above `max_messages`

**Files:**
- Modify: `src/batch-fetch-window.ts` (input and result interfaces, `base`, a new early return after `base`, the `summary` block)
- Test: `src/batch-fetch-window.test.ts` (the `run` helper; append)

**Interfaces:**
- Produces: `max_messages: number` on `BatchFetchWindowInput`; `truncated: boolean`, `maxMessages: number` and the `'truncated'` status on `BatchFetchWindowResult`; `truncated` and `maxMessages` in `manifest.json`.

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Extend the `run` helper and write the failing tests**

In `src/batch-fetch-window.test.ts`, in the `run` helper, add the line `    max_messages: 2000,` directly after `    cross_check: true,`.

Append:

```ts
describe('batchFetchWindow: truncation', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('truncates across three pages without fetching or writing anything', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
    const gmail = fakeGmail({
      lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }, { ids: ['c', 'd'] }, { ids: ['e'] }] },
    });
    const result = await run(gmail, dir, { max_messages: 4 });

    expect(result.status).toBe('truncated');
    expect(result.truncated).toBe(true);
    expect(result.maxMessages).toBe(4);
    expect(result.listed).toBe(5);
    expect(result.pages).toBe(3);
    expect(result.inWindow).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.triage).toEqual([]);
    expect(result.crossCheck).toBeUndefined();
    expect(gmail.get).not.toHaveBeenCalled();
    expect(gmail.list).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['009.json']);
  });

  it('leaves all three previous outputs untouched on a truncated rerun', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '001.json'), 'old message');
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'old manifest');
    fs.writeFileSync(path.join(dir, 'window-metadata.json'), 'old metadata');
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }] } });
    await run(gmail, dir, { max_messages: 1 });

    expect(fs.readFileSync(path.join(dir, 'messages', '001.json'), 'utf8')).toBe('old message');
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe('old manifest');
    expect(fs.readFileSync(path.join(dir, 'window-metadata.json'), 'utf8')).toBe('old metadata');
  });

  it('reports truncated false and the cap in the result and the manifest when under the cap', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await run(gmail, dir, { max_messages: 1 });

    expect(result.truncated).toBe(false);
    expect(result.maxMessages).toBe(1);
    expect(readJson(path.join(dir, 'manifest.json'))).toMatchObject({ truncated: false, maxMessages: 1 });
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on all three: the first throws `unexpected message a` because the tool tries to fetch; the second replaces the old files; the third finds `truncated` and `maxMessages` `undefined`.

- [ ] **Step 3: Stop at the cap**

In `src/batch-fetch-window.ts`, in `BatchFetchWindowInput`, add directly after the `cross_check: boolean;` line:

```ts
  // Hard cap on listed IDs; above it nothing is downloaded and the result is truncated.
  max_messages: number;
```

In `BatchFetchWindowResult`, replace

```ts
  status: 'ok' | 'incomplete';
```

with

```ts
  status: 'ok' | 'incomplete' | 'truncated';
```

and add directly after the line `  belowBoundaryOrExcluded: number;`:

```ts
  truncated: boolean;
  maxMessages: number;
```

In the `base` object, add the line `    maxMessages: input.max_messages,` directly after `    listed: windowList.ids.length,`.

Insert directly after the `const base = { … };` object and before `const outputDir = input.output_dir;`:

```ts
  if (windowList.ids.length > input.max_messages) {
    return {
      checkedAt: now().toISOString(),
      ...base,
      status: 'truncated',
      truncated: true,
      inWindow: 0,
      belowBoundaryOrExcluded: 0,
      failures,
      triage: [],
    };
  }

```

In the `summary` object, add the line `    truncated: false,` directly after `    ...base,`.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Return a truncated result from batchFetchWindow above max_messages"
```

---

### Task 11: Partial window listings and the complete manifest summary

**Files:**
- Modify: `src/batch-fetch-window.ts` (result interface, the block after the window listing, `base`, the truncation status)
- Test: `src/batch-fetch-window.test.ts` (remove one Task 4 test; append)

**Interfaces:**
- Produces: `listingComplete: boolean` on `BatchFetchWindowResult` and in `manifest.json`; `window-listing:page-<n>` failure entries; the manifest summary is now complete.

- [ ] **Step 0: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool with `target: "batchFetchWindow"`, `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`. Record the callers and the risk level in the task report. Expected: the target resolves with `epistemic: "exact"`, the only caller is `src/batch-fetch-window.test.ts`, risk LOW. A `not found` answer means the wrong index was queried; fix that before editing. If HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 1: Replace the Task 4 refusal test and write the failing tests**

In `src/batch-fetch-window.test.ts`, delete the whole `it('rejects when a later window page fails and writes nothing', …)` case from the first `describe` block (Task 4 refused a partial listing because it could not yet report one; this task reports it).

Append:

```ts
describe('batchFetchWindow: partial window listings', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('continues with a partial window listing when page two fails', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [WINDOW_QUERY]: [{ ids: ['a'] }, httpError(503)] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('incomplete');
    expect(result.listingComplete).toBe(false);
    expect(result.pages).toBe(1);
    expect(result.failures).toEqual([{ id: 'window-listing:page-2', error: '503' }]);
    expect(readJson(path.join(dir, 'manifest.json')).listingComplete).toBe(false);
    expect(fs.existsSync(path.join(dir, 'messages', '001.json'))).toBe(true);
  });

  it('reports the network error code for a later window page failure', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const gmail = fakeGmail({
      lists: windowOnly(['a'], { [WINDOW_QUERY]: [{ ids: ['a'] }, reset] }),
      messages: { a: message('a', BOUNDARY + 1) },
    });
    const result = await run(gmail, dir);

    expect(result.failures).toEqual([{ id: 'window-listing:page-2', error: 'ECONNRESET' }]);
    expect(readJson(path.join(dir, 'manifest.json')).failures).toEqual([{ id: 'window-listing:page-2', error: 'ECONNRESET' }]);
  });

  it('writes the complete reference manifest summary and returns it with status and triage', async () => {
    const gmail = fakeGmail({
      lists: windowOnly(['a']),
      messages: { a: message('a', BOUNDARY + 1000, { labelIds: ['INBOX', 'UNREAD'] }) },
    });
    const result = await run(gmail, dir);
    const file = path.join(dir, 'messages', '001.json');

    const manifest = readJson(path.join(dir, 'manifest.json'));
    expect(manifest).toEqual({
      checkedAt: '2026-09-11T12:00:00.000Z',
      emailAddress: 'me@example.com',
      watermark: WATERMARK,
      boundaryMs: BOUNDARY,
      query: WINDOW_QUERY,
      pages: 1,
      listed: 1,
      inWindow: 1,
      belowBoundaryOrExcluded: 0,
      truncated: false,
      listingComplete: true,
      maxMessages: 2000,
      failures: [],
      crossCheck: { window: 1, spam: 0, trash: 0, anywhere: 1, unexplainedIds: [], consistent: true },
      messages: [{
        file,
        id: 'a',
        internalDate: String(BOUNDARY + 1000),
        labelIds: ['INBOX', 'UNREAD'],
        from: 'a@example.com',
        subject: 'Subject a',
        dateHeader: 'Mon, 07 Sep 2026 14:00:00 +0000',
        attachments: 0,
      }],
    });
    const { messages, ...summary } = manifest;
    expect(messages).toHaveLength(1);
    expect(result).toEqual({ ...summary, status: 'ok', triage: result.triage });
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on all three: the first two reject with the `GmailRequestError` that Task 4 throws for a partial listing; the third fails the manifest `toEqual` because `listingComplete` is absent.

- [ ] **Step 3: Record the listing failure and report `listingComplete`**

In `src/batch-fetch-window.ts`, in `BatchFetchWindowResult`, add directly after the line `  truncated: boolean;`:

```ts
  listingComplete: boolean;
```

Replace

```ts
  // A listing that stopped early cannot be reported by this result, so it is refused
  // rather than passed off as a complete window.
  if (!windowList.complete && windowList.error) {
    throw windowList.error;
  }
```

with

```ts
  if (!windowList.complete && windowList.error) {
    failures.push({ id: `window-listing:page-${windowList.pages + 1}`, error: failureCode(windowList.error) });
  }
```

In the `base` object, add the line `    listingComplete: windowList.complete,` directly after `    maxMessages: input.max_messages,`.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing status-precedence test**

Append:

```ts
describe('batchFetchWindow: status precedence when truncated', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports incomplete with truncated true when the listing fails after exceeding the cap', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
    const gmail = fakeGmail({
      lists: { [WINDOW_QUERY]: [{ ids: ['a', 'b'] }, { ids: ['c'] }, httpError(503)] },
    });
    const result = await run(gmail, dir, { max_messages: 2 });

    expect(result.status).toBe('incomplete');
    expect(result.truncated).toBe(true);
    expect(result.listingComplete).toBe(false);
    expect(result.failures).toEqual([{ id: 'window-listing:page-3', error: '503' }]);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['009.json']);
  });
});
```

- [ ] **Step 6: Run the test file to verify the new test fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL: `status` is `truncated` although a listing failure was recorded.

- [ ] **Step 7: Apply status precedence in the truncation block**

In the truncation block of `src/batch-fetch-window.ts` replace

```ts
      status: 'truncated',
```

with

```ts
      status: failures.length > 0 ? 'incomplete' : 'truncated',
```

- [ ] **Step 8: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 10: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Record partial window listings in batchFetchWindow with status precedence"
```

---

### Task 12: Schema, registration, handler, server wiring and documentation

**Files:**
- Modify: `src/tools.ts` (imports at lines 1-2; after `GmailIndexMetadataOutputSchema` ending line 280; `toolDefinitions` after the `batch_get_gmail_index_metadata` entry ending line 334)
- Modify: `src/batch-fetch-window.ts` (imports, the local types become `z.infer` aliases, both returns validate, add `handleBatchFetchWindow`)
- Modify: `src/index.ts:22-27` (imports) and `src/index.ts:604-609` (add a `case` after `batch_get_gmail_index_metadata`)
- Modify: `README.md:279`, `README.md:319-331`, `README.md:381-392`
- Modify: `docs/gmail-cli-spec.md:9-10`
- Test: `src/batch-fetch-window.test.ts` (imports; append)

**Interfaces:**
- Consumes: `batchFetchWindow` and its two types (Tasks 4 to 11); `structuredResult` (existing, `src/gmail-sync.ts`); `NonEmptyString` (existing, `src/tools.ts`).
- Produces:
  - `BatchFetchWindowSchema` (zod object, strict): `{ watermark: string; output_dir: string; max_messages: number (default 2000); cross_check: boolean (default true) }`
  - `BatchFetchWindowOutputSchema` (zod object, strict) with fields `status, checkedAt, emailAddress, watermark, boundaryMs, query, pages, listed, inWindow, belowBoundaryOrExcluded, truncated, listingComplete, maxMessages, failures, crossCheck?, triage`
  - a `toolDefinitions` entry named `batch_fetch_window`
  - `type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>`, `type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>` (same names as before, now derived from the schemas so the two cannot drift)
  - `async function handleBatchFetchWindow(gmail: gmail_v1.Gmail, args: unknown, now?: () => Date): Promise<ReturnType<typeof structuredResult>>`

This is the one task that exposes the tool. Every behaviour the schema describes exists by now, so the commit is a complete, callable, documented feature.

- [ ] **Step 1: Refresh the index and run impact analysis**

Run: `npx gitnexus analyze --branch feat/batch-fetch-window --index-only` from the worktree root. Then run the GitNexus `impact` tool three times, each with `direction: "upstream"`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"` and `branch: "feat/batch-fetch-window"`: `target: "batchFetchWindow"` (this task changes its types and both returns), `target: "toolDefinitions"`, and `target: "main"` (the `src/index.ts` entry point that contains the request handler). Report the callers (`src/batch-fetch-window.test.ts`; `toMcpTools`, `getToolByName`, index.ts registration) and the risk in the task report. All three are expected LOW to MEDIUM since only an array entry and a `case` are appended and the module's callers are its tests; if any reports HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 2: Write the failing schema tests**

Replace the import block at the top of `src/batch-fetch-window.test.ts` with:

```ts
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';
import { hasScope } from './scopes.js';
import {
  BatchFetchWindowOutputSchema,
  BatchFetchWindowSchema,
  getToolByName,
  toMcpTools,
  toolDefinitions,
} from './tools.js';
```

Append:

```ts
describe('BatchFetchWindowSchema', () => {
  it('accepts a zoned watermark and an absolute directory, applying defaults', () => {
    expect(BatchFetchWindowSchema.parse({
      watermark: '2026-09-10T14:03:22Z',
      output_dir: '/tmp/out',
    })).toEqual({
      watermark: '2026-09-10T14:03:22Z',
      output_dir: '/tmp/out',
      max_messages: 2000,
      cross_check: true,
    });
    expect(BatchFetchWindowSchema.parse({
      watermark: '2026-09-10T14:03:22.250+01:00',
      output_dir: '/tmp/out',
      max_messages: 5,
      cross_check: false,
    }).max_messages).toBe(5);
  });

  it('rejects a watermark without an explicit zone', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22', output_dir: '/tmp/out' }))
      .toThrow(/zone/);
  });

  it('rejects an impossible calendar date that Date.parse would roll over', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-02-30T00:00:00Z', output_dir: '/tmp/out' }))
      .toThrow(/valid date/);
  });

  it('rejects an unparseable watermark, a relative directory, and bad caps', () => {
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-13-40T99:00:00Z', output_dir: '/tmp/out' })).toThrow();
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: 'relative/out' })).toThrow(/absolute/);
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: '/tmp/out', max_messages: 0 })).toThrow();
    expect(() => BatchFetchWindowSchema.parse({ watermark: '2026-09-10T14:03:22Z', output_dir: '/tmp/out', extra: 1 })).toThrow();
  });
});

describe('BatchFetchWindowOutputSchema', () => {
  const base = {
    status: 'ok',
    checkedAt: '2026-09-11T12:00:00.000Z',
    emailAddress: 'me@example.com',
    watermark: '2026-09-10T14:03:22Z',
    boundaryMs: 1789000000000,
    query: 'after:1 -in:spam -in:trash',
    pages: 1,
    listed: 0,
    inWindow: 0,
    belowBoundaryOrExcluded: 0,
    truncated: false,
    listingComplete: true,
    maxMessages: 2000,
    failures: [],
    triage: [],
  };

  it('accepts a result with and without crossCheck', () => {
    expect(BatchFetchWindowOutputSchema.parse(base)).toEqual(base);
    const withCheck = {
      ...base,
      crossCheck: { window: 0, spam: 0, trash: 0, anywhere: 0, unexplainedIds: [], consistent: true },
    };
    expect(BatchFetchWindowOutputSchema.parse(withCheck)).toEqual(withCheck);
  });

  it('rejects unknown statuses and extra fields', () => {
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, status: 'done' })).toThrow();
    expect(() => BatchFetchWindowOutputSchema.parse({ ...base, messages: [] })).toThrow();
  });
});
```

- [ ] **Step 3: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, the whole file errors at import because `./tools.js` does not export `BatchFetchWindowSchema` or `BatchFetchWindowOutputSchema`.

- [ ] **Step 4: Add the schemas**

In `src/tools.ts`, change the imports at the top to:

```ts
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
```

Insert after the closing `}).strict();` of `GmailIndexMetadataOutputSchema` (line 280) and before the `// Tool definition type` comment:

```ts
const WATERMARK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const BatchFetchWindowSchema = z.object({
  watermark: z.string().superRefine((value, context) => {
    const match = WATERMARK_PATTERN.exec(value);
    if (!match) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'watermark must be an ISO 8601 timestamp with an explicit Z or +HH:MM/-HH:MM zone suffix',
      });
      return;
    }
    // Date.parse silently rolls invalid calendar values (e.g. 2026-02-30) into the next
    // month instead of rejecting them, so validate the calendar fields explicitly before
    // trusting Date.parse for the actual instant.
    const [, year, month, day, hour, minute, second] = match;
    const y = Number(year);
    const mo = Number(month);
    const d = Number(day);
    const h = Number(hour);
    const mi = Number(minute);
    const s = Number(second);
    const roundTrip = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const isValidCalendarDate = roundTrip.getUTCFullYear() === y
      && roundTrip.getUTCMonth() === mo - 1
      && roundTrip.getUTCDate() === d
      && roundTrip.getUTCHours() === h
      && roundTrip.getUTCMinutes() === mi
      && roundTrip.getUTCSeconds() === s;
    if (!isValidCalendarDate || !Number.isFinite(Date.parse(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'watermark is not a valid date' });
    }
  }).describe("ISO 8601 UTC timestamp with an explicit zone, e.g. 2026-09-10T14:03:22Z; the window is inclusive of this instant"),
  output_dir: z.string().refine(value => path.isAbsolute(value), {
    message: 'output_dir must be an absolute path',
  }).describe("Absolute directory; unless the result is truncated, the tool deletes and recreates messages/ and overwrites manifest.json and window-metadata.json inside it. A truncated run writes nothing and leaves earlier outputs in place, so check `truncated` before trusting the files"),
  max_messages: z.number().int().min(1).default(2000)
    .describe("Hard cap on listed IDs; above it nothing is downloaded and the result is truncated"),
  cross_check: z.boolean().default(true)
    .describe("Also list spam, trash and in:anywhere since the watermark to detect silently dropped messages"),
}).strict();

const BatchFetchFailureSchema = z.object({
  id: NonEmptyString,
  error: z.string(),
}).strict();

const BatchFetchCrossCheckSchema = z.object({
  window: z.number().int().min(0),
  spam: z.number().int().min(0),
  trash: z.number().int().min(0),
  anywhere: z.number().int().min(0),
  unexplainedIds: z.array(NonEmptyString),
  consistent: z.boolean(),
}).strict();

export const BatchFetchWindowOutputSchema = z.object({
  status: z.enum(['ok', 'incomplete', 'truncated']),
  checkedAt: NonEmptyString,
  emailAddress: NonEmptyString,
  watermark: NonEmptyString,
  boundaryMs: z.number().int(),
  query: NonEmptyString,
  pages: z.number().int().min(0),
  listed: z.number().int().min(0),
  inWindow: z.number().int().min(0),
  belowBoundaryOrExcluded: z.number().int().min(0),
  truncated: z.boolean(),
  listingComplete: z.boolean(),
  maxMessages: z.number().int().min(1),
  failures: z.array(BatchFetchFailureSchema),
  crossCheck: BatchFetchCrossCheckSchema.optional(),
  triage: z.array(z.string()),
}).strict();
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing definition tests**

Append:

```ts
describe('batch_fetch_window tool definition', () => {
  it('is registered with honest annotations and read scopes', () => {
    const tool = getToolByName('batch_fetch_window');
    expect(tool).toBeDefined();
    expect(tool!.scopes).toEqual(['gmail.readonly', 'gmail.modify']);
    expect(tool!.annotations).toEqual({
      title: 'Batch Fetch Window',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tool!.outputSchema).toBe(BatchFetchWindowOutputSchema);
    expect(hasScope(['gmail.readonly'], tool!.scopes)).toBe(true);
  });

  it('sits directly after batch_get_gmail_index_metadata and is MCP-valid', () => {
    const names = toolDefinitions.map(tool => tool.name);
    expect(names.indexOf('batch_fetch_window')).toBe(names.indexOf('batch_get_gmail_index_metadata') + 1);
    expect(() => ListToolsResultSchema.parse({ tools: toMcpTools(toolDefinitions) })).not.toThrow();
  });
});
```

- [ ] **Step 7: Run the test file to verify the new block fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on both definition cases: `getToolByName('batch_fetch_window')` is `undefined`, and the name is absent from `toolDefinitions`.

- [ ] **Step 8: Register the definition**

Insert into `toolDefinitions` in `src/tools.ts`, directly after the `batch_get_gmail_index_metadata` entry (after its closing `},` at line 334):

```ts
  {
    name: "batch_fetch_window",
    description: "Downloads every message received since a watermark into a local directory with manifest and cross-check; deletes and recreates messages/ under output_dir unless the listing exceeds max_messages, in which case nothing is written and earlier outputs remain",
    schema: BatchFetchWindowSchema,
    outputSchema: BatchFetchWindowOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
```

- [ ] **Step 9: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing handler tests**

In the import block of `src/batch-fetch-window.test.ts`, replace

```ts
import { batchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';
```

with

```ts
import { ZodError } from 'zod';
import { batchFetchWindow, handleBatchFetchWindow, type BatchFetchWindowInput } from './batch-fetch-window.js';
```

Append:

```ts
describe('handleBatchFetchWindow', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('rejects invalid arguments with a zod error before touching Gmail', async () => {
    const gmail = fakeGmail({ lists: {} });
    await expect(handleBatchFetchWindow(gmail as never, { watermark: 'nope', output_dir: dir }))
      .rejects.toBeInstanceOf(ZodError);
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
    expect(gmail.list).not.toHaveBeenCalled();
  });

  it('applies defaults, runs the window, and returns a structured MCP result', async () => {
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    const result = await handleBatchFetchWindow(gmail as never, { watermark: WATERMARK, output_dir: dir }, FIXED_NOW);

    expect(result.structuredContent).toMatchObject({ status: 'ok', maxMessages: 2000, inWindow: 1 });
    expect(result.structuredContent.crossCheck).toBeDefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect(() => BatchFetchWindowOutputSchema.parse(result.structuredContent)).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });
});
```

- [ ] **Step 11: Run the test file to verify the new block fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, the whole file errors at import because `./batch-fetch-window.js` does not export `handleBatchFetchWindow`.

- [ ] **Step 12: Derive the module's types from the schemas, validate both returns, and add the handler**

In `src/batch-fetch-window.ts`, replace the import block

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { failureCode, getGmailEmailAddress, isAuthError, listAllGmailMessageIds } from './gmail-sync.js';
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
```

with

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { failureCode, getGmailEmailAddress, isAuthError, listAllGmailMessageIds, structuredResult } from './gmail-sync.js';
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
import { BatchFetchWindowOutputSchema, BatchFetchWindowSchema } from './tools.js';
```

Replace everything from the line `export interface BatchFetchWindowInput {` through the closing `}` of `export interface BatchFetchWindowResult` (that is: the `BatchFetchWindowInput` interface, the `CrossCheck` interface, the `Failure` type and the `BatchFetchWindowResult` interface) with:

```ts
export type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>;
export type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>;

type Failure = { id: string; error: string };
```

Replace

```ts
  let crossCheck: CrossCheck | undefined;
```

with

```ts
  let crossCheck: BatchFetchWindowResult['crossCheck'];
```

In the truncation block, replace `    return {` with `    return BatchFetchWindowOutputSchema.parse({` and its closing `    };` with `    });`, so the block reads:

```ts
  if (windowList.ids.length > input.max_messages) {
    return BatchFetchWindowOutputSchema.parse({
      checkedAt: now().toISOString(),
      ...base,
      status: failures.length > 0 ? 'incomplete' : 'truncated',
      truncated: true,
      inWindow: 0,
      belowBoundaryOrExcluded: 0,
      failures,
      triage: [],
    });
  }
```

Replace the final

```ts
  return { ...summary, status, triage };
```

with

```ts
  return BatchFetchWindowOutputSchema.parse({ ...summary, status, triage });
```

Append at the end of the file:

```ts
export async function handleBatchFetchWindow(
  gmail: gmail_v1.Gmail,
  args: unknown,
  now: () => Date = () => new Date(),
) {
  const validatedArgs = BatchFetchWindowSchema.parse(args);
  return structuredResult({ ...await batchFetchWindow(gmail, validatedArgs, now) });
}
```

- [ ] **Step 13: Wire the server**

In `src/index.ts`, after line 27 (`import { batchGetGmailIndexMetadata } from "./gmail-batch.js";`) add:

```ts
import { handleBatchFetchWindow } from "./batch-fetch-window.js";
```

After the `batch_get_gmail_index_metadata` case (its closing `}` at line 609) add:

```ts
                case "batch_fetch_window": {
                    return await handleBatchFetchWindow(gmail, args);
                }
```

Keep the existing indentation of the surrounding cases. The `index.ts` `switch` cannot be unit-tested without starting the server, so the real dispatch is verified end-to-end by the smoke run in Task 13, which calls the tool through the MCP client against `dist/index.js`.

- [ ] **Step 14: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS, every block.

- [ ] **Step 15: Update the README**

In `README.md`, in the scope table row that begins `| \`read_email\`, \`search_emails\`, \`download_attachment\`` (line 279), change the end of the tool list from

```
`list_gmail_added_history`, `batch_get_gmail_index_metadata` | `gmail.readonly` or `gmail.modify` |
```

to

```
`list_gmail_added_history`, `batch_get_gmail_index_metadata`, `batch_fetch_window` | `gmail.readonly` or `gmail.modify` |
```

Replace the line

```
With a read-only Gmail scope, these 12 tools will be available to Claude. The scope prevents Gmail mutations, but `download_attachment` and `download_email` can still write files to paths you provide locally.
```

with

```
With a read-only Gmail scope, these 13 tools will be available to Claude. The scope prevents Gmail mutations, but `download_attachment`, `download_email` and `batch_fetch_window` can still write files to paths you provide locally.
```

After the line `- `batch_get_gmail_index_metadata` - Fetch ID, internal date, and labels for up to 50 messages` add:

```
- `batch_fetch_window` - Download every message since a watermark into a local directory with manifest and cross-check
```

Change the sentence `These four read-only tools support deterministic mailbox indexing without returning email content:` to `These tools support deterministic mailbox indexing:`.

After the table row for `batch_get_gmail_index_metadata` in the "Structured index synchronisation tools" section, add this row:

```
| `batch_fetch_window` | `watermark` (ISO 8601 with zone); `output_dir` (absolute); optional `max_messages` (default 2000); optional `cross_check` (default true) | Status (`ok`, `incomplete`, `truncated`), counts, failures, cross-check summary and a triage list; writes `messages/NNN.json`, `manifest.json` and `window-metadata.json` under `output_dir` (nothing when `truncated`) |
```

Then replace the paragraph that begins `The tools never request or return subjects` with:

```
The first four tools never request or return subjects, addresses, snippets, headers, bodies, attachments, or raw message content. Metadata batches retry only Gmail HTTP 429 and 5xx responses, with a maximum of three attempts. `batch_fetch_window` is the exception: it downloads full messages to disk and returns only headers in its triage lines. On every run that is not truncated it deletes and recreates `messages/` and overwrites the two JSON files under `output_dir`; a truncated result (listing above `max_messages`) writes nothing and leaves any earlier outputs in place, so check `truncated` before trusting the files. It touches nothing else in `output_dir` and reports `readOnlyHint: false` because of those writes.
```

- [ ] **Step 16: Add the note to the CLI spec**

In `docs/gmail-cli-spec.md`, after the paragraph ending `...which needs scripted "list every message since watermark" and "read message in full" operations.` (line 10), insert a blank line and:

```
Note (2026-09-11): the routine PA pass now uses the `batch_fetch_window` MCP tool (see
`docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md`); the CLIs below remain
optional, for targeted reads.
```

- [ ] **Step 17: Run the whole suite, the type check, and the build**

Run: `npm test`, then `npm run typecheck`, then `npm run build`. Expected: all clean, and `dist/batch-fetch-window.js` and `dist/message-body.js` exist. `src/gmail-sync.test.ts` still passes because its read-only assertions iterate a fixed list of four names and the MCP-validity test parses the full list.

- [ ] **Step 18: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`, `repo: "/Users/sasha/Projects/Gmail-MCP-Server/.worktrees/batch-fetch-window"`, `branch: "feat/batch-fetch-window"`). Expected: `toolDefinitions` and the request handler in `src/index.ts` changed; affected processes are tool listing and dispatch.

```bash
git add src/tools.ts src/index.ts src/batch-fetch-window.ts src/batch-fetch-window.test.ts README.md docs/gmail-cli-spec.md
git commit -m "Register batch_fetch_window: schema, handler, server case and docs"
```

---

### Task 13: Smoke run against the real mailbox

**Files:**
- Create: `tmp/smoke-batch-fetch-window.mjs` (the `tmp/` directory is gitignored; nothing in this task is committed unless Step 5 finds an unlisted deviation, in which case only `docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md` is committed)

**Interfaces:**
- Consumes: the built server in `dist/index.js` over stdio, through the MCP SDK client.

- [ ] **Step 1: Write the smoke client**

Create `tmp/smoke-batch-fetch-window.mjs`:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const outputDir = path.resolve('tmp/bfw-smoke');
const watermark = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'bfw-smoke', version: '0.0.0' });

// A truncated result writes nothing, so it must never be reported as if files existed:
// retry once with a much larger cap, and fail outright if it is still truncated.
const CAPS = [2000, 20000];

let tool;
let result;
let usedCap;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  tool = tools.tools.find(entry => entry.name === 'batch_fetch_window');
  if (tool) {
    for (const cap of CAPS) {
      usedCap = cap;
      result = await client.callTool({
        name: 'batch_fetch_window',
        arguments: { watermark, output_dir: outputDir, max_messages: cap },
      });
      if (result.isError) break;
      const parsed = result.structuredContent ?? JSON.parse(result.content[0].text);
      if (!parsed.truncated) break;
      console.error(`listing exceeded max_messages=${cap} (listed ${parsed.listed}); retrying with a larger cap`);
    }
  }
} finally {
  await client.close();
}

if (!tool) {
  console.error('batch_fetch_window is not registered');
  process.exit(1);
}
console.error('annotations:', JSON.stringify(tool.annotations));

// The server's request handler catches tool exceptions and returns
// { isError: true, content: [{ type: 'text', text: 'Error: …' }] }, so a thrown auth,
// validation or first-page listing error arrives here as a resolved result, never a rejection.
if (result.isError) {
  const text = result.content?.[0]?.text ?? '(no error text)';
  console.error('tool returned an error:', text);
  if (/401|403|invalid_grant|invalid_token|credential|insufficient/i.test(text)) {
    console.error('Credentials look missing, expired or under-scoped: run `node dist/index.js auth` (opens a browser), then rerun this script.');
  }
  process.exit(1);
}

const summary = result.structuredContent ?? JSON.parse(result.content[0].text);
// Triage lines carry senders and subjects, so they are dropped entirely rather than
// pattern-redacted; a pipe inside a subject would defeat any delimiter-based redaction.
const { triage, ...rest } = summary;
const redacted = { ...rest, emailAddress: '<redacted>', triageCount: triage.length, usedCap };
console.log(JSON.stringify(redacted, null, 2));

if (summary.truncated) {
  console.error(`still truncated at max_messages=${usedCap}: nothing was written, and any files under ${outputDir} are from an earlier run and are not reported`);
  process.exit(1);
}
console.error('files:', fs.readdirSync(outputDir).sort().join(', '));
console.error('messages:', fs.readdirSync(path.join(outputDir, 'messages')).length);
```

- [ ] **Step 2: Run it**

Run: `node tmp/smoke-batch-fetch-window.mjs`
Expected: stderr shows the annotations `{"title":"Batch Fetch Window","readOnlyHint":false,"destructiveHint":true,"idempotentHint":false}`, the process exits 0, stdout shows a JSON summary with `status` `ok` or `incomplete` and `truncated: false`, `emailAddress` already replaced and `triage` replaced by `triageCount`, and `tmp/bfw-smoke/` contains `manifest.json`, `window-metadata.json` and `messages/`. If `status` is `incomplete`, the `failures` array or `crossCheck.unexplainedIds` shows why; paste the stdout JSON as printed. A `truncated` result is handled by the script itself: it retries once with `max_messages: 20000` and exits 1 if the mailbox still exceeds that, in which case the smoke step has not passed; choose a nearer watermark (edit the `24 * 60 * 60 * 1000` term to a few hours) and rerun rather than reporting anything from the directory. Never paste `manifest.json`, `window-metadata.json`, or any `messages/*.json` content into the report. If the script prints `tool returned an error`, read the text: for a credentials message run `node dist/index.js auth` (this opens a browser; ask Sasha if you cannot complete it) and rerun; for anything else, treat it as a defect, fix it, and rerun.

- [ ] **Step 3: Inspect one output file**

Use `Read` on `tmp/bfw-smoke/manifest.json` and on `tmp/bfw-smoke/messages/001.json` (if any message exists) and confirm the fields match the shapes in the design document. Do not paste message bodies into the report.

- [ ] **Step 4: Clean up**

Run: `rm tmp/smoke-batch-fetch-window.mjs`
Leave `tmp/bfw-smoke/` in place for the user to inspect; it is gitignored.

- [ ] **Step 5: Final verification and report**

Run: `git status --short` and confirm nothing is left uncommitted except `tmp/` and the GitNexus one-line edits to `CLAUDE.md` and `AGENTS.md`.
Run: `npm test` one final time and paste the summary line.

The report must include: the exact test command and its summary output, the smoke stdout JSON (already redacted by the script), and all sixteen deviations from the reference listed under "Deviations from the reference, reported here on purpose" in the design document, repeated verbatim and numbered 1 to 16. Before writing the report, re-read that section: if the implementation as committed differs from the reference in any observable way the list does not name, add the entry to the design document in this task, commit it with the message `Record an additional batch_fetch_window deviation from the reference`, and include it in the report.
