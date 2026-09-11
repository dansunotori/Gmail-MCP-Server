import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  GmailRequestError,
  failureCode,
  getGmailEmailAddress,
  getGmailProfile,
  isAuthError,
  listAllGmailMessageIds,
  listGmailAddedHistory,
  listGmailMessageIds,
  structuredResult,
  toGmailRequestError,
} from './gmail-sync.js';
import { hasScope } from './scopes.js';
import {
  BatchGetGmailIndexMetadataSchema,
  GetGmailProfileSchema,
  GmailAddedHistoryOutputSchema,
  GmailIndexMetadataOutputSchema,
  GmailMessageIdsOutputSchema,
  GmailProfileOutputSchema,
  ListGmailAddedHistorySchema,
  ListGmailMessageIdsSchema,
  getToolByName,
  toMcpTools,
  toolDefinitions,
} from './tools.js';

const toolNames = [
  'get_gmail_profile',
  'list_gmail_message_ids',
  'list_gmail_added_history',
  'batch_get_gmail_index_metadata',
] as const;

describe('Gmail sync input contracts', () => {
  it('accepts the supported inputs and defaults page sizes', () => {
    expect(GetGmailProfileSchema.parse({})).toEqual({});
    expect(ListGmailMessageIdsSchema.parse({ pageToken: 'next' })).toEqual({
      pageToken: 'next',
      maxResults: 500,
    });
    expect(ListGmailAddedHistorySchema.parse({ startHistoryId: '123' })).toEqual({
      startHistoryId: '123',
      maxResults: 500,
    });
    expect(BatchGetGmailIndexMetadataSchema.parse({ messageIds: ['m1'] })).toEqual({
      messageIds: ['m1'],
    });
  });

  it('rejects unknown fields, empty identifiers, and out-of-range batches', () => {
    expect(() => GetGmailProfileSchema.parse({ extra: true })).toThrow();
    expect(() => ListGmailMessageIdsSchema.parse({ pageToken: '' })).toThrow();
    expect(() => ListGmailMessageIdsSchema.parse({ maxResults: 501 })).toThrow();
    expect(() => ListGmailAddedHistorySchema.parse({ startHistoryId: '' })).toThrow();
    expect(() => ListGmailAddedHistorySchema.parse({ startHistoryId: '1', maxResults: 0 })).toThrow();
    expect(() => BatchGetGmailIndexMetadataSchema.parse({ messageIds: [] })).toThrow();
    expect(() => BatchGetGmailIndexMetadataSchema.parse({
      messageIds: Array.from({ length: 51 }, (_, index) => `m${index}`),
    })).toThrow();
  });
});

describe('Gmail sync output contracts', () => {
  it('accepts only the minimal profile, list, and metadata shapes', () => {
    expect(GmailProfileOutputSchema.parse({ historyId: '123' })).toEqual({ historyId: '123' });
    expect(GmailMessageIdsOutputSchema.parse({
      messageIds: ['m1'],
      nextPageToken: 'next',
    })).toEqual({ messageIds: ['m1'], nextPageToken: 'next' });
    expect(GmailIndexMetadataOutputSchema.parse({
      messages: [{ id: 'm1', internalDate: '1710000000000', labelIds: ['INBOX'] }],
      missingMessageIds: ['gone'],
    })).toEqual({
      messages: [{ id: 'm1', internalDate: '1710000000000', labelIds: ['INBOX'] }],
      missingMessageIds: ['gone'],
    });

    expect(() => GmailProfileOutputSchema.parse({ historyId: '123', emailAddress: 'hidden' })).toThrow();
    expect(() => GmailIndexMetadataOutputSchema.parse({
      messages: [{ id: 'm1', internalDate: 'not-a-date', labelIds: [] }],
      missingMessageIds: [],
    })).toThrow();
  });

  it('enforces the two exact history result variants', () => {
    expect(GmailAddedHistoryOutputSchema.parse({
      status: 'ok',
      messageIds: ['m1'],
      historyId: '456',
    })).toEqual({ status: 'ok', messageIds: ['m1'], historyId: '456' });
    expect(GmailAddedHistoryOutputSchema.parse({
      status: 'cursor_expired',
      startHistoryId: '123',
    })).toEqual({ status: 'cursor_expired', startHistoryId: '123' });

    expect(() => GmailAddedHistoryOutputSchema.parse({ status: 'ok', messageIds: [] })).toThrow();
    expect(() => GmailAddedHistoryOutputSchema.parse({
      status: 'cursor_expired',
      startHistoryId: '123',
      messageIds: [],
    })).toThrow();
  });
});

describe('Gmail sync tool definitions', () => {
  it.each(toolNames)('registers %s as a structured read-only tool', (name) => {
    const tool = getToolByName(name);
    expect(tool).toBeDefined();
    expect(tool!.scopes).toEqual(['gmail.readonly', 'gmail.modify']);
    expect(tool!.annotations.readOnlyHint).toBe(true);
    expect(tool!.outputSchema).toBeDefined();
    expect(hasScope(['gmail.full'], tool!.scopes)).toBe(true);
  });

  it('advertises a complete MCP-valid tool list including output schemas', () => {
    const tools = toMcpTools(toolDefinitions);
    expect(() => ListToolsResultSchema.parse({ tools })).not.toThrow();
    for (const name of toolNames) {
      expect(tools.find(tool => tool.name === name)?.outputSchema).toBeDefined();
    }
  });
});

function gmailWith(overrides: {
  getProfile?: ReturnType<typeof vi.fn>;
  listMessages?: ReturnType<typeof vi.fn>;
  listHistory?: ReturnType<typeof vi.fn>;
}) {
  return {
    users: {
      getProfile: overrides.getProfile ?? vi.fn(),
      messages: { list: overrides.listMessages ?? vi.fn() },
      history: { list: overrides.listHistory ?? vi.fn() },
    },
  };
}

describe('getGmailProfile', () => {
  it('requests only the history cursor', async () => {
    const getProfile = vi.fn().mockResolvedValue({ data: { historyId: '123' } });
    const result = await getGmailProfile(gmailWith({ getProfile }) as never);

    expect(getProfile).toHaveBeenCalledWith({ userId: 'me', fields: 'historyId' });
    expect(result).toEqual({ historyId: '123' });
  });

  it('fails when Gmail omits the history cursor', async () => {
    const gmail = gmailWith({ getProfile: vi.fn().mockResolvedValue({ data: {} }) });
    await expect(getGmailProfile(gmail as never)).rejects.toThrow('historyId');
  });
});

describe('listGmailMessageIds', () => {
  it('lists one page without spam or trash and deduplicates IDs in order', async () => {
    const listMessages = vi.fn().mockResolvedValue({
      data: {
        messages: [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }],
        nextPageToken: 'next',
      },
    });

    const result = await listGmailMessageIds(gmailWith({ listMessages }) as never, {
      pageToken: 'page-2',
      maxResults: 500,
    });

    expect(listMessages).toHaveBeenCalledWith({
      userId: 'me',
      maxResults: 500,
      pageToken: 'page-2',
      includeSpamTrash: false,
      fields: 'messages/id,nextPageToken',
    });
    expect(result).toEqual({ messageIds: ['m1', 'm2'], nextPageToken: 'next' });
  });

  it('returns an empty final page and rejects entries without IDs', async () => {
    const empty = gmailWith({ listMessages: vi.fn().mockResolvedValue({ data: {} }) });
    await expect(listGmailMessageIds(empty as never, { maxResults: 500 })).resolves.toEqual({
      messageIds: [],
    });

    const malformed = gmailWith({
      listMessages: vi.fn().mockResolvedValue({ data: { messages: [{}] } }),
    });
    await expect(listGmailMessageIds(malformed as never, { maxResults: 500 })).rejects.toThrow('message id');
  });
});

describe('listGmailAddedHistory', () => {
  it('requests only message-added IDs and returns the page cursor', async () => {
    const listHistory = vi.fn().mockResolvedValue({
      data: {
        history: [{
          messagesAdded: [
            { message: { id: 'm1' } },
            { message: { id: 'm1' } },
            { message: { id: 'm2' } },
          ],
        }],
        nextPageToken: 'next',
        historyId: '456',
      },
    });

    const result = await listGmailAddedHistory(gmailWith({ listHistory }) as never, {
      startHistoryId: '123',
      maxResults: 500,
    });

    expect(listHistory).toHaveBeenCalledWith({
      userId: 'me',
      startHistoryId: '123',
      maxResults: 500,
      pageToken: undefined,
      historyTypes: ['messageAdded'],
      fields: 'history/messagesAdded/message/id,nextPageToken,historyId',
    });
    expect(result).toEqual({
      status: 'ok',
      messageIds: ['m1', 'm2'],
      nextPageToken: 'next',
      historyId: '456',
    });
  });

  it('returns a distinct cursor-expired result for history HTTP 404', async () => {
    const gmail = gmailWith({
      listHistory: vi.fn().mockRejectedValue({ response: { status: 404 } }),
    });

    await expect(listGmailAddedHistory(gmail as never, {
      startHistoryId: '123',
      maxResults: 500,
    })).resolves.toEqual({ status: 'cursor_expired', startHistoryId: '123' });
  });

  it('rejects malformed history and rethrows non-404 failures', async () => {
    const missingCursor = gmailWith({
      listHistory: vi.fn().mockResolvedValue({ data: { history: [] } }),
    });
    await expect(listGmailAddedHistory(missingCursor as never, {
      startHistoryId: '123',
      maxResults: 500,
    })).rejects.toThrow('historyId');

    const missingMessageId = gmailWith({
      listHistory: vi.fn().mockResolvedValue({
        data: { history: [{ messagesAdded: [{ message: {} }] }], historyId: '456' },
      }),
    });
    await expect(listGmailAddedHistory(missingMessageId as never, {
      startHistoryId: '123',
      maxResults: 500,
    })).rejects.toThrow('message id');

    const failure = new Error('permission denied');
    const denied = gmailWith({ listHistory: vi.fn().mockRejectedValue(failure) });
    await expect(listGmailAddedHistory(denied as never, {
      startHistoryId: '123',
      maxResults: 500,
    })).rejects.toBe(failure);
  });
});

describe('structuredResult', () => {
  it('returns identical text and structured representations', () => {
    const value = { historyId: '123' };
    expect(structuredResult(value)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    });
  });
});

describe('Gmail sync server wiring', () => {
  it('dispatches all four tools through the focused sync modules', () => {
    const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const name of toolNames) {
      expect(source).toContain(`case "${name}"`);
    }
    expect(source).toContain('getGmailProfile(gmail)');
    expect(source).toContain('listGmailMessageIds(gmail, validatedArgs)');
    expect(source).toContain('listGmailAddedHistory(gmail, validatedArgs)');
    expect(source).toContain('batchGetGmailIndexMetadata(oauth2Client, validatedArgs.messageIds)');
  });

  it('accepts omitted arguments for tools with no required inputs', () => {
    const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('GetGmailProfileSchema.parse(args ?? {})');
    expect(source).toContain('ListGmailMessageIdsSchema.parse(args ?? {})');
  });

  it('marks shared tool failures as MCP error results', () => {
    const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/catch \(error: any\)[\s\S]*?isError: true/);
  });
});

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
