/**
 * The one-line error text every MCP tool and command-line tool reports on failure:
 * `Failed to <action>: <message> (code <reason>, HTTP <status>; rejected parameter: <name>, ...)`,
 * each part of the parenthesis present only when Gmail supplied it. Only the error's message
 * and these fields are read, never the request configuration or any header, so no token or
 * credential can reach the text.
 */

import { z } from 'zod';
import { GmailRequestError, toGmailRequestError, withParsedErrorBody } from './gmail-sync.js';

// The verb phrase each MCP tool names in its error text.
const TOOL_ACTIONS: Record<string, string> = {
  get_gmail_profile: 'get profile',
  list_gmail_message_ids: 'list message ids',
  list_gmail_added_history: 'list added history',
  batch_get_gmail_index_metadata: 'get index metadata',
  batch_fetch_window: 'fetch window',
  read_email: 'get message',
  search_emails: 'search messages',
  download_attachment: 'download attachment',
  get_attachment_text: 'get attachment text',
  get_thread: 'get thread',
  list_inbox_threads: 'list threads',
  get_inbox_with_threads: 'get inbox threads',
  modify_thread: 'modify thread',
  download_email: 'download message',
  send_email: 'send message',
  draft_email: 'create draft',
  send_draft: 'send draft',
  delete_draft: 'delete draft',
  update_draft: 'update draft',
  modify_email: 'modify message',
  delete_email: 'delete message',
  batch_modify_emails: 'modify messages',
  report_phishing: 'report phishing',
  batch_report_phishing: 'report phishing',
  batch_delete_emails: 'delete messages',
  list_email_labels: 'list labels',
  create_label: 'create label',
  update_label: 'update label',
  delete_label: 'delete label',
  get_or_create_label: 'get or create label',
  list_filters: 'list filters',
  get_filter: 'get filter',
  create_filter: 'create filter',
  delete_filter: 'delete filter',
  create_filter_from_template: 'create filter from template',
  reply_all: 'reply to all',
};

// The MCP tool each command-line tool exposes, so both surfaces name the same action.
const CLI_TOOLS: Record<string, string> = {
  'gmail-search': 'search_emails',
  'gmail-get-message': 'read_email',
  'gmail-download-attachment': 'download_attachment',
  'gmail-batch-fetch-window': 'batch_fetch_window',
  'gmail-create-draft': 'draft_email',
  'gmail-get-attachment-text': 'get_attachment_text',
  'gmail-get-thread': 'get_thread',
  'gmail-get-inbox-with-threads': 'get_inbox_with_threads',
  'gmail-download-email': 'download_email',
  'gmail-list-inbox-threads': 'list_inbox_threads',
  'gmail-get-profile': 'get_gmail_profile',
  'gmail-list-message-ids': 'list_gmail_message_ids',
  'gmail-list-added-history': 'list_gmail_added_history',
  'gmail-batch-get-index-metadata': 'batch_get_gmail_index_metadata',
  'gmail-list-labels': 'list_email_labels',
  'gmail-list-filters': 'list_filters',
  'gmail-get-filter': 'get_filter',
};

// Why a tool the saved credentials do not cover is refused, by the server and the CLIs alike.
export function scopeRefusal(toolName: string): string {
  return `Tool "${toolName}" is not available. You may need to re-authenticate with additional scopes.`;
}

export function toolAction(toolName: string): string {
  return TOOL_ACTIONS[toolName] ?? `call ${toolName}`;
}

export function cliAction(commandName: string): string {
  const tool = CLI_TOOLS[commandName];
  return tool === undefined ? `run ${commandName}` : toolAction(tool);
}

type ErrorDetail = {
  reason?: unknown;
  location?: unknown;
  locationType?: unknown;
};

type ErrorShape = {
  message?: unknown;
  cause?: unknown;
  errors?: ErrorDetail[];
  response?: {
    statusText?: unknown;
    data?: { error?: { errors?: ErrorDetail[]; details?: Array<Record<string, unknown>> } | string };
  };
};

// A failure with a message that adds context (which label, which filter, which listing),
// keeping the Gmail error it came from: the reason, status and rejected parameters stay
// readable, by this module and by the exit-code mapping and auth check (toGmailRequestError
// returns a GmailRequestError unchanged).
export function withContext(message: string, cause: unknown): GmailRequestError {
  const upstream = toGmailRequestError(cause);
  return new GmailRequestError(message, {
    code: upstream.code,
    status: upstream.status,
    reason: upstream.reason,
    cause,
  });
}

// The error followed by every error it wraps, outermost first, each with its body parsed.
function causeChain(error: unknown): ErrorShape[] {
  const chain: ErrorShape[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const shape = withParsedErrorBody(current) as ErrorShape;
    chain.push(shape);
    current = shape.cause;
  }
  return chain;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The outermost error's message, which carries any context a caller added; an HTML error
// page (Gmail returns one for a 413) is replaced by the HTTP status text, which says the
// same thing in one line.
function messageOf(error: unknown, chain: ErrorShape[]): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
      .join('; ');
  }
  const message = typeof chain[0]?.message === 'string' ? chain[0].message : String(error);
  if (/^\s*</.test(message)) {
    const statusText = chain.map(shape => shape.response?.statusText).find(text => typeof text === 'string' && text !== '');
    return typeof statusText === 'string' ? statusText : 'Gmail returned an error page';
  }
  return oneLine(message);
}

// Parameters Gmail named as rejected: an error entry located in a parameter, or a field
// violation in a google.rpc.BadRequest detail. Header locations are never reported.
function rejectedParameters(shape: ErrorShape | undefined): string[] {
  const data = typeof shape?.response?.data?.error === 'object' ? shape.response.data.error : undefined;
  const names: string[] = [];
  for (const entry of [...(shape?.errors ?? []), ...(data?.errors ?? [])]) {
    if (entry.locationType === 'parameter' && typeof entry.location === 'string' && entry.location !== '') {
      names.push(entry.location);
    }
  }
  for (const detail of data?.details ?? []) {
    if (typeof detail['@type'] !== 'string' || !detail['@type'].endsWith('google.rpc.BadRequest')) {
      continue;
    }
    const violations = Array.isArray(detail.fieldViolations) ? detail.fieldViolations : [];
    for (const violation of violations as Array<{ field?: unknown }>) {
      if (typeof violation.field === 'string' && violation.field !== '') {
        names.push(violation.field);
      }
    }
  }
  return [...new Set(names)];
}

export function describeFailure(action: string, error: unknown): string {
  return `Failed to ${action}: ${failureDetail(error)}`;
}

// The part after the action: `<message> (code <reason>, HTTP <status>; rejected parameter:
// <name>, ...)`. Batch tools use it alone for each message that failed.
export function failureDetail(error: unknown): string {
  const chain = causeChain(error);
  // A GmailRequestError (from withContext or toGmailRequestError) carries the reason and
  // status of the error it wraps; any other error is read directly.
  const wrapped = toGmailRequestError(error);
  const detail = [
    ...(wrapped.reason !== undefined ? [`code ${wrapped.reason}`] : []),
    ...(wrapped.status !== undefined ? [`HTTP ${wrapped.status}`] : []),
  ].join(', ');
  const parameters = [...new Set(chain.flatMap(rejectedParameters))];
  const rejected = parameters.length > 0 ? `rejected parameter: ${parameters.join(', ')}` : '';
  const parenthesis = [detail, rejected].filter(part => part !== '').join('; ');
  const message = messageOf(error, chain);
  return `${message}${parenthesis === '' ? '' : ` (${parenthesis})`}`;
}

// The MCP result for a failed tool call: an error result whose text is the line the
// command-line tool for the same action prints.
export function toolErrorResult(toolName: string, error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: describeFailure(toolAction(toolName), error) }],
  };
}
