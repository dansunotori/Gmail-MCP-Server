import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema definitions

// Inline image embedded in an HTML body and referenced via a cid: URL.
// Exactly one of `path` / `content` must be set; `contentType` is required with `content`.
export const InlineImageSchema = z.object({
  cid: z.string().min(1).regex(/^[^\s<>]+$/, "cid must not contain whitespace or angle brackets")
    .describe("Content-ID for the image, referenced from htmlBody as <img src=\"cid:CID\">"),
  path: z.string().optional().describe("Absolute file path to the image (use this OR content)"),
  content: z.string().optional().describe("Base64-encoded image data (use this OR path)"),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon']).optional()
    .describe("Image MIME type — required when using `content`. SVG is intentionally unsupported."),
  filename: z.string().optional().describe("Display filename for the image part (defaults derived from path or cid)"),
})
  .refine(d => (d.path ? 1 : 0) + (d.content ? 1 : 0) === 1, {
    message: "Each inline image must set exactly one of `path` or `content`",
  })
  .refine(d => !d.content || !!d.contentType, {
    message: "`contentType` is required when an inline image uses `content`",
  });

export const SendEmailSchema = z.object({
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z.string().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
  inlineImages: z.array(InlineImageSchema).optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
});

export const ReadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: z.number().optional().describe("Maximum number of results to return"),
});

export const ModifyEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to modify"),
  labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to delete"),
});

// Draft lifecycle schemas
export const SendDraftSchema = z.object({
  draftId: z.string().describe("ID of the draft to send (returned by draft_email)"),
});

export const DeleteDraftSchema = z.object({
  draftId: z.string().describe("ID of the draft to delete"),
});

export const UpdateDraftSchema = z.object({
  draftId: z.string().describe("ID of the draft to update"),
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z.string().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
  inlineImages: z.array(InlineImageSchema).optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z.object({
  name: z.string().describe("Name for the new label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

export const UpdateLabelSchema = z.object({
  id: z.string().describe("ID of the label to update"),
  name: z.string().optional().describe("New name for the label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z.object({
  id: z.string().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z.object({
  name: z.string().describe("Name of the label to get or create"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to modify"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const ReportPhishingSchema = z.object({
  messageId: z.string().describe("ID of the email message to report as phishing"),
}).describe("Reports a message as phishing using the closest public Gmail API behavior by applying the SPAM label");

export const BatchReportPhishingSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to report as phishing"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
}).describe("Reports multiple messages as phishing using the closest public Gmail API behavior by applying the SPAM label");

export const BatchDeleteEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to delete"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const CreateFilterSchema = z.object({
  criteria: z.object({
    from: z.string().optional().describe("Sender email address to match"),
    to: z.string().optional().describe("Recipient email address to match"),
    subject: z.string().optional().describe("Subject text to match"),
    query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
    negatedQuery: z.string().optional().describe("Text that must NOT be present"),
    hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
    excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
    size: z.number().optional().describe("Email size in bytes"),
    sizeComparison: z.enum(['unspecified', 'smaller', 'larger']).optional().describe("Size comparison operator")
  }).describe("Criteria for matching emails"),
  action: z.object({
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add to matching emails"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove from matching emails"),
    forward: z.string().optional().describe("Email address to forward matching emails to")
  }).describe("Actions to perform on matching emails")
}).describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z.object({
  template: z.enum(['fromSender', 'withSubject', 'withAttachments', 'largeEmails', 'containingText', 'mailingList']).describe("Pre-defined filter template to use"),
  parameters: z.object({
    senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
    subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
    searchText: z.string().optional().describe("Text to search for (for containingText template)"),
    listIdentifier: z.string().optional().describe("Mailing list identifier (for mailingList template)"),
    sizeInBytes: z.number().optional().describe("Size threshold in bytes (for largeEmails template)"),
    labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
    archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
    markAsRead: z.boolean().optional().describe("Whether to mark as read"),
    markImportant: z.boolean().optional().describe("Whether to mark as important")
  }).describe("Template-specific parameters")
}).describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: z.string().describe("ID of the email message containing the attachment"),
  attachmentId: z.string().describe("ID of the attachment to download"),
  filename: z.string().optional().describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: z.string().optional().describe("Directory path to save the attachment (defaults to current directory)"),
});

export const DownloadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to download"),
  savePath: z.string().describe("Directory path to save the email file"),
  format: z.enum(['json', 'eml', 'txt', 'html']).optional().default('json')
    .describe("Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)"),
});

export const ModifyThreadSchema = z.object({
  threadId: z.string().describe("ID of the Gmail thread to modify"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages in the thread"),
});

// Thread-level schemas
export const GetThreadSchema = z.object({
  threadId: z.string().describe("ID of the email thread to retrieve"),
  format: z.enum(['full', 'metadata', 'minimal']).optional().default('full').describe("Format of the email messages returned (default: full)"),
});

export const ListInboxThreadsSchema = z.object({
  query: z.string().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z.number().optional().default(50).describe("Maximum number of threads to return (default: 50)"),
});

export const GetInboxWithThreadsSchema = z.object({
  query: z.string().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z.number().optional().default(50).describe("Maximum number of threads to return (default: 50)"),
  expandThreads: z.boolean().optional().default(true).describe("Whether to fetch full thread content for each thread (default: true)"),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: z.string().describe("ID of the email message to reply to"),
  body: z.string().describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the reply"),
  inlineImages: z.array(InlineImageSchema).optional().describe("Images embedded inline in the HTML body, each referenced from htmlBody as <img src=\"cid:CID\">. Requires htmlBody to be set."),
});

const NonEmptyString = z.string().min(1);

export const GetGmailProfileSchema = z.object({}).strict();

export const ListGmailMessageIdsSchema = z.object({
  pageToken: NonEmptyString.optional(),
  maxResults: z.number().int().min(1).max(500).default(500),
}).strict();

export const ListGmailAddedHistorySchema = z.object({
  startHistoryId: NonEmptyString,
  pageToken: NonEmptyString.optional(),
  maxResults: z.number().int().min(1).max(500).default(500),
}).strict();

export const BatchGetGmailIndexMetadataSchema = z.object({
  messageIds: z.array(NonEmptyString).min(1).max(50),
}).strict();

export const GmailProfileOutputSchema = z.object({
  historyId: NonEmptyString,
}).strict();

export const GmailMessageIdsOutputSchema = z.object({
  messageIds: z.array(NonEmptyString),
  nextPageToken: NonEmptyString.optional(),
}).strict();

export const GmailAddedHistoryOutputSchema = z.object({
  status: z.enum(['ok', 'cursor_expired']),
  messageIds: z.array(NonEmptyString).optional(),
  nextPageToken: NonEmptyString.optional(),
  historyId: NonEmptyString.optional(),
  startHistoryId: NonEmptyString.optional(),
}).strict().superRefine((value, context) => {
  const valid = value.status === 'ok'
    ? value.messageIds !== undefined
      && value.historyId !== undefined
      && value.startHistoryId === undefined
    : value.startHistoryId !== undefined
      && value.messageIds === undefined
      && value.historyId === undefined
      && value.nextPageToken === undefined;

  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid Gmail history result',
    });
  }
});

export const GmailIndexMetadataOutputSchema = z.object({
  messages: z.array(z.object({
    id: NonEmptyString,
    internalDate: z.string().regex(/^\d+$/),
    labelIds: z.array(NonEmptyString),
  }).strict()),
  missingMessageIds: z.array(NonEmptyString),
}).strict();

const WATERMARK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const BatchFetchWindowSchema = z.object({
  watermark: z.string().superRefine((value, context) => {
    const match = WATERMARK_PATTERN.exec(value);
    if (!match) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'watermark must be an ISO 8601 timestamp with an explicit Z or +HH:MM/-HH:MM zone suffix',
      });
      return;
    }
    // Date.parse silently rolls invalid calendar values (e.g. 2026-02-30) into the next
    // month instead of rejecting them, so validate the calendar fields explicitly before
    // trusting Date.parse for the actual instant.
    const [, year, month, day, hour, minute, second] = match;
    const y = Number(year);
    const mo = Number(month);
    const d = Number(day);
    const h = Number(hour);
    const mi = Number(minute);
    const s = Number(second);
    const roundTrip = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const isValidCalendarDate = roundTrip.getUTCFullYear() === y
      && roundTrip.getUTCMonth() === mo - 1
      && roundTrip.getUTCDate() === d
      && roundTrip.getUTCHours() === h
      && roundTrip.getUTCMinutes() === mi
      && roundTrip.getUTCSeconds() === s;
    if (!isValidCalendarDate || !Number.isFinite(Date.parse(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'watermark is not a valid date' });
    }
  }).describe("ISO 8601 timestamp with an explicit zone (Z or +HH:MM/-HH:MM), e.g. 2026-09-10T14:03:22Z; the window is inclusive of this instant"),
  output_dir: z.string().refine(value => path.isAbsolute(value), {
    message: 'output_dir must be an absolute path',
  }).describe("Absolute directory; unless the result is truncated, the tool deletes and recreates messages/ and overwrites manifest.json and window-metadata.json inside it. Guard, checked before anything is deleted: messages/ may be deleted only if it is absent, empty, or holds nothing but regular files named NNN.json or .publish-* plus the .batch-fetch-window marker the tool writes on every run (an output written before the marker existed is accepted when the manifest.json beside it lists every NNN.json present under that same messages/ path). Anything else, including a subdirectory or a symlink, makes the call fail with an error naming the offending entry, and nothing is deleted or written. A truncated run writes nothing and leaves earlier outputs in place, so check `truncated` before trusting the files"),
  max_messages: z.number().int().min(1).default(2000)
    .describe("Hard cap on listed IDs; above it nothing is downloaded and the result is truncated"),
  cross_check: z.boolean().default(true)
    .describe("Also list spam, trash and in:anywhere since the watermark to detect silently dropped messages. The result's crossCheck.status is then consistent, inconsistent (crossCheck.unexplainedIds names IDs seen in in:anywhere but in none of window, spam or trash) or failed (a listing did not complete after retries; crossCheck.errors names each query); false gives status skipped. crossCheck.consistent is true only for status consistent"),
}).strict();

// One entry per Gmail call that was given up on after its retries. `error` is the failure
// string (HTTP status, network code or error name, prefixed `body-part-fetch: ` for a body
// part); `status` is the same value typed: the numeric HTTP status, or the network code or
// error name as a string.
const BatchFetchFailureSchema = z.object({
  id: NonEmptyString,
  error: z.string(),
  operation: z.enum(['messages.get', 'body-part-fetch', 'cross-check']),
  status: z.union([z.number().int(), NonEmptyString]),
  attempts: z.number().int().min(1),
}).strict();

const CrossCheckCountsSchema = z.object({
  window: z.number().int().min(0),
  spam: z.number().int().min(0),
  trash: z.number().int().min(0),
  anywhere: z.number().int().min(0),
}).strict();

// One entry per cross-check listing that did not complete after its retries.
const CrossCheckErrorSchema = z.object({
  query: NonEmptyString,
  // 1-based page that failed; absent when the failure was not a page request.
  page: z.number().int().min(1).optional(),
  status: z.union([z.number().int(), NonEmptyString]),
  attempts: z.number().int().min(1),
}).strict();

const CrossCheckRanSchema = z.object({
  status: z.enum(['consistent', 'inconsistent', 'failed']),
  consistent: z.boolean(),
  // False when any of the window, spam, trash or anywhere listings failed or stopped early;
  // `consistent` is then false too, whatever `unexplainedIds` holds.
  complete: z.boolean(),
  unexplainedIds: z.array(NonEmptyString),
  errors: z.array(CrossCheckErrorSchema),
  counts: CrossCheckCountsSchema,
  // The same four counts, kept flat for compatibility.
  window: z.number().int().min(0),
  spam: z.number().int().min(0),
  trash: z.number().int().min(0),
  anywhere: z.number().int().min(0),
}).strict();

// The shape when no cross-check listing ran (`cross_check: false`, or a truncated window).
const CrossCheckSkippedSchema = z.object({
  status: z.literal('skipped'),
  consistent: z.literal(false),
  complete: z.literal(false),
  unexplainedIds: z.array(NonEmptyString).length(0),
  errors: z.array(CrossCheckErrorSchema).length(0),
}).strict();

// `consistent` is true exactly when `status` is "consistent", so a caller that checks only the
// boolean fails closed on "inconsistent", "failed" and "skipped" alike.
const BatchFetchCrossCheckSchema = z.discriminatedUnion('status', [
  CrossCheckRanSchema.extend({ status: z.literal('consistent'), consistent: z.literal(true) }).strict(),
  CrossCheckRanSchema.extend({ status: z.literal('inconsistent'), consistent: z.literal(false) }).strict(),
  CrossCheckRanSchema.extend({ status: z.literal('failed'), consistent: z.literal(false) }).strict(),
  CrossCheckSkippedSchema,
]);

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
  crossCheck: BatchFetchCrossCheckSchema,
  triage: z.array(z.string()),
}).strict();

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  outputSchema?: z.ZodType<any>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "get_gmail_profile",
    description: "Returns the current Gmail history cursor without mailbox content",
    schema: GetGmailProfileSchema,
    outputSchema: GmailProfileOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Gmail Profile", readOnlyHint: true },
  },
  {
    name: "list_gmail_message_ids",
    description: "Lists Gmail message IDs while excluding spam and trash",
    schema: ListGmailMessageIdsSchema,
    outputSchema: GmailMessageIdsOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Gmail Message IDs", readOnlyHint: true },
  },
  {
    name: "list_gmail_added_history",
    description: "Lists message-added history after a Gmail history cursor",
    schema: ListGmailAddedHistorySchema,
    outputSchema: GmailAddedHistoryOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Gmail Added History", readOnlyHint: true },
  },
  {
    name: "batch_get_gmail_index_metadata",
    description: "Returns only Gmail message IDs, internal dates, and labels for indexing",
    schema: BatchGetGmailIndexMetadataSchema,
    outputSchema: GmailIndexMetadataOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Batch Get Gmail Index Metadata", readOnlyHint: true },
  },
  {
    name: "batch_fetch_window",
    description: "Downloads every message received since a watermark into a local directory with manifest and cross-check; deletes and recreates messages/ under output_dir unless the listing exceeds max_messages, in which case nothing is written and earlier outputs remain. Every Gmail call is retried on 429, 5xx, rate-limit 403 and network errors up to 5 attempts with exponential full-jitter backoff (500 ms base, 30 s cap, Retry-After honoured); other 4xx are not retried. A window listing page that still fails makes the whole call an error, before anything is deleted or written. A message or body part that still fails is recorded in failures as { id, error, operation, status, attempts } and the rest of the window is written. crossCheck is always present with status consistent, inconsistent, failed or skipped; consistent is true only for status consistent",
    schema: BatchFetchWindowSchema,
    outputSchema: BatchFetchWindowOutputSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Batch Fetch Window", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "read_email",
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: "Downloads an email attachment to a specified location",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description: "Retrieves all messages in an email thread in one call. Returns messages ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description: "Lists email threads matching a query (default: inbox). Returns thread-level view with snippet, message count, and latest message metadata.",
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description: "Convenience tool that lists threads and optionally expands each with full message content. One call returns the full inbox with complete thread bodies.",
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description: "Modifies labels on ALL messages in a thread atomically using the Gmail threads.modify endpoint. Use this instead of modify_email when you want to apply label changes (e.g., archive, mark as read) to an entire thread at once.",
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description: "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email. Supports plain text, HTML, file attachments, and images embedded inline in the HTML body via inlineImages.",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "draft_email",
    description: "Draft a new email. Supports plain text, HTML, file attachments, and images embedded inline in the HTML body via inlineImages.",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "send_draft",
    description: "Sends an existing draft (created via draft_email) and atomically removes it from Drafts. Prefer this over send_email when you've previously created a draft for review — avoids leaving an orphan draft in the user's Drafts folder.",
    schema: SendDraftSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Draft", destructiveHint: false },
  },
  {
    name: "delete_draft",
    description: "Deletes a draft. Use to discard an abandoned or superseded draft.",
    schema: DeleteDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Delete Draft", destructiveHint: true },
  },
  {
    name: "update_draft",
    description: "Replaces the content of an existing draft. Use during iteration (\"change this and that\") instead of creating a new draft each time — avoids accumulating draft copies in the user's Drafts folder.",
    schema: UpdateDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Update Draft", destructiveHint: false },
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: "Permanently deletes an email. Requires gmail.full because Gmail's delete endpoint is not covered by gmail.modify.",
    schema: DeleteEmailSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "report_phishing",
    description: "Reports a message as phishing using the closest public Gmail API behavior by applying the SPAM label",
    schema: ReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Report Phishing", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_report_phishing",
    description: "Reports multiple messages as phishing using the closest public Gmail API behavior by applying the SPAM label",
    schema: BatchReportPhishingSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Report Phishing", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: "Permanently deletes multiple emails in batches. Requires gmail.full because Gmail's batchDelete endpoint is not covered by gmail.modify.",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.full"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: false },
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },
];

// Convert tool definitions to MCP tool format
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
    ...(tool.outputSchema ? { outputSchema: zodToJsonSchema(tool.outputSchema) } : {}),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}
