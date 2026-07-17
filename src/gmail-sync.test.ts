import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  getGmailProfile,
  listGmailAddedHistory,
  listGmailMessageIds,
  structuredResult,
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
