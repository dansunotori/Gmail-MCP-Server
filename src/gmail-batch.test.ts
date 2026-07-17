import { describe, expect, it, vi } from 'vitest';
import { batchGetGmailIndexMetadata } from './gmail-batch.js';

const RESPONSE_BOUNDARY = 'batch_response';

function part(
  index: number,
  status: number,
  body?: Record<string, unknown>,
): string {
  const reason = status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Unavailable';
  return [
    `--${RESPONSE_BOUNDARY}`,
    'Content-Type: application/http',
    `Content-ID: <response-gmail-index-${index}>`,
    '',
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    body === undefined ? '' : JSON.stringify(body),
  ].join('\r\n');
}

function batchResponse(parts: string[]) {
  return {
    data: `${parts.join('\r\n')}\r\n--${RESPONSE_BOUNDARY}--\r\n`,
    headers: new Headers({
      'content-type': `multipart/mixed; boundary=${RESPONSE_BOUNDARY}`,
    }),
  };
}

function message(id: string, labelIds?: string[] | null) {
  return {
    id,
    internalDate: '1710000000000',
    ...(labelIds === undefined ? {} : { labelIds }),
  };
}

describe('batchGetGmailIndexMetadata', () => {
  it('requests only index metadata and preserves request order', async () => {
    const request = vi.fn().mockResolvedValue(batchResponse([
      part(1, 200, message('m/2', ['SENT'])),
      part(0, 200, message('m1', ['INBOX'])),
    ]));

    const result = await batchGetGmailIndexMetadata(
      { request } as never,
      ['m1', 'm/2'],
      vi.fn(),
    );

    const options = request.mock.calls[0][0];
    expect(options.url).toBe('https://gmail.googleapis.com/batch/gmail/v1');
    expect(options.method).toBe('POST');
    expect(options.responseType).toBe('text');
    expect(options.data).toContain(
      'GET /gmail/v1/users/me/messages/m1?format=metadata&fields=id%2CinternalDate%2ClabelIds HTTP/1.1\r\n\r\n--batch_gmail_index',
    );
    expect(options.data).toContain(
      'GET /gmail/v1/users/me/messages/m%2F2?format=metadata&fields=id%2CinternalDate%2ClabelIds HTTP/1.1',
    );
    expect(result).toEqual({
      messages: [message('m1', ['INBOX']), message('m/2', ['SENT'])],
      missingMessageIds: [],
    });
  });

  it('returns message-level 404s as missing and normalises absent labels', async () => {
    const request = vi.fn().mockResolvedValue(batchResponse([
      part(0, 200, message('draft')),
      part(1, 404),
    ]));

    await expect(batchGetGmailIndexMetadata(
      { request } as never,
      ['draft', 'gone'],
      vi.fn(),
    )).resolves.toEqual({
      messages: [message('draft', [])],
      missingMessageIds: ['gone'],
    });
  });

  it('reads the multipart boundary from live Gaxios object headers', async () => {
    const response = batchResponse([part(0, 200, message('m1', ['INBOX']))]);
    const request = vi.fn().mockResolvedValue({
      ...response,
      headers: {
        'content-type': `multipart/mixed; boundary=${RESPONSE_BOUNDARY}`,
      },
    });

    await expect(batchGetGmailIndexMetadata(
      { request } as never,
      ['m1'],
      vi.fn(),
    )).resolves.toEqual({
      messages: [message('m1', ['INBOX'])],
      missingMessageIds: [],
    });
  });

  it('retries only inner 429/5xx dispositions with bounded delays', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(batchResponse([
        part(0, 200, message('m1', [])),
        part(1, 503),
      ]))
      .mockResolvedValueOnce(batchResponse([
        part(1, 429),
      ]))
      .mockResolvedValueOnce(batchResponse([
        part(1, 200, message('m2', [])),
      ]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(batchGetGmailIndexMetadata(
      { request } as never,
      ['m1', 'm2'],
      sleep,
    )).resolves.toEqual({
      messages: [message('m1', []), message('m2', [])],
      missingMessageIds: [],
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0].data).not.toContain('/messages/m1?');
    expect(request.mock.calls[1][0].data).toContain('/messages/m2?');
    expect(sleep.mock.calls).toEqual([[200], [400]]);
  });

  it('retries all pending IDs after an outer 429/5xx response', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce(batchResponse([
        part(0, 200, message('m1', [])),
      ]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(batchGetGmailIndexMetadata(
      { request } as never,
      ['m1'],
      sleep,
    )).resolves.toEqual({
      messages: [message('m1', [])],
      missingMessageIds: [],
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('fails after three transient attempts', async () => {
    const request = vi.fn().mockResolvedValue(batchResponse([part(0, 503)]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(batchGetGmailIndexMetadata(
      { request } as never,
      ['m1'],
      sleep,
    )).rejects.toThrow('three attempts');
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[200], [400]]);
  });

  it('fails incomplete or mismatched batch responses', async () => {
    const missingPart = vi.fn().mockResolvedValue(batchResponse([
      part(0, 200, message('m1', [])),
    ]));
    await expect(batchGetGmailIndexMetadata(
      { request: missingPart } as never,
      ['m1', 'm2'],
      vi.fn(),
    )).rejects.toThrow('missing response');

    const mismatchedId = vi.fn().mockResolvedValue(batchResponse([
      part(0, 200, message('different', [])),
    ]));
    await expect(batchGetGmailIndexMetadata(
      { request: mismatchedId } as never,
      ['m1'],
      vi.fn(),
    )).rejects.toThrow('does not match');
  });
});
