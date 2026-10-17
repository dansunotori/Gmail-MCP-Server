import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMMANDS } from './cli/commands.js';
import { cliAction, describeFailure, scopeRefusal, toolAction, toolErrorResult, withContext } from './error-text.js';
import { isAuthError, toGmailRequestError } from './gmail-sync.js';
import { toolDefinitions } from './tools.js';

// The error gaxios throws for a Gmail JSON error response, as observed live.
function gmailError(status: number, message: string, error: Record<string, unknown>) {
  return Object.assign(new Error(message), {
    code: status,
    status,
    errors: error.errors,
    config: { headers: { Authorization: 'Bearer ya29.secret-token' } },
    response: {
      status,
      statusText: 'Bad Request',
      headers: { 'set-cookie': 'SID=secret-cookie' },
      data: { error: { code: status, message, ...error } },
    },
  });
}

describe('describeFailure', () => {
  it('names the action, the message, the reason and the HTTP status', () => {
    const error = gmailError(404, 'Requested entity was not found.', {
      errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
      status: 'NOT_FOUND',
    });
    expect(describeFailure('get message', error))
      .toBe('Failed to get message: Requested entity was not found. (code notFound, HTTP 404)');
  });

  it('names the parameter Gmail rejected, from a BadRequest field violation', () => {
    const message = 'Invalid value at \'format\', "bogus"';
    const error = gmailError(400, message, {
      errors: [{ message, reason: 'invalid' }],
      status: 'INVALID_ARGUMENT',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations: [{ field: 'format', description: message }],
      }],
    });
    expect(describeFailure('get message', error))
      .toBe(`Failed to get message: ${message} (code invalid, HTTP 400; rejected parameter: format)`);
  });

  it('names every rejected parameter once, also from an error location of type parameter', () => {
    const error = gmailError(400, 'Invalid values', {
      errors: [
        { message: 'Invalid', reason: 'invalidParameter', location: 'maxResults', locationType: 'parameter' },
        { message: 'Invalid', reason: 'invalidParameter', location: 'Authorization', locationType: 'header' },
        { message: 'Invalid', reason: 'invalidParameter', location: 'q', locationType: 'parameter' },
      ],
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'q' }] }],
    });
    expect(describeFailure('search messages', error))
      .toBe('Failed to search messages: Invalid values (code invalidParameter, HTTP 400; rejected parameter: maxResults, q)');
  });

  it('uses the status text instead of an HTML error page', () => {
    const page = '<!DOCTYPE html>\n<html lang=en>\n<title>Error 413 (Request Entity Too Large)!!1</title>\n';
    const error = Object.assign(new Error(page), {
      response: { status: 413, statusText: 'Request Entity Too Large', data: page },
    });
    expect(describeFailure('search messages', error))
      .toBe('Failed to search messages: Request Entity Too Large (HTTP 413)');
  });

  it('reads a JSON error body that arrived as text', () => {
    const body = JSON.stringify({ error: {
      code: 400,
      message: 'Invalid value',
      errors: [{ message: 'Invalid value', reason: 'invalid' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'format' }] }],
    } });
    const error = Object.assign(new Error('Invalid value'), { response: { status: 400, data: body } });
    expect(describeFailure('get message', error))
      .toBe('Failed to get message: Invalid value (code invalid, HTTP 400; rejected parameter: format)');
    expect(describeFailure('get message', withContext('context', error)))
      .toBe('Failed to get message: context (code invalid, HTTP 400; rejected parameter: format)');
    expect(isAuthError(withContext('context', Object.assign(new Error('x'), {
      response: { status: 403, data: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }) },
    })))).toBe(true);
  });

  it('leaves out the parenthesis when Gmail supplied no reason, status or parameter', () => {
    expect(describeFailure('download attachment', new Error('No attachment data received')))
      .toBe('Failed to download attachment: No attachment data received');
  });

  it('keeps a network failure to its message', () => {
    const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(describeFailure('search messages', error)).toBe('Failed to search messages: socket hang up');
  });

  it('never includes a token, a cookie or a request header', () => {
    const error = gmailError(401, 'Invalid Credentials', {
      errors: [{ message: 'Invalid Credentials', reason: 'authError', location: 'Authorization', locationType: 'header' }],
    });
    const text = describeFailure('search messages', error);
    expect(text).toBe('Failed to search messages: Invalid Credentials (code authError, HTTP 401)');
    expect(text).not.toMatch(/secret|Bearer|Authorization|SID/);
  });

  it('puts a validation failure on one line', () => {
    const result = z.object({ watermark: z.string(), output_dir: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    const text = describeFailure('fetch window', (result as { error: z.ZodError }).error);
    expect(text).toBe('Failed to fetch window: watermark: Required; output_dir: Required');
  });

  it('puts a multi-line message on one line', () => {
    expect(describeFailure('search messages', new Error('first line\n  second line\n')))
      .toBe('Failed to search messages: first line second line');
  });
});

describe('withContext', () => {
  const notFound = () => gmailError(404, 'Requested entity was not found.', {
    errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
  });

  it('keeps Gmail\'s reason and status behind a message that adds context', () => {
    expect(describeFailure('get filter', withContext('Filter with ID "f1" not found.', notFound())))
      .toBe('Failed to get filter: Filter with ID "f1" not found. (code notFound, HTTP 404)');
  });

  it('keeps the rejected parameters and the status text of the wrapped error', () => {
    const error = gmailError(400, 'Invalid value', {
      errors: [{ message: 'Invalid value', reason: 'invalid' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'criteria' }] }],
    });
    expect(describeFailure('create filter', withContext('Invalid filter criteria or action: Invalid value', error)))
      .toBe('Failed to create filter: Invalid filter criteria or action: Invalid value (code invalid, HTTP 400; rejected parameter: criteria)');
  });

  it('keeps what the exit-code mapping and the auth check read', () => {
    const wrapped = withContext('window listing failed', gmailError(403, 'Insufficient Permission', {
      errors: [{ message: 'Insufficient Permission', reason: 'insufficientPermissions' }],
    }));
    expect(toGmailRequestError(wrapped)).toMatchObject({ status: 403, reason: 'insufficientPermissions' });
    expect(isAuthError(wrapped)).toBe(true);
  });

  it('survives being wrapped twice', () => {
    expect(describeFailure('get or create label', withContext('outer', withContext('inner', notFound()))))
      .toBe('Failed to get or create label: outer (code notFound, HTTP 404)');
  });
});

describe('toolErrorResult', () => {
  it('is an MCP error result carrying the same line the command-line tools print', () => {
    const error = gmailError(400, 'Invalid attachment token', {
      errors: [{ message: 'Invalid attachment token', domain: 'global', reason: 'invalidArgument' }],
    });
    expect(toolErrorResult('download_attachment', error)).toEqual({
      isError: true,
      content: [{
        type: 'text',
        text: 'Failed to download attachment: Invalid attachment token (code invalidArgument, HTTP 400)',
      }],
    });
  });

  it('reports a scope refusal in the same form', () => {
    expect(toolErrorResult('send_email', new Error(scopeRefusal('send_email'))).content[0].text)
      .toBe('Failed to send message: Tool "send_email" is not available. You may need to re-authenticate with additional scopes.');
  });
});

describe('actions', () => {
  it('names an action for every MCP tool', () => {
    for (const tool of toolDefinitions) {
      expect(toolAction(tool.name), tool.name).toMatch(/^[a-z]+( [a-z]+)*$/);
    }
  });

  it('gives a command-line tool the action of the MCP tool it exposes', () => {
    expect(cliAction('gmail-search')).toBe(toolAction('search_emails'));
    expect(cliAction('gmail-get-message')).toBe(toolAction('read_email'));
    expect(cliAction('gmail-download-attachment')).toBe(toolAction('download_attachment'));
    expect(cliAction('gmail-batch-fetch-window')).toBe(toolAction('batch_fetch_window'));
    for (const command of COMMANDS) {
      expect(cliAction(command.name), command.name).toMatch(/^[a-z]+( [a-z]+)*$/);
    }
  });

  it('names an unknown tool in the action', () => {
    expect(toolAction('no_such_tool')).toBe('call no_such_tool');
  });
});
