import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import {
  GmailAddedHistoryOutputSchema,
  GmailMessageIdsOutputSchema,
  GmailProfileOutputSchema,
  ListGmailAddedHistorySchema,
  ListGmailMessageIdsSchema,
} from './tools.js';

type ListMessageIdsInput = z.infer<typeof ListGmailMessageIdsSchema>;
type ListAddedHistoryInput = z.infer<typeof ListGmailAddedHistorySchema>;

function requiredId(value: string | null | undefined, description: string): string {
  if (!value) {
    throw new Error(`Gmail response omitted ${description}`);
  }
  return value;
}

function hasResponseStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return false;
  }

  const response = error.response;
  return typeof response === 'object'
    && response !== null
    && 'status' in response
    && response.status === status;
}

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

// `failureCode` prefers `error.code` as the failure string; gaxios sets it to the HTTP
// status as a string, Node sets it to a network code such as ECONNRESET.
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

// Renders `error.code || error.response?.status || error.name`, the failure-string format
// written into batch_fetch_window results and manifests. Works the same on a raw error and on a GmailRequestError wrapper,
// because the wrapper keeps `code` and `cause`. `reason` is deliberately not consulted here.
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

// Node network error codes for a connection that was reset, refused, timed out or could not
// be resolved. A request that never reached Gmail can safely be repeated.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Transient: Gmail asks for a retry on 429 and on a 403 carrying a rate-limit reason, a 5xx
// is a server-side hiccup, and a network-level failure means the request may never have
// arrived. Everything else (auth, 404, any other 4xx) is thrown to the caller on the first
// attempt so a missing message or a bad request is reported once.
export function isRetryableGmailError(error: unknown): boolean {
  const wrapped = toGmailRequestError(error);
  if (wrapped.status === 429) {
    return true;
  }
  if (wrapped.status !== undefined && wrapped.status >= 500 && wrapped.status <= 599) {
    return true;
  }
  if (wrapped.status === 403) {
    return wrapped.reason !== undefined && RATE_LIMIT_REASONS.has(wrapped.reason);
  }
  return wrapped.status === undefined && wrapped.code !== undefined && NETWORK_ERROR_CODES.has(wrapped.code);
}

// Retry policy: total calls per request, the ceiling of the first backoff, and the ceiling
// every later backoff (and any Retry-After) is capped at.
export const GMAIL_RETRY_MAX_ATTEMPTS = 5;
export const GMAIL_RETRY_BASE_DELAY_MS = 500;
export const GMAIL_RETRY_MAX_DELAY_MS = 30_000;

export interface GmailRetryOptions {
  // Total calls including the first; default GMAIL_RETRY_MAX_ATTEMPTS.
  attempts?: number;
  // Ceiling of the wait before the first retry; the ceiling doubles on each further retry
  // and the actual wait is a uniformly random fraction of it (full jitter). Default
  // GMAIL_RETRY_BASE_DELAY_MS.
  baseDelayMs?: number;
  // Cap on every wait, including one taken from a Retry-After header. Default GMAIL_RETRY_MAX_DELAY_MS.
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Source of the jitter fraction in [0, 1); default Math.random.
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// How many calls withGmailRetry made before it threw a given error. Kept beside the error
// rather than on it so the helper can rethrow the caller's error object unchanged.
const attemptsByError = new WeakMap<object, number>();

export function retryAttempts(error: unknown): number {
  return (typeof error === 'object' && error !== null ? attemptsByError.get(error) : undefined) ?? 1;
}

// gaxios responses carry a fetch Headers object; a plain record is accepted as well.
function readRetryAfterHeader(error: unknown): string | undefined {
  const headers = (error as { response?: { headers?: unknown } })?.response?.headers;
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('retry-after') ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  return typeof raw === 'string' ? raw : undefined;
}

// Retry-After as delay seconds or an HTTP date; undefined when absent or unparseable.
function retryAfterMs(error: unknown): number | undefined {
  const raw = readRetryAfterHeader(error);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function withGmailRetry<T>(
  request: () => Promise<T>,
  options: GmailRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? GMAIL_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? GMAIL_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? GMAIL_RETRY_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (typeof error === 'object' && error !== null) {
        attemptsByError.set(error, attempt);
      }
      if (attempt >= attempts || !isRetryableGmailError(error)) {
        throw error;
      }
      const requested = retryAfterMs(error);
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(requested === undefined ? Math.round(random() * ceiling) : Math.min(maxDelayMs, requested));
    }
  }
}

export async function getGmailProfile(gmail: gmail_v1.Gmail) {
  const response = await gmail.users.getProfile({
    userId: 'me',
    fields: 'historyId',
  });

  return GmailProfileOutputSchema.parse({
    historyId: requiredId(response.data.historyId, 'historyId'),
  });
}

export async function listGmailMessageIds(
  gmail: gmail_v1.Gmail,
  input: ListMessageIdsInput,
) {
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: input.maxResults,
    pageToken: input.pageToken,
    includeSpamTrash: false,
    fields: 'messages/id,nextPageToken',
  });

  const messageIds = Array.from(new Set(
    (response.data.messages ?? []).map(message =>
      requiredId(message.id, 'message id')
    ),
  ));

  return GmailMessageIdsOutputSchema.parse({
    messageIds,
    ...(response.data.nextPageToken
      ? { nextPageToken: response.data.nextPageToken }
      : {}),
  });
}

export interface ListAllMessageIdsOptions {
  query: string;
  includeSpamTrash: boolean;
  limit?: number;
  retry?: GmailRetryOptions;
}

export interface ListAllMessageIdsResult {
  ids: string[];
  pages: number;
  hasMore: boolean;
  // False when a page failed after its retries; `error`, `failedPage` (1-based) and
  // `attempts` (calls made for that page) then describe the failure. Auth errors are thrown.
  complete: boolean;
  error?: GmailRequestError;
  failedPage?: number;
  attempts?: number;
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
      response = await withGmailRetry(() => gmail.users.messages.list({
        userId: 'me',
        q: options.query,
        includeSpamTrash: options.includeSpamTrash,
        maxResults,
        pageToken,
        fields: 'messages/id,nextPageToken',
      }), options.retry);
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      return {
        ids,
        pages,
        hasMore: false,
        complete: false,
        error: toGmailRequestError(error),
        failedPage: pages + 1,
        attempts: retryAttempts(error),
      };
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

export async function listGmailAddedHistory(
  gmail: gmail_v1.Gmail,
  input: ListAddedHistoryInput,
) {
  try {
    const response = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: input.startHistoryId,
      maxResults: input.maxResults,
      pageToken: input.pageToken,
      historyTypes: ['messageAdded'],
      fields: 'history/messagesAdded/message/id,nextPageToken,historyId',
    });

    const messageIds = Array.from(new Set(
      (response.data.history ?? []).flatMap(record =>
        (record.messagesAdded ?? []).map(entry =>
          requiredId(entry.message?.id, 'message id')
        )
      ),
    ));

    return GmailAddedHistoryOutputSchema.parse({
      status: 'ok',
      messageIds,
      ...(response.data.nextPageToken
        ? { nextPageToken: response.data.nextPageToken }
        : {}),
      historyId: requiredId(response.data.historyId, 'historyId'),
    });
  } catch (error) {
    if (hasResponseStatus(error, 404)) {
      return GmailAddedHistoryOutputSchema.parse({
        status: 'cursor_expired',
        startHistoryId: input.startHistoryId,
      });
    }
    throw error;
  }
}

export function structuredResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
