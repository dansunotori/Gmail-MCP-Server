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
