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

// Renders `error.code || error.response?.status || error.name`, the documented manifest
// failure-string format. Works the same on a raw error and on a GmailRequestError wrapper,
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
