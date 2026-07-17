import { setTimeout as wait } from 'node:timers/promises';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  BatchGetGmailIndexMetadataSchema,
  GmailIndexMetadataOutputSchema,
} from './tools.js';

const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
const REQUEST_BOUNDARY = 'batch_gmail_index';
const MAX_ATTEMPTS = 3;

type Sleep = (milliseconds: number) => Promise<unknown>;

type PendingMessage = {
  id: string;
  contentId: string;
};

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index === -1) {
    throw new Error('Malformed Gmail batch response');
  }
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }

  const response = error.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) {
    return undefined;
  }

  return typeof response.status === 'number' ? response.status : undefined;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function buildRequestBody(pending: PendingMessage[]): string {
  const parts = pending.map(({ id, contentId }) => [
    `--${REQUEST_BOUNDARY}`,
    'Content-Type: application/http',
    `Content-ID: <${contentId}>`,
    '',
    `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&fields=id%2CinternalDate%2ClabelIds HTTP/1.1`,
    '',
    '',
  ].join('\r\n'));

  return `${parts.join('')}--${REQUEST_BOUNDARY}--\r\n`;
}

function responseBoundary(contentType: string | null): string {
  const match = contentType?.match(/boundary="?([^";]+)"?/i);
  if (!match) {
    throw new Error('Gmail batch response omitted its multipart boundary');
  }
  return match[1];
}

function parseBatchResponse(
  body: string,
  boundary: string,
  pending: PendingMessage[],
) {
  const pendingByContentId = new Map(pending.map(item => [item.contentId, item]));
  const seen = new Set<string>();
  const messages = new Map<string, z.infer<typeof GmailIndexMetadataOutputSchema>['messages'][number]>();
  const missing = new Set<string>();
  const retry: PendingMessage[] = [];

  for (const rawPart of body.split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith('--')) {
      break;
    }

    const part = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (!part) {
      continue;
    }

    const [partHeaders, embeddedResponse] = splitOnce(part, '\r\n\r\n');
    const contentIdMatch = partHeaders.match(/^Content-ID:\s*<response-(gmail-index-\d+)>\s*$/im);
    if (!contentIdMatch) {
      throw new Error('Gmail batch response has an invalid Content-ID');
    }

    const contentId = contentIdMatch[1];
    const requested = pendingByContentId.get(contentId);
    if (!requested) {
      throw new Error(`Gmail batch response returned unexpected Content-ID ${contentId}`);
    }
    if (seen.has(contentId)) {
      throw new Error(`Gmail batch response duplicated Content-ID ${contentId}`);
    }
    seen.add(contentId);

    const statusMatch = embeddedResponse.match(/^HTTP\/1\.1\s+(\d{3})\b/);
    if (!statusMatch) {
      throw new Error(`Gmail batch response omitted HTTP status for ${requested.id}`);
    }
    const status = Number(statusMatch[1]);
    const [, responseBody] = splitOnce(embeddedResponse, '\r\n\r\n');

    if (status === 200) {
      const rawMessage = JSON.parse(responseBody.trim()) as Record<string, unknown>;
      const parsed = GmailIndexMetadataOutputSchema.parse({
        messages: [{
          ...rawMessage,
          labelIds: rawMessage.labelIds ?? [],
        }],
        missingMessageIds: [],
      }).messages[0];
      if (parsed.id !== requested.id) {
        throw new Error(`Gmail batch response ID ${parsed.id} does not match ${requested.id}`);
      }
      messages.set(contentId, parsed);
    } else if (status === 404) {
      missing.add(contentId);
    } else if (isTransientStatus(status)) {
      retry.push(requested);
    } else {
      throw new Error(`Gmail batch request for ${requested.id} failed with HTTP ${status}`);
    }
  }

  if (seen.size !== pending.length) {
    throw new Error('Gmail batch response is missing response parts');
  }

  return { messages, missing, retry };
}

export async function batchGetGmailIndexMetadata(
  auth: OAuth2Client,
  messageIds: string[],
  sleep: Sleep = wait,
) {
  const input = BatchGetGmailIndexMetadataSchema.parse({ messageIds });
  let pending = input.messageIds.map((id, index) => ({
    id,
    contentId: `gmail-index-${index}`,
  }));
  const messages = new Map<string, z.infer<typeof GmailIndexMetadataOutputSchema>['messages'][number]>();
  const missing = new Set<string>();

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    if (attemptNumber > 1) {
      await sleep(200 * 2 ** (attemptNumber - 2));
    }

    let response;
    try {
      response = await auth.request<string>({
        url: BATCH_URL,
        method: 'POST',
        headers: { 'Content-Type': `multipart/mixed; boundary=${REQUEST_BOUNDARY}` },
        data: buildRequestBody(pending),
        responseType: 'text',
      });
    } catch (error) {
      const status = responseStatus(error);
      if (status !== undefined && isTransientStatus(status) && attemptNumber < MAX_ATTEMPTS) {
        continue;
      }
      if (status !== undefined && isTransientStatus(status)) {
        throw new Error('Gmail batch failed after three attempts');
      }
      throw error;
    }

    const responseHeaders = response.headers as unknown as {
      get?: (name: string) => string | null;
      'content-type'?: string;
    };
    const contentType = typeof responseHeaders.get === 'function'
      ? responseHeaders.get('content-type')
      : responseHeaders['content-type'] ?? null;
    const dispositions = parseBatchResponse(
      String(response.data),
      responseBoundary(contentType),
      pending,
    );
    for (const [contentId, message] of dispositions.messages) {
      messages.set(contentId, message);
    }
    for (const contentId of dispositions.missing) {
      missing.add(contentId);
    }

    pending = dispositions.retry;
    if (pending.length === 0) {
      const ordered = input.messageIds.map((_, index) => `gmail-index-${index}`);
      return GmailIndexMetadataOutputSchema.parse({
        messages: ordered.flatMap(contentId => {
          const message = messages.get(contentId);
          return message ? [message] : [];
        }),
        missingMessageIds: ordered.flatMap((contentId, index) =>
          missing.has(contentId) ? [input.messageIds[index]] : []
        ),
      });
    }
  }

  throw new Error('Gmail batch failed after three attempts');
}
