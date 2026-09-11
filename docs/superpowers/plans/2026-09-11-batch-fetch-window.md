# `batch_fetch_window` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. This is mandatory, not a recommendation: `docs/gmail-batch-fetch-spec.md` records Sasha's instruction that the brainstorming, writing-plans and subagent-driven-development skills be followed in full. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one MCP tool, `batch_fetch_window`, that downloads every Gmail message received since a watermark into a caller-supplied directory with a manifest, window metadata, and a spam/trash/anywhere cross-check, so the PA repository can delete its direct-API script.

**Architecture:** Three new units. `src/message-body.ts` owns the MIME walk, deferred-body fetch and HTML-to-text rules copied from the reference script. `src/gmail-sync.ts` gains an error type, an auth-failure predicate, an exhaustive lister and a profile-address lookup. `src/batch-fetch-window.ts` orchestrates listing, fetching, filtering, atomic file publication and the cross-check, and returns a status the caller can trust. `src/tools.ts` registers the schema; `src/index.ts` adds one `case`. Tasks 5 to 15 grow `src/batch-fetch-window.ts` one behaviour at a time, each behind a failing test.

**Tech Stack:** TypeScript 5 (ES2020 modules, `strict`), `googleapis` Gmail v1 client, `zod` 3, `vitest` 4, Node `node:fs`/`node:path`. Tests run with `npx vitest run <file>`; the whole suite with `npm test`; build with `npm run build`.

**Spec:** `docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md` (read it first; it explains every rule below and lists the nine deliberate deviations from the reference script that the final report must repeat).

## Global Constraints

- Do not change the behaviour, signature, or output schema of any existing tool or exported function. `listGmailMessageIds`, `getGmailProfile`, `extractEmailContent`, `extractAttachments`, `extractHeaders` stay exactly as they are.
- Do not add CLIs. Do not touch auth or scopes.
- Scopes for the new tool: `["gmail.readonly", "gmail.modify"]`. Annotations: `{ title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false }`.
- The tool owns exactly three things under `output_dir`: `messages/`, `manifest.json`, `window-metadata.json`. Nothing else is read, matched, or deleted there.
- `manifest.json` is written last, by atomic rename from `messages/.publish-manifest.json`. `window-metadata.json` is written first, the same way.
- Every catch that records a failure and continues must first call `isAuthError` and rethrow when it is true.
- Message files are pretty-printed with two-space indentation and a trailing newline.
- Commit policy: each task ends in its own commit on `experimental`. `docs/gmail-batch-fetch-spec.md` records that Sasha amended its original "do not commit" instruction on 2026-09-11 so that the skills' per-task commits apply.
- Repository rules from `CLAUDE.md`: run the GitNexus `impact` tool on any existing function you modify before editing it, and run `detect_changes` before every commit. Bash rules: one command per call, no `&&`/`;`/`||`, no output redirection, single-line commit messages with `-m`.
- `failureCode` must reproduce the reference's `error.code || error.response?.status || error.name` exactly; body-part failure codes are `body-part-fetch: <code>` with a space after the colon, as in the reference.
- Use `Read`/`Edit`/`Write` for files, never shell readers or `sed`.
- Full existing suite (`npm test`) must pass after every task.
- Every test in Tasks 5 to 15 must be seen failing before the implementation step of its task, except the ones labelled "regression guard", whose reason for passing already is stated next to them. If any other test passes before its implementation step, stop: either the test is wrong or an earlier task over-implemented; say which in your report and fix it before continuing.

---

### Task 1: Gmail request errors and the auth-failure rule

**Files:**
- Modify: `src/gmail-sync.ts` (append after `hasResponseStatus`, before `getGmailProfile`)
- Test: `src/gmail-sync.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class GmailRequestError extends Error { readonly status?: number; readonly reason?: string; readonly cause: unknown; constructor(message: string, options?: { status?: number; reason?: string; cause?: unknown }) }`
  - `function toGmailRequestError(error: unknown): GmailRequestError`
  - `function failureCode(error: unknown): string`
  - `function isAuthError(error: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/gmail-sync.test.ts`, and extend the import from `./gmail-sync.js` to include `GmailRequestError, failureCode, isAuthError, toGmailRequestError`:

```ts
function httpError(status: number, reason?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: {
      status,
      data: reason ? { error: { errors: [{ reason }] } } : {},
    },
  });
}

describe('GmailRequestError helpers', () => {
  it('extracts status and reason from a googleapis-shaped error', () => {
    const wrapped = toGmailRequestError(httpError(429, 'rateLimitExceeded'));
    expect(wrapped).toBeInstanceOf(GmailRequestError);
    expect(wrapped.status).toBe(429);
    expect(wrapped.reason).toBe('rateLimitExceeded');
    expect(wrapped.code).toBeUndefined();
    expect(wrapped.message).toBe('HTTP 429');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });

  it('keeps the original code on the wrapper', () => {
    expect(toGmailRequestError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).code).toBe('ECONNRESET');
    expect(toGmailRequestError(Object.assign(new Error('gaxios'), { code: '429', response: { status: 429 } })).code).toBe('429');
    expect(toGmailRequestError(Object.assign(new Error('zero'), { code: 0 })).code).toBeUndefined();
  });

  it('reads a top-level errors array and a string response error', () => {
    const topLevel = Object.assign(new Error('x'), { errors: [{ reason: 'authError' }] });
    expect(toGmailRequestError(topLevel).reason).toBe('authError');

    const oauth = Object.assign(new Error('bad grant'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
    expect(toGmailRequestError(oauth).reason).toBe('invalid_grant');
  });

  it('passes an existing GmailRequestError through unchanged', () => {
    const original = new GmailRequestError('already', { status: 500 });
    expect(toGmailRequestError(original)).toBe(original);
  });

  it('wraps a plain Error with neither status nor reason', () => {
    const wrapped = toGmailRequestError(new Error('plain'));
    expect(wrapped.status).toBeUndefined();
    expect(wrapped.reason).toBeUndefined();
    expect(wrapped.message).toBe('plain');
  });

  it('renders failureCode exactly as the reference: code, then status, then name', () => {
    expect(failureCode(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(failureCode(Object.assign(new Error('gaxios'), { code: '429', response: { status: 429 } }))).toBe('429');
    expect(failureCode(httpError(404))).toBe('404');
    expect(failureCode(Object.assign(new Error('zero'), { code: 0, response: { status: 500 } }))).toBe('500');
    expect(failureCode(new TypeError('boom'))).toBe('TypeError');
    expect(failureCode(Object.assign(new Error('x'), { errors: [{ reason: 'backendError' }] }))).toBe('Error');
  });

  it('renders the same failureCode through a GmailRequestError wrapper', () => {
    expect(failureCode(toGmailRequestError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })))).toBe('ECONNRESET');
    expect(failureCode(toGmailRequestError(httpError(503)))).toBe('503');
    expect(failureCode(toGmailRequestError(new TypeError('boom')))).toBe('TypeError');
    expect(failureCode(toGmailRequestError(Object.assign(new Error('x'), { errors: [{ reason: 'backendError' }] })))).toBe('Error');
  });

  it('treats 401, auth reasons, and non-quota 403 as auth errors', () => {
    expect(isAuthError(httpError(401))).toBe(true);
    for (const reason of [
      'invalid_grant', 'invalid_token', 'authError', 'unauthorized',
      'insufficientPermissions', 'forbidden', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    ]) {
      expect(isAuthError(httpError(400, reason))).toBe(true);
    }
    expect(isAuthError(httpError(403, 'insufficientPermissions'))).toBe(true);
    expect(isAuthError(httpError(403, 'somethingElse'))).toBe(true);
    expect(isAuthError(httpError(403))).toBe(true);
  });

  it('does not treat rate limits, 404, 429, or plain errors as auth errors', () => {
    for (const reason of ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']) {
      expect(isAuthError(httpError(403, reason))).toBe(false);
    }
    expect(isAuthError(httpError(404))).toBe(false);
    expect(isAuthError(httpError(429))).toBe(false);
    expect(isAuthError(new Error('network'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/gmail-sync.test.ts`
Expected: FAIL, import errors naming `GmailRequestError` (or "is not a function").

- [ ] **Step 3: Implement the helpers**

In `src/gmail-sync.ts`, insert after the `hasResponseStatus` function (line 31) and before `export async function getGmailProfile`:

```ts
const AUTH_REASONS = new Set([
  'invalid_grant',
  'invalid_token',
  'authError',
  'unauthorized',
  'insufficientPermissions',
  'forbidden',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
]);

const RATE_LIMIT_REASONS = new Set([
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
]);

export class GmailRequestError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly cause: unknown;

  constructor(
    message: string,
    options: { code?: string; status?: number; reason?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'GmailRequestError';
    this.code = options.code;
    this.status = options.status;
    this.reason = options.reason;
    this.cause = options.cause;
  }
}

type ErrorRecord = {
  message?: unknown;
  code?: unknown;
  errors?: Array<{ reason?: unknown }>;
  response?: {
    status?: unknown;
    data?: { error?: unknown };
  };
};

function asRecord(error: unknown): ErrorRecord | undefined {
  return typeof error === 'object' && error !== null ? error as ErrorRecord : undefined;
}

// The reference script's first choice for a failure string is `error.code`; gaxios sets it
// to the HTTP status as a string, Node sets it to a network code such as ECONNRESET.
function readCode(record: ErrorRecord | undefined): string | undefined {
  const code = record?.code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  if (typeof code === 'number' && code !== 0) {
    return String(code);
  }
  return undefined;
}

function readStatus(record: ErrorRecord | undefined): number | undefined {
  const status = record?.response?.status;
  if (typeof status === 'number') {
    return status;
  }
  const code = record?.code;
  if (typeof code === 'number') {
    return code;
  }
  if (typeof code === 'string' && /^\d{3}$/.test(code)) {
    return Number(code);
  }
  return undefined;
}

function readReason(record: ErrorRecord | undefined): string | undefined {
  const topLevel = record?.errors?.[0]?.reason;
  if (typeof topLevel === 'string') {
    return topLevel;
  }
  const dataError = record?.response?.data?.error;
  if (typeof dataError === 'string') {
    return dataError;
  }
  if (typeof dataError === 'object' && dataError !== null) {
    const nested = (dataError as { errors?: Array<{ reason?: unknown }> }).errors?.[0]?.reason;
    if (typeof nested === 'string') {
      return nested;
    }
  }
  return undefined;
}

export function toGmailRequestError(error: unknown): GmailRequestError {
  if (error instanceof GmailRequestError) {
    return error;
  }
  const record = asRecord(error);
  const message = typeof record?.message === 'string' ? record.message : String(error);
  return new GmailRequestError(message, {
    code: readCode(record),
    status: readStatus(record),
    reason: readReason(record),
    cause: error,
  });
}

// Reproduces the reference script's `error.code || error.response?.status || error.name`
// so manifest failure strings are byte-identical. Works the same on a raw error and on a
// GmailRequestError wrapper, because the wrapper keeps `code` and `cause`. `reason` is
// deliberately not consulted here.
export function failureCode(error: unknown): string {
  const wrapped = toGmailRequestError(error);
  if (wrapped.code !== undefined) {
    return wrapped.code;
  }
  if (wrapped.status !== undefined) {
    return String(wrapped.status);
  }
  const original = wrapped.cause instanceof Error ? wrapped.cause : error;
  return original instanceof Error ? original.name : wrapped.name;
}

export function isAuthError(error: unknown): boolean {
  const wrapped = toGmailRequestError(error);
  if (wrapped.status === 401) {
    return true;
  }
  if (wrapped.reason !== undefined && AUTH_REASONS.has(wrapped.reason)) {
    return true;
  }
  if (wrapped.status === 403) {
    return wrapped.reason === undefined || !RATE_LIMIT_REASONS.has(wrapped.reason);
  }
  return false;
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/gmail-sync.test.ts`
Expected: PASS, all existing and new cases.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Check scope and commit**

Run the GitNexus `detect_changes` tool (scope `all`). Expected: only `src/gmail-sync.ts` symbols added, no affected processes beyond `gmail-sync`.

```bash
git add src/gmail-sync.ts src/gmail-sync.test.ts
git commit -m "Add GmailRequestError, failureCode and isAuthError helpers"
```

---

### Task 2: Exhaustive listing and profile address

**Files:**
- Modify: `src/gmail-sync.ts` (append after `listGmailMessageIds`)
- Test: `src/gmail-sync.test.ts` (append)

**Interfaces:**
- Consumes: `isAuthError`, `toGmailRequestError`, `GmailRequestError`, `requiredId` from Task 1 and the existing file.
- Produces:
  - `interface ListAllMessageIdsOptions { query: string; includeSpamTrash: boolean; limit?: number }`
  - `interface ListAllMessageIdsResult { ids: string[]; pages: number; hasMore: boolean; complete: boolean; error?: GmailRequestError }`
  - `async function listAllGmailMessageIds(gmail: gmail_v1.Gmail, options: ListAllMessageIdsOptions): Promise<ListAllMessageIdsResult>`
  - `async function getGmailEmailAddress(gmail: gmail_v1.Gmail): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Append to `src/gmail-sync.test.ts` (add `getGmailEmailAddress, listAllGmailMessageIds` to the import):

```ts
function pagedList(pages: Array<{ ids: string[]; next?: string } | Error>) {
  return vi.fn(async (params: { pageToken?: string }) => {
    const index = params.pageToken ? Number(params.pageToken.slice('page-'.length)) : 0;
    const page = pages[index];
    if (page instanceof Error) {
      throw page;
    }
    return {
      data: {
        messages: page.ids.map(id => ({ id })),
        ...(page.next ? { nextPageToken: page.next } : {}),
      },
    };
  });
}

describe('listAllGmailMessageIds', () => {
  const options = { query: 'after:1 -in:spam -in:trash', includeSpamTrash: true };

  it('follows every page, deduplicates, and reports pages and completion', async () => {
    const listMessages = pagedList([
      { ids: ['a', 'b'], next: 'page-1' },
      { ids: ['b', 'c'], next: 'page-2' },
      { ids: ['d'] },
    ]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, options);

    expect(result).toEqual({ ids: ['a', 'b', 'c', 'd'], pages: 3, hasMore: false, complete: true });
    expect(listMessages).toHaveBeenNthCalledWith(1, {
      userId: 'me',
      q: options.query,
      includeSpamTrash: true,
      maxResults: 500,
      pageToken: undefined,
      fields: 'messages/id,nextPageToken',
    });
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'page-1' }));
  });

  it('caps a single oversized page at the limit and reports more', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `m${index}`);
    const listMessages = pagedList([{ ids }]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, { ...options, limit: 250 });

    expect(result.ids).toHaveLength(250);
    expect(result.hasMore).toBe(true);
    expect(result.complete).toBe(true);
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 250 }));
  });

  it('reports more when the limit lands on a page boundary with a token', async () => {
    const listMessages = pagedList([
      { ids: ['a', 'b'], next: 'page-1' },
      { ids: ['c'] },
    ]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, { ...options, limit: 2 });

    expect(result).toEqual({ ids: ['a', 'b'], pages: 1, hasMore: true, complete: true });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('reports no more when fewer IDs exist than the limit', async () => {
    const listMessages = pagedList([{ ids: ['a', 'b'] }]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, { ...options, limit: 250 });

    expect(result).toEqual({ ids: ['a', 'b'], pages: 1, hasMore: false, complete: true });
  });

  it('requests only the remaining budget on later pages', async () => {
    const listMessages = pagedList([
      { ids: ['a', 'b', 'c'], next: 'page-1' },
      { ids: ['d', 'e'] },
    ]);
    await listAllGmailMessageIds(gmailWith({ listMessages }) as never, { ...options, limit: 4 });

    expect(listMessages).toHaveBeenNthCalledWith(1, expect.objectContaining({ maxResults: 4 }));
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ maxResults: 1 }));
  });

  it('returns a partial result when a later page fails with a non-auth error', async () => {
    const failure = httpError(503);
    const listMessages = pagedList([{ ids: ['a'], next: 'page-1' }, failure]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, options);

    expect(result.ids).toEqual(['a']);
    expect(result.pages).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.hasMore).toBe(false);
    expect(result.error).toBeInstanceOf(GmailRequestError);
    expect(result.error?.status).toBe(503);
  });

  it('keeps a network error code on a partial result', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const listMessages = pagedList([{ ids: ['a'], next: 'page-1' }, reset]);
    const result = await listAllGmailMessageIds(gmailWith({ listMessages }) as never, options);

    expect(result.complete).toBe(false);
    expect(result.error?.code).toBe('ECONNRESET');
    expect(failureCode(result.error)).toBe('ECONNRESET');
  });

  it('rejects on a 401 on a later page and on any first-page failure', async () => {
    const unauthorised = httpError(401);
    const later = pagedList([{ ids: ['a'], next: 'page-1' }, unauthorised]);
    await expect(listAllGmailMessageIds(gmailWith({ listMessages: later }) as never, options)).rejects.toBe(unauthorised);

    const first = new Error('network');
    const firstPage = pagedList([first]);
    await expect(listAllGmailMessageIds(gmailWith({ listMessages: firstPage }) as never, options)).rejects.toBe(first);
  });
});

describe('getGmailEmailAddress', () => {
  it('requests only the address and returns it', async () => {
    const getProfile = vi.fn().mockResolvedValue({ data: { emailAddress: 'me@example.com' } });
    await expect(getGmailEmailAddress(gmailWith({ getProfile }) as never)).resolves.toBe('me@example.com');
    expect(getProfile).toHaveBeenCalledWith({ userId: 'me', fields: 'emailAddress' });
  });

  it('fails when Gmail omits the address', async () => {
    const gmail = gmailWith({ getProfile: vi.fn().mockResolvedValue({ data: {} }) });
    await expect(getGmailEmailAddress(gmail as never)).rejects.toThrow('emailAddress');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/gmail-sync.test.ts`
Expected: FAIL on the new `describe` blocks (functions not exported).

- [ ] **Step 3: Implement the lister and the address lookup**

In `src/gmail-sync.ts`, insert after the closing brace of `listGmailMessageIds` (after line 68 in the current file):

```ts
export interface ListAllMessageIdsOptions {
  query: string;
  includeSpamTrash: boolean;
  limit?: number;
}

export interface ListAllMessageIdsResult {
  ids: string[];
  pages: number;
  hasMore: boolean;
  complete: boolean;
  error?: GmailRequestError;
}

export async function listAllGmailMessageIds(
  gmail: gmail_v1.Gmail,
  options: ListAllMessageIdsOptions,
): Promise<ListAllMessageIdsResult> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const maxResults = options.limit === undefined
      ? 500
      : Math.min(500, options.limit - ids.length);
    let response;
    try {
      response = await gmail.users.messages.list({
        userId: 'me',
        q: options.query,
        includeSpamTrash: options.includeSpamTrash,
        maxResults,
        pageToken,
        fields: 'messages/id,nextPageToken',
      });
    } catch (error) {
      if (pages === 0 || isAuthError(error)) {
        throw error;
      }
      return { ids, pages, hasMore: false, complete: false, error: toGmailRequestError(error) };
    }
    pages += 1;

    let discarded = false;
    for (const message of response.data.messages ?? []) {
      const id = requiredId(message.id, 'message id');
      if (seen.has(id)) {
        continue;
      }
      if (options.limit !== undefined && ids.length >= options.limit) {
        discarded = true;
        break;
      }
      seen.add(id);
      ids.push(id);
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (options.limit !== undefined && ids.length >= options.limit) {
      return { ids, pages, hasMore: discarded || pageToken !== undefined, complete: true };
    }
  } while (pageToken);

  return { ids, pages, hasMore: false, complete: true };
}

export async function getGmailEmailAddress(gmail: gmail_v1.Gmail): Promise<string> {
  const response = await gmail.users.getProfile({
    userId: 'me',
    fields: 'emailAddress',
  });
  return requiredId(response.data.emailAddress, 'emailAddress');
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/gmail-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`). Expected: additions in `src/gmail-sync.ts` only.

```bash
git add src/gmail-sync.ts src/gmail-sync.test.ts
git commit -m "Add exhaustive Gmail listing and profile address helpers"
```

---

### Task 3: Message body module

**Files:**
- Create: `src/message-body.ts`
- Test: `src/message-body.test.ts`

**Interfaces:**
- Consumes: `GmailRequestError`, `failureCode`, `isAuthError`, `toGmailRequestError` from `./gmail-sync.js`.
- Produces:
  - `interface MessagePart { mimeType?: string | null; filename?: string | null; headers?: MessageHeader[] | null; body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null; parts?: MessagePart[] | null }`
  - `interface MessageHeader { name?: string | null; value?: string | null }`
  - `interface MessageAttachment { filename: string; mimeType: string; size: number; attachmentId?: string; inlineBase64?: string }`
  - `interface DeferredBody { mimeType: string; attachmentId: string }`
  - `interface ExtractedParts { text: string; html: string; attachments: MessageAttachment[]; deferredBodies: DeferredBody[] }`
  - `interface BodyFailure { code: string; error: GmailRequestError }`
  - `interface ResolvedBody extends ExtractedParts { body: string; failures: BodyFailure[] }`
  - `function decodeBase64Url(data: string | null | undefined): string`
  - `function headerValue(headers: MessageHeader[] | null | undefined, name: string): string`
  - `function extractMessageParts(payload: MessagePart | null | undefined): ExtractedParts`
  - `function htmlToText(html: string): string`
  - `async function resolveMessageBody(gmail: gmail_v1.Gmail, messageId: string, payload: MessagePart | null | undefined): Promise<ResolvedBody>`

- [ ] **Step 1: Write the failing tests**

Create `src/message-body.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GmailRequestError } from './gmail-sync.js';
import {
  decodeBase64Url,
  extractMessageParts,
  headerValue,
  htmlToText,
  resolveMessageBody,
} from './message-body.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
}

describe('decodeBase64Url', () => {
  it('decodes base64url and returns empty for missing data', () => {
    expect(decodeBase64Url(b64('héllo?>'))).toBe('héllo?>');
    expect(decodeBase64Url(undefined)).toBe('');
    expect(decodeBase64Url('')).toBe('');
  });
});

describe('headerValue', () => {
  it('matches case-insensitively and returns empty when absent', () => {
    const headers = [{ name: 'From', value: 'a@example.com' }, { name: 'subject', value: 'Hi' }];
    expect(headerValue(headers, 'from')).toBe('a@example.com');
    expect(headerValue(headers, 'SUBJECT')).toBe('Hi');
    expect(headerValue(headers, 'To')).toBe('');
    expect(headerValue(undefined, 'To')).toBe('');
  });
});

describe('extractMessageParts', () => {
  it('defers text and html attachmentId parts without a filename', () => {
    const parts = extractMessageParts({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'big-text' } },
        { mimeType: 'text/html', body: { attachmentId: 'big-html' } },
      ],
    });
    expect(parts.deferredBodies).toEqual([
      { mimeType: 'text/plain', attachmentId: 'big-text' },
      { mimeType: 'text/html', attachmentId: 'big-html' },
    ]);
    expect(parts.attachments).toEqual([]);
  });

  it('lists other attachmentId parts as attachments', () => {
    const parts = extractMessageParts({
      parts: [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att-1', size: 42 } }],
    });
    expect(parts.attachments).toEqual([
      { filename: 'a.pdf', mimeType: 'application/pdf', size: 42, attachmentId: 'att-1' },
    ]);
  });

  it('lists inline data with a filename as an inline attachment', () => {
    const parts = extractMessageParts({
      parts: [{ mimeType: 'image/png', filename: 'logo.png', body: { data: 'AAAA', size: 3 } }],
    });
    expect(parts.attachments).toEqual([
      { filename: 'logo.png', mimeType: 'image/png', size: 3, inlineBase64: 'AAAA' },
    ]);
  });

  it('concatenates text and html parts in tree order, recursing after the part itself', () => {
    const parts = extractMessageParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('one ') } },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('two') } },
            { mimeType: 'text/html', body: { data: b64('<p>two</p>') } },
          ],
        },
      ],
    });
    expect(parts.text).toBe('one two');
    expect(parts.html).toBe('<p>two</p>');
  });

  it('handles a missing payload', () => {
    expect(extractMessageParts(undefined)).toEqual({ text: '', html: '', attachments: [], deferredBodies: [] });
  });
});

describe('htmlToText', () => {
  it('strips style and script blocks', () => {
    expect(htmlToText('<style>p{}</style>a<script>x()</script>b')).toBe('a b');
  });

  it('turns br and block closers into newlines', () => {
    expect(htmlToText('a<br>b</p>c</div>d</tr>e</li>f</h2>g')).toBe('a\nb\nc\nd\ne\nf\ng');
  });

  it('renders anchors as text [href] for double and single quotes', () => {
    expect(htmlToText('<a href="https://x.test/a">Link</a>')).toBe('Link [https://x.test/a]');
    expect(htmlToText("<a href='https://x.test/b'>Link</a>")).toBe('Link [https://x.test/b]');
  });

  it('drops remaining tags and decodes entities', () => {
    expect(htmlToText('<b>x</b>&nbsp;&amp;&lt;&gt;&#39;&apos;&quot;')).toBe('x &<>\'\'"');
  });

  it('collapses runs of spaces and blank lines and trims', () => {
    expect(htmlToText('  a  \t b\n\n\n\nc  ')).toBe('a b\n\nc');
  });

  it('keeps the reference quirk: a br right before a newline is not converted', () => {
    expect(htmlToText('a<br>\nb')).toBe('a \nb');
  });
});

describe('resolveMessageBody', () => {
  function gmailWithAttachments(handler: (id: string) => Promise<{ data: { data?: string } }>) {
    return { users: { messages: { attachments: { get: vi.fn(({ id }: { id: string }) => handler(id)) } } } };
  }

  it('fetches deferred bodies and prefers plain text', async () => {
    const gmail = gmailWithAttachments(async id => ({ data: { data: b64(id === 'p' ? ' plain ' : '<p>html</p>') } }));
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'p' } },
        { mimeType: 'text/html', body: { attachmentId: 'h' } },
      ],
    });
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'p' });
    expect(result.text).toBe(' plain ');
    expect(result.html).toBe('<p>html</p>');
    expect(result.body).toBe('plain');
    expect(result.failures).toEqual([]);
  });

  it('falls back to converted html when there is no plain text', async () => {
    const gmail = gmailWithAttachments(async () => ({ data: { data: b64('<p>only html</p>') } }));
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/html', body: { attachmentId: 'h' } }],
    });
    expect(result.body).toBe('only html');
  });

  it('records a non-auth fetch failure with its status and keeps going', async () => {
    const gmail = gmailWithAttachments(async id => {
      if (id === 'bad') throw httpError(429);
      return { data: { data: b64('ok') } };
    });
    const result = await resolveMessageBody(gmail as never, 'm1', {
      parts: [
        { mimeType: 'text/plain', body: { attachmentId: 'bad' } },
        { mimeType: 'text/plain', body: { attachmentId: 'good' } },
      ],
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].code).toBe('body-part-fetch: 429');
    expect(result.failures[0].error).toBeInstanceOf(GmailRequestError);
    expect(result.failures[0].error.status).toBe(429);
    expect(result.body).toBe('ok');
  });

  it('rethrows an auth failure', async () => {
    const unauthorised = httpError(401);
    const gmail = gmailWithAttachments(async () => { throw unauthorised; });
    await expect(resolveMessageBody(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/plain', body: { attachmentId: 'x' } }],
    })).rejects.toBe(unauthorised);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/message-body.test.ts`
Expected: FAIL, cannot resolve `./message-body.js`.

- [ ] **Step 3: Create the module**

Create `src/message-body.ts`:

```ts
import type { gmail_v1 } from 'googleapis';
import { failureCode, GmailRequestError, isAuthError, toGmailRequestError } from './gmail-sync.js';

export interface MessageHeader {
  name?: string | null;
  value?: string | null;
}

export interface MessagePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: MessageHeader[] | null;
  body?: {
    attachmentId?: string | null;
    size?: number | null;
    data?: string | null;
  } | null;
  parts?: MessagePart[] | null;
}

export interface MessageAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  inlineBase64?: string;
}

export interface DeferredBody {
  mimeType: string;
  attachmentId: string;
}

export interface ExtractedParts {
  text: string;
  html: string;
  attachments: MessageAttachment[];
  deferredBodies: DeferredBody[];
}

export interface BodyFailure {
  code: string;
  error: GmailRequestError;
}

export interface ResolvedBody extends ExtractedParts {
  body: string;
  failures: BodyFailure[];
}

export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function headerValue(headers: MessageHeader[] | null | undefined, name: string): string {
  const found = (headers ?? []).find(header => (header.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

function walk(payload: MessagePart | null | undefined, out: ExtractedParts): void {
  if (!payload) return;
  const mime = payload.mimeType || '';
  if (payload.body?.attachmentId) {
    const isBody = (mime === 'text/plain' || mime === 'text/html') && !payload.filename;
    if (isBody) {
      out.deferredBodies.push({ mimeType: mime, attachmentId: payload.body.attachmentId });
    } else {
      out.attachments.push({
        filename: payload.filename || '',
        mimeType: mime,
        size: payload.body.size || 0,
        attachmentId: payload.body.attachmentId,
      });
    }
  } else if (payload.body?.data && payload.filename) {
    out.attachments.push({
      filename: payload.filename,
      mimeType: mime,
      size: payload.body.size || 0,
      inlineBase64: payload.body.data,
    });
  } else if (mime === 'text/plain' && payload.body?.data) {
    out.text += decodeBase64Url(payload.body.data);
  } else if (mime === 'text/html' && payload.body?.data) {
    out.html += decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) walk(part, out);
}

export function extractMessageParts(payload: MessagePart | null | undefined): ExtractedParts {
  const out: ExtractedParts = { text: '', html: '', attachments: [], deferredBodies: [] };
  walk(payload, out);
  return out;
}

// Copied verbatim from the PA reference script (gmail-fetch-all.cjs). Do not "fix" the
// regexes: the design requires identical output, and the known <br>-before-newline quirk
// is reported in the design document rather than changed here.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<a\s[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function resolveMessageBody(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: MessagePart | null | undefined,
): Promise<ResolvedBody> {
  const parts = extractMessageParts(payload);
  const failures: BodyFailure[] = [];

  for (const deferred of parts.deferredBodies) {
    try {
      const response = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: deferred.attachmentId,
      });
      const decoded = decodeBase64Url(response.data.data);
      if (deferred.mimeType === 'text/plain') {
        parts.text += decoded;
      } else {
        parts.html += decoded;
      }
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push({
        code: `body-part-fetch: ${failureCode(error)}`,
        error: toGmailRequestError(error),
      });
    }
  }

  const body = parts.text.trim() || htmlToText(parts.html);
  return { ...parts, body, failures };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/message-body.test.ts`
Expected: PASS. If the `br` quirk test fails, check that the regex is byte-for-byte the reference's; do not change the regex to make the test pass, change the expectation only if you can show the reference behaves differently by running the same string through the reference function.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`). Expected: one new file.

```bash
git add src/message-body.ts src/message-body.test.ts
git commit -m "Add message-body module with reference MIME walk and htmlToText"
```

---

### Task 4: Schema, output schema and tool definition

**Files:**
- Modify: `src/tools.ts` (imports at line 1-2; after `GmailIndexMetadataOutputSchema` ending line 280; `toolDefinitions` after the `batch_get_gmail_index_metadata` entry ending line 334)
- Test: `src/batch-fetch-window.test.ts` (create; the schema and definition cases only for now)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `BatchFetchWindowSchema` (zod object, strict): `{ watermark: string; output_dir: string; max_messages: number (default 2000); cross_check: boolean (default true) }`
  - `BatchFetchWindowOutputSchema` (zod object, strict) with fields `status, checkedAt, emailAddress, watermark, boundaryMs, query, pages, listed, inWindow, belowBoundaryOrExcluded, truncated, listingComplete, maxMessages, failures, crossCheck?, triage`
  - a `toolDefinitions` entry named `batch_fetch_window`

- [ ] **Step 1: Run impact analysis**

Run the GitNexus `impact` tool with `target: "toolDefinitions"`, `direction: "upstream"`. Report the callers (`toMcpTools`, `getToolByName`, index.ts registration) in the task notes. Risk is expected LOW to MEDIUM since only an array entry is appended; if it reports HIGH or CRITICAL, stop and report before editing.

- [ ] **Step 2: Write the failing tests**

Create `src/batch-fetch-window.test.ts` with this initial content (later tasks append to it):

```ts
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { hasScope } from './scopes.js';
import {
  BatchFetchWindowOutputSchema,
  BatchFetchWindowSchema,
  getToolByName,
  toMcpTools,
  toolDefinitions,
} from './tools.js';

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

- [ ] **Step 3: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, `BatchFetchWindowSchema` not exported.

- [ ] **Step 4: Add the schemas and the definition**

In `src/tools.ts`, change the imports at the top to:

```ts
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
```

Insert after the closing `}).strict();` of `GmailIndexMetadataOutputSchema` (line 280) and before the `// Tool definition type` comment:

```ts
const WATERMARK_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const BatchFetchWindowSchema = z.object({
  watermark: z.string().superRefine((value, context) => {
    if (!WATERMARK_PATTERN.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'watermark must be an ISO 8601 timestamp with an explicit Z or +HH:MM/-HH:MM zone suffix',
      });
      return;
    }
    if (!Number.isFinite(Date.parse(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'watermark is not a valid date' });
    }
  }).describe("ISO 8601 UTC timestamp with an explicit zone, e.g. 2026-09-10T14:03:22Z; the window is inclusive of this instant"),
  output_dir: z.string().refine(value => path.isAbsolute(value), {
    message: 'output_dir must be an absolute path',
  }).describe("Absolute directory; the tool deletes and recreates messages/ and overwrites manifest.json and window-metadata.json inside it"),
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

Insert into `toolDefinitions` directly after the `batch_get_gmail_index_metadata` entry (after its closing `},` at line 334):

```ts
  {
    name: "batch_fetch_window",
    description: "Downloads every message received since a watermark into a local directory with manifest and cross-check; deletes and recreates messages/ under output_dir",
    schema: BatchFetchWindowSchema,
    outputSchema: BatchFetchWindowOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean. `src/gmail-sync.test.ts` still passes because its read-only assertions iterate a fixed list of four names and the MCP-validity test parses the full list.

- [ ] **Step 7: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`). Expected: `toolDefinitions` changed; affected processes are tool listing and dispatch.

```bash
git add src/tools.ts src/batch-fetch-window.test.ts
git commit -m "Register batch_fetch_window schema, output schema and definition"
```

---

## Tasks 5 to 15: growing `src/batch-fetch-window.ts` one behaviour at a time

Every task in this range follows the same shape: append one `describe` block to `src/batch-fetch-window.test.ts`, run the file and see the new block fail, change `src/batch-fetch-window.ts` by exactly the block shown, run the file and see everything pass, run `npm test` and `npm run typecheck`, run GitNexus `detect_changes`, commit. Where a task also adds a test that already passes, it is labelled "regression guard" and the reason it passes already is stated; those guards protect behaviour that the helper they exercise was already red-green tested for in Tasks 2 and 3.

The shared test helpers are written once in Task 5 and reused by every later block.

---

### Task 5: Listing, fetching, and numbered message files

**Files:**
- Create: `src/batch-fetch-window.ts`
- Test: `src/batch-fetch-window.test.ts` (append helpers and the first behaviour block)

**Interfaces:**
- Consumes: `BatchFetchWindowSchema`, `BatchFetchWindowOutputSchema` (Task 4); `getGmailEmailAddress`, `listAllGmailMessageIds` (Task 2); `extractMessageParts`, `headerValue`, `MessagePart`, `MessageHeader` (Task 3).
- Produces:
  - `type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>`
  - `type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>`
  - `async function batchFetchWindow(gmail: gmail_v1.Gmail, input: BatchFetchWindowInput, now?: () => Date): Promise<BatchFetchWindowResult>`
  - Test helpers at module scope of `src/batch-fetch-window.test.ts`: `WATERMARK`, `BOUNDARY`, `EPOCH`, `WINDOW_QUERY`, `SPAM_QUERY`, `TRASH_QUERY`, `ANYWHERE_QUERY`, `FIXED_NOW`, `b64`, `httpError`, `message`, `fakeGmail`, `windowOnly`, `run`, `readJson`.

- [ ] **Step 1: Write the helpers and the failing test**

Extend the imports at the top of `src/batch-fetch-window.test.ts` to:

```ts
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchFetchWindow } from './batch-fetch-window.js';
import { hasScope } from './scopes.js';
```

(keep the existing `./tools.js` import). Then append:

```ts
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

function run(gmail: ReturnType<typeof fakeGmail>, dir: string, overrides: Record<string, unknown> = {}) {
  return batchFetchWindow(gmail as never, {
    watermark: WATERMARK,
    output_dir: dir,
    max_messages: 2000,
    cross_check: true,
    ...overrides,
  }, FIXED_NOW);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('batchFetchWindow: listing and numbered files', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists three pages, deduplicates, fetches each ID once, and writes ordered files', async () => {
    const gmail = fakeGmail({
      lists: {
        [WINDOW_QUERY]: [{ ids: ['b', 'a'] }, { ids: ['a', 'c'] }, { ids: [] }],
        [SPAM_QUERY]: [{ ids: [] }],
        [TRASH_QUERY]: [{ ids: [] }],
        [ANYWHERE_QUERY]: [{ ids: ['a', 'b', 'c'] }],
      },
      messages: {
        a: message('a', BOUNDARY + 1000),
        b: message('b', BOUNDARY + 3000),
        c: message('c', BOUNDARY + 2000),
      },
    });
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.pages).toBe(3);
    expect(result.listed).toBe(3);
    expect(result.inWindow).toBe(3);
    expect(result.listingComplete).toBe(true);
    expect(result.truncated).toBe(false);
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
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, cannot resolve `./batch-fetch-window.js`.

- [ ] **Step 3: Create the module with the minimal flow**

Create `src/batch-fetch-window.ts`. This first version lists, fetches every listed ID, keeps all of them, writes plain-text bodies, numbers with three digits, writes the two metadata files directly, and reports `ok`. Later tasks add filtering, body resolution, cross-check, failures, truncation, and atomic publication.

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { getGmailEmailAddress, listAllGmailMessageIds } from './gmail-sync.js';
import { extractMessageParts, headerValue, type MessageHeader, type MessagePart } from './message-body.js';
import { BatchFetchWindowOutputSchema, BatchFetchWindowSchema } from './tools.js';

export type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>;
export type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>;

type Failure = { id: string; error: string };

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
  const failures: Failure[] = [];
  const windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true });

  const base = {
    checkedAt: now().toISOString(),
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowList.ids.length,
    maxMessages: input.max_messages,
    listingComplete: windowList.complete,
  };

  const outputDir = input.output_dir;
  const messagesDir = path.join(outputDir, 'messages');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const windowMetadataPath = path.join(outputDir, 'window-metadata.json');
  fs.mkdirSync(messagesDir, { recursive: true });

  const kept: KeptMessage[] = [];
  const belowBoundaryOrExcluded = 0;
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

  const summary = {
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
  };

  writeJson(windowMetadataPath, {
    checkedAt: base.checkedAt,
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    messages: metadataMessages,
  });
  writeJson(manifestPath, { ...summary, messages: manifestMessages });

  const triage = manifestMessages.map(entry =>
    [entry.file, entry.from, entry.subject, entry.dateHeader, `${entry.attachments} att`].join(' | ')
  );
  return BatchFetchWindowOutputSchema.parse({ ...summary, status: 'ok', triage });
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`). Expected: one new file plus test.

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Add batchFetchWindow listing, fetching and numbered message files"
```

---

### Task 6: Output file shapes and the cross-check

**Files:**
- Modify: `src/batch-fetch-window.ts` (the `summary` block)
- Test: `src/batch-fetch-window.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 helpers and `batchFetchWindow`.
- Produces: `crossCheck` in the manifest and the result.

- [ ] **Step 1: Write the failing test**

Append to `src/batch-fetch-window.test.ts`:

```ts
describe('batchFetchWindow: output file shapes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the reference file shapes for message, manifest, and window metadata', async () => {
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
    expect(path.isAbsolute(manifest.messages[0].file)).toBe(true);

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
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: SPAM_QUERY }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: TRASH_QUERY }));
    expect(gmail.list).toHaveBeenCalledWith(expect.objectContaining({ q: ANYWHERE_QUERY }));
    const { crossCheck, messages, ...summary } = manifest;
    expect(messages).toHaveLength(1);
    expect(result).toEqual({ ...summary, crossCheck, status: 'ok', triage: result.triage });
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the manifest `toEqual` (no `crossCheck` key) and on the three `list` call assertions.

- [ ] **Step 3: Add the cross-check**

In `src/batch-fetch-window.ts`, replace the block

```ts
  const summary = {
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
  };
```

with

```ts
  const spam = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:spam`, includeSpamTrash: true })).ids);
  const trash = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:trash`, includeSpamTrash: true })).ids);
  const anywhere = new Set((await listAllGmailMessageIds(gmail, { query: `after:${epoch - 1} in:anywhere`, includeSpamTrash: true })).ids);
  const windowIds = new Set(windowList.ids);
  const unexplainedIds = [...anywhere].filter(id => !windowIds.has(id) && !spam.has(id) && !trash.has(id));
  const crossCheck = {
    window: windowList.ids.length,
    spam: spam.size,
    trash: trash.size,
    anywhere: anywhere.size,
    unexplainedIds,
    consistent: unexplainedIds.length === 0,
  };

  const summary = {
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
    crossCheck,
  };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Add the spam, trash and anywhere cross-check to batchFetchWindow"
```

---

### Task 7: The cross-check switch and the empty window

**Files:**
- Modify: `src/batch-fetch-window.ts` (the cross-check block)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe('batchFetchWindow: cross-check switch', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('skips the cross-check when disabled', async () => {
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [{ ids: [] }] } });
    const result = await run(gmail, dir, { cross_check: false });

    expect(result.status).toBe('ok');
    expect(result.crossCheck).toBeUndefined();
    expect(gmail.list).toHaveBeenCalledTimes(1);
    expect(readJson(path.join(dir, 'manifest.json')).crossCheck).toBeUndefined();
  });

  // Regression guard: passes already, because Task 5 writes empty arrays when nothing is listed.
  it('handles an empty window with status ok and empty files', async () => {
    const gmail = fakeGmail({ lists: windowOnly([]) });
    const result = await run(gmail, dir);

    expect(result.status).toBe('ok');
    expect(result.listed).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([]);
    expect(readJson(path.join(dir, 'manifest.json')).messages).toEqual([]);
    expect(readJson(path.join(dir, 'window-metadata.json')).messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on "skips the cross-check when disabled" with `unexpected query after:… in:spam` thrown by the fake. The empty-window guard passes.

- [ ] **Step 3: Honour `cross_check`**

In `src/batch-fetch-window.ts`, replace the block from `const spam = new Set(` through the closing of `const crossCheck = { … };` and the `summary` object with:

```ts
  let crossCheck: BatchFetchWindowResult['crossCheck'];
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

  const summary = {
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
    ...(crossCheck ? { crossCheck } : {}),
  };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Honour the cross_check switch in batchFetchWindow"
```

---

### Task 8: Boundary and label filtering

**Files:**
- Modify: `src/batch-fetch-window.ts` (the fetch loop)
- Test: `src/batch-fetch-window.test.ts` (append)

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
Expected: FAIL on both new cases: `inWindow` is 2 and `belowBoundaryOrExcluded` is 0.

- [ ] **Step 3: Filter by boundary and label**

In `src/batch-fetch-window.ts`, replace

```ts
  const kept: KeptMessage[] = [];
  const belowBoundaryOrExcluded = 0;
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

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Filter batchFetchWindow messages by boundary and spam or trash labels"
```

---

### Task 9: Body resolution

**Files:**
- Modify: `src/batch-fetch-window.ts` (imports and the write loop)
- Test: `src/batch-fetch-window.test.ts` (append)

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
Expected: FAIL on both: `body` is `''` because Task 5 uses only the inline plain-text part.

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

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Resolve deferred and HTML bodies in batchFetchWindow"
```

---

### Task 10: Rerun replacement and numbering width

**Files:**
- Modify: `src/batch-fetch-window.ts` (directory preparation and `width`)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('batchFetchWindow: rerun and numbering', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('replaces messages/ completely on rerun', async () => {
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages', '009.json'), '{}');
    const gmail = fakeGmail({ lists: windowOnly(['a']), messages: { a: message('a', BOUNDARY + 1) } });
    await run(gmail, dir);

    expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual(['001.json']);
  });

  it('widens padding to four digits when more than 999 messages survive', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `m${index}`);
    const messages = Object.fromEntries(ids.map((id, index) => [id, message(id, BOUNDARY + index)]));
    const gmail = fakeGmail({ lists: windowOnly(ids), messages });
    await run(gmail, dir, { cross_check: false });

    const files = fs.readdirSync(path.join(dir, 'messages')).sort();
    expect(files).toHaveLength(1000);
    expect(files[0]).toBe('0001.json');
    expect(files[999]).toBe('1000.json');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on both: the stale `009.json` survives, and the thousandth file is `1000.json` next to `001.json` so `files[0]` is `001.json`.

- [ ] **Step 3: Recreate `messages/` and widen the padding**

In `src/batch-fetch-window.ts`, replace

```ts
  fs.mkdirSync(messagesDir, { recursive: true });
```

with

```ts
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
```

and replace

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

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Recreate messages/ on every batchFetchWindow run and widen numbering"
```

---

### Task 11: Per-message and body-part failures, with authentication failures rethrown

**Files:**
- Modify: `src/batch-fetch-window.ts` (imports, the fetch loop, the write loop, the status)
- Test: `src/batch-fetch-window.test.ts` (append)

This task introduces the first tolerant `catch` in the module, so it also introduces the rule that every tolerant catch calls `isAuthError` first and rethrows; the two never ship apart.

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
    expect(fs.readdirSync(path.join(dir, 'messages')).sort()).toEqual(['001.json', '002.json']);
  });

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

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first two: the 500 case rejects with `HTTP 500` because the fetch loop has no catch; the body-part case reports `status` `ok` with empty `failures`. The 401 and 403 `messages.get` cases pass at this point only because there is no catch yet; they exist to fail the moment Step 3 adds a catch without the `isAuthError` rethrow, so keep them and confirm they still pass after Step 3. The two guards pass.

- [ ] **Step 3: Record failures, rethrow auth failures, and derive the status**

In `src/batch-fetch-window.ts`, change the `./gmail-sync.js` import to:

```ts
import { failureCode, getGmailEmailAddress, isAuthError, listAllGmailMessageIds } from './gmail-sync.js';
```

Replace the fetch loop

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

In the write loop, after the `const resolved = await resolveMessageBody(...)` line add:

```ts
    for (const failure of resolved.failures) {
      failures.push({ id, error: failure.code });
    }
```

Replace the final `return` with:

```ts
  const status = failures.length > 0 ? 'incomplete' : 'ok';
  return BatchFetchWindowOutputSchema.parse({ ...summary, status, triage });
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Record per-message and body-part failures in batchFetchWindow and rethrow auth failures"
```

---

### Task 12: Cross-check inconsistency and cross-check listing failures

**Files:**
- Modify: `src/batch-fetch-window.ts` (new `crossCheckListing` helper, the cross-check block, the status)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first three: the first reports `ok`; the second rejects with `HTTP 503`; the third reports `ok` with empty `failures` because a partial cross-check listing is silently accepted. The 401 case passes at this point only because there is no catch around the cross-check yet; it exists to fail the moment Step 3 adds a catch without the `isAuthError` rethrow, so keep it and confirm it still passes after Step 3.

- [ ] **Step 3: Tolerate cross-check failures, rethrow auth failures, and fold consistency into the status**

In `src/batch-fetch-window.ts`, add above `export async function batchFetchWindow`:

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

Replace the three `const spam/trash/anywhere = new Set((await listAllGmailMessageIds(...)).ids);` lines inside `if (input.cross_check)` with:

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

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Tolerate cross-check listing failures and report inconsistency"
```

---

### Task 13: Truncation

**Files:**
- Modify: `src/batch-fetch-window.ts` (after the window listing, before directory preparation)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

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
    expect(result.listed).toBe(5);
    expect(result.pages).toBe(3);
    expect(result.listingComplete).toBe(true);
    expect(result.crossCheck).toBeUndefined();
    expect(gmail.get).not.toHaveBeenCalled();
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
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on both: the fake throws `unexpected message a` because the tool tries to fetch, and the old files are replaced.

- [ ] **Step 3: Stop at the cap**

In `src/batch-fetch-window.ts`, insert directly after the `const base = { … };` object and before `const outputDir = input.output_dir;`:

```ts
  if (windowList.ids.length > input.max_messages) {
    return BatchFetchWindowOutputSchema.parse({
      ...base,
      status: 'truncated',
      truncated: true,
      inWindow: 0,
      belowBoundaryOrExcluded: 0,
      failures,
      triage: [],
    });
  }
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Return a truncated result from batchFetchWindow above max_messages"
```

---

### Task 14: Partial window listings

**Files:**
- Modify: `src/batch-fetch-window.ts` (after the window listing; the truncation status)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

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

  // Regression guard: passes already, because Task 2's lister rethrows a first-page failure.
  it('rejects when the first window page fails and writes nothing', async () => {
    const failure = new Error('network down');
    const gmail = fakeGmail({ lists: { [WINDOW_QUERY]: [failure] } });
    await expect(run(gmail, dir)).rejects.toBe(failure);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first three: `failures` is empty and `status` is `ok` for the first two; the third reports `truncated` instead of `incomplete`. The first-page guard passes.

- [ ] **Step 3: Record the listing failure and apply status precedence**

In `src/batch-fetch-window.ts`, directly after the `const windowList = await listAllGmailMessageIds(...)` line add:

```ts
  if (!windowList.complete && windowList.error) {
    failures.push({ id: `window-listing:page-${windowList.pages + 1}`, error: failureCode(windowList.error) });
  }
```

In the truncation block replace

```ts
      status: 'truncated',
```

with

```ts
      status: failures.length > 0 ? 'incomplete' : 'truncated',
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Record partial window listings in batchFetchWindow with status precedence"
```

---

### Task 15: Metadata deletion and atomic publication

**Files:**
- Modify: `src/batch-fetch-window.ts` (directory preparation, `writeJson` for the two metadata files)
- Test: `src/batch-fetch-window.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('batchFetchWindow: metadata deletion and atomic publication', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

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
    expect(result.status).toBe('ok');
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

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL on the first three: the old `manifest.json` survives the failed rerun; the two publish-failure cases never throw `disk full` because no `.publish-` temporary is written, so `manifest.json` exists when it must not, and in the third case `window-metadata.json` exists when it must not. The ownership case is a regression guard: it passes already because nothing outside the three owned paths is ever touched, and it protects that property against the change in Step 3.

Known subtlety: `vi.spyOn(fs, 'writeFileSync')` works because both the test and the module import the same default `fs` object from `node:fs`. If the spy does not intercept, check that `src/batch-fetch-window.ts` uses `import fs from 'node:fs'` and calls `fs.writeFileSync`, not a destructured import.

- [ ] **Step 3: Delete the owned metadata first and publish by rename**

In `src/batch-fetch-window.ts`, replace

```ts
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
```

with

```ts
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(windowMetadataPath, { force: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
```

Add below the existing `writeJson` helper:

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

Replace the two metadata writes

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

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm test` then `npm run typecheck`. Expected: both clean.

- [ ] **Step 6: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`).

```bash
git add src/batch-fetch-window.ts src/batch-fetch-window.test.ts
git commit -m "Delete owned metadata before fetching and publish it atomically"
```

---

### Task 16: Server wiring and documentation

**Files:**
- Modify: `src/index.ts:22-27` (imports) and `src/index.ts:604-609` (add a `case` after `batch_get_gmail_index_metadata`)
- Modify: `README.md:319-331` and `README.md:381-392`
- Modify: `docs/gmail-cli-spec.md:9-10`
- Modify: `src/batch-fetch-window.ts` (add `handleBatchFetchWindow`)
- Test: `src/batch-fetch-window.test.ts` (append a behavioural handler test)

**Interfaces:**
- Consumes: `batchFetchWindow` (Tasks 5 to 15), `BatchFetchWindowSchema` (Task 4), `structuredResult` (existing).
- Produces: `async function handleBatchFetchWindow(gmail: gmail_v1.Gmail, args: unknown, now?: () => Date): Promise<ReturnType<typeof structuredResult>>` in `src/batch-fetch-window.ts`.

- [ ] **Step 1: Run impact analysis**

Run GitNexus `impact` with `target: "main"` (the `src/index.ts` entry point that contains the request handler), `direction: "upstream"`. Record the reported risk. Adding a `case` inside the `CallToolRequestSchema` handler is expected to be LOW; if HIGH or CRITICAL is reported, stop and report before editing.

- [ ] **Step 2: Write the failing handler test**

Append to `src/batch-fetch-window.test.ts` (add `handleBatchFetchWindow` to the import from `./batch-fetch-window.js`, and `ZodError` from `zod`):

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

- [ ] **Step 3: Run the test file to verify it fails**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: FAIL, `handleBatchFetchWindow` is not exported.

- [ ] **Step 4: Add the handler function and wire it**

In `src/batch-fetch-window.ts`, extend the import from `./gmail-sync.js` to include `structuredResult`, and append at the end of the file:

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

Keep the existing indentation of the surrounding cases. The `index.ts` `switch` cannot be unit-tested without starting the server, so the real dispatch is verified end-to-end by the smoke run in Task 17, which calls the tool through the MCP client against `dist/index.js`.

- [ ] **Step 5: Run the test file to verify it passes**

Run: `npx vitest run src/batch-fetch-window.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the README**

In `README.md`, replace the line

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

After the table row for `batch_get_gmail_index_metadata` in the "Structured index synchronisation tools" section, add this row:

```
| `batch_fetch_window` | `watermark` (ISO 8601 with zone); `output_dir` (absolute); optional `max_messages` (default 2000); optional `cross_check` (default true) | Status (`ok`, `incomplete`, `truncated`), counts, failures, cross-check summary and a triage list; writes `messages/NNN.json`, `manifest.json` and `window-metadata.json` under `output_dir` |
```

Then replace the paragraph that begins `The tools never request or return subjects` with:

```
The first four tools never request or return subjects, addresses, snippets, headers, bodies, attachments, or raw message content. Metadata batches retry only Gmail HTTP 429 and 5xx responses, with a maximum of three attempts. `batch_fetch_window` is the exception: it downloads full messages to disk and returns only headers in its triage lines. It deletes and recreates `messages/` and overwrites the two JSON files under `output_dir` on every run, touches nothing else there, and reports `readOnlyHint: false` because of those writes.
```

Also change the sentence `These four read-only tools support deterministic mailbox indexing without returning email content:` to `These tools support deterministic mailbox indexing:`.

- [ ] **Step 7: Add the note to the CLI spec**

In `docs/gmail-cli-spec.md`, after the paragraph ending `...which needs scripted "list every message since watermark" and "read message in full" operations.` (line 10), insert a blank line and:

```
Note (2026-09-11): the routine PA pass now uses the `batch_fetch_window` MCP tool (see
`docs/superpowers/specs/2026-09-11-batch-fetch-window-design.md`); the CLIs below remain
optional, for targeted reads.
```

- [ ] **Step 8: Run the whole suite, the type check, and the build**

Run: `npm test`, then `npm run typecheck`, then `npm run build`. Expected: all clean, and `dist/batch-fetch-window.js` and `dist/message-body.js` exist.

- [ ] **Step 9: Check scope and commit**

Run GitNexus `detect_changes` (scope `all`). Expected: the request handler in `src/index.ts` changed; affected process is tool dispatch.

```bash
git add src/index.ts src/batch-fetch-window.ts src/batch-fetch-window.test.ts README.md docs/gmail-cli-spec.md
git commit -m "Wire batch_fetch_window into the server and document it"
```

---

### Task 17: Smoke run against the real mailbox

**Files:**
- Create: `tmp/smoke-batch-fetch-window.mjs` (the `tmp/` directory is gitignored; nothing in this task is committed)

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

Run: `git status --short` and confirm nothing is left uncommitted except `tmp/`.
Run: `npm test` one final time and paste the summary line.

The report must include: the exact test command and its summary output, the smoke stdout JSON (already redacted by the script), and the nine deviations from the reference listed under "Deviations from the reference" in the design document, repeated verbatim.
