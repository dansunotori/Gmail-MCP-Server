import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import {
  failureCode,
  getGmailEmailAddress,
  isAuthError,
  listAllGmailMessageIds,
  retryAttempts,
  structuredResult,
  toGmailRequestError,
  withGmailRetry,
  type GmailRetryOptions,
  type ListAllMessageIdsResult,
} from './gmail-sync.js';
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
import { BatchFetchWindowOutputSchema, BatchFetchWindowSchema } from './tools.js';

export type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>;
export type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>;

type Failure = BatchFetchWindowResult['failures'][number];
type FailureOperation = Failure['operation'];

// The typed counterpart of failureCode: the numeric HTTP status when there is one,
// otherwise the network code or error name that failureCode would render.
function failureStatus(error: unknown): number | string {
  return toGmailRequestError(error).status ?? failureCode(error);
}

function failure(id: string, operation: FailureOperation, error: unknown, code = failureCode(error)): Failure {
  return { id, error: code, operation, status: failureStatus(error), attempts: retryAttempts(error) };
}

// A listing that failed after its retries, as `failure` would describe it plus the page.
function listingFailure(id: string, operation: FailureOperation, listing: ListAllMessageIdsResult): Failure {
  return {
    id,
    error: failureCode(listing.error),
    operation,
    status: failureStatus(listing.error),
    attempts: listing.attempts ?? 1,
  };
}

type KeptMessage = {
  // The listed ID, which is always non-empty; used for the file, the manifest and any
  // failure entry so a response without `id` can never produce an empty failure id.
  id: string;
  data: gmail_v1.Schema$Message;
  internal: number;
  labels: string[];
};

type ManifestEntry = {
  file: string;
  id: string;
  internalDate: string | null | undefined;
  labelIds: string[];
  from: string;
  subject: string;
  dateHeader: string;
  attachments: number;
};

const METADATA_HEADERS = new Set(['from', 'to', 'subject', 'date']);

function writeJson(target: string, value: unknown): void {
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

// Publish through a temporary file inside messages/ (which the tool owns) and an atomic
// rename, so a reader never sees a partial metadata file and a failed write leaves only a
// temporary that the next run's cleanup of messages/ removes.
function publishJson(messagesDir: string, target: string, value: unknown): void {
  const temporary = path.join(messagesDir, `.publish-${path.basename(target)}`);
  writeJson(temporary, value);
  fs.renameSync(temporary, target);
}

// Written into messages/ immediately after the tool creates it. Its presence is the proof, on
// the next run, that the directory is the tool's own and may be deleted; a crashed run leaves
// it in place, so recovery never needs manual cleanup.
export const MESSAGES_DIR_MARKER = '.batch-fetch-window';

// The tool only ever writes the marker, zero-padded numbered files and its own publish
// temporaries into messages/, and only as regular files, so anything else there (a foreign
// name, or a directory or symlink under an owned name) was put there by someone else and must
// not be deleted.
const OWNED_MESSAGE_FILE = /^\d{3,}\.json$/;

function isOwnedEntry(entry: fs.Dirent): boolean {
  const name = String(entry.name);
  return entry.isFile() && (name === MESSAGES_DIR_MARKER || OWNED_MESSAGE_FILE.test(name) || name.startsWith('.publish-'));
}

// The names of the message files an existing manifest.json lists directly inside this
// messages/ directory, or an empty set when there is no readable manifest. A path under any
// other directory is ignored, so a stale or unrelated manifest vouches for nothing here.
// Outputs written before the marker existed are recognised by this listing instead.
function manifestFileNames(manifestPath: string, messagesDir: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return new Set();
  }
  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) {
    return new Set();
  }
  const resolvedDir = path.resolve(messagesDir);
  return new Set(messages.flatMap(entry => {
    const file = (entry as { file?: unknown })?.file;
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      return [];
    }
    const resolved = path.resolve(file);
    return path.dirname(resolved) === resolvedDir ? [path.basename(resolved)] : [];
  }));
}

// The guard: messages/ may be deleted only when it is absent, empty, or holds nothing but the
// tool's own files and either the marker or, for an output written before the marker existed,
// a manifest.json beside it that lists every numbered file present. The first foreign entries
// are named in the refusal.
function assertMessagesDirDeletable(messagesDir: string, manifestPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(messagesDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    if (code === 'ENOTDIR') {
      throw new Error(`refusing to delete ${messagesDir}: it exists but is not a directory`);
    }
    throw error;
  }
  const names = entries.map(entry => String(entry.name));
  const foreign = entries.filter(entry => !isOwnedEntry(entry)).map(entry => String(entry.name)).sort();
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? `, … (${foreign.length} entries)` : '');
    throw new Error(`refusing to delete ${messagesDir}: it contains entries batch_fetch_window did not write: ${shown}`);
  }
  if (names.length === 0 || names.includes(MESSAGES_DIR_MARKER)) {
    return;
  }
  const listed = manifestFileNames(manifestPath, messagesDir);
  const unlisted = names.filter(name => OWNED_MESSAGE_FILE.test(name) && !listed.has(name)).sort();
  if (unlisted.length > 0) {
    throw new Error(
      `refusing to delete ${messagesDir}: it has no ${MESSAGES_DIR_MARKER} marker and ${manifestPath} does not list ${unlisted[0]}`,
    );
  }
}

type CrossCheck = BatchFetchWindowResult['crossCheck'];
type CrossCheckError = Extract<CrossCheck, { status: 'failed' }>['errors'][number];
type CrossCheckListing = { ids: Set<string>; complete: boolean };

const CROSS_CHECK_SKIPPED: CrossCheck = {
  status: 'skipped',
  consistent: false,
  complete: false,
  unexplainedIds: [],
  errors: [],
};

// A failed listing is recorded twice: in `failures`, keyed `cross-check:<query>` like every
// other failure, and in `crossCheck.errors`, where the query is the key.
async function crossCheckListing(
  gmail: gmail_v1.Gmail,
  query: string,
  failures: Failure[],
  errors: CrossCheckError[],
  retry: GmailRetryOptions,
): Promise<CrossCheckListing> {
  try {
    const result = await listAllGmailMessageIds(gmail, { query, includeSpamTrash: true, retry });
    if (!result.complete) {
      const recorded = listingFailure(`cross-check:${query}`, 'cross-check', result);
      failures.push(recorded);
      errors.push({ query, page: result.failedPage, status: recorded.status, attempts: recorded.attempts });
    }
    return { ids: new Set(result.ids), complete: result.complete };
  } catch (error) {
    // Only auth errors and malformed responses escape the listing's own failure result.
    if (isAuthError(error)) {
      throw error;
    }
    const recorded = failure(`cross-check:${query}`, 'cross-check', error);
    failures.push(recorded);
    errors.push({ query, status: recorded.status, attempts: recorded.attempts });
    return { ids: new Set(), complete: false };
  }
}

async function runCrossCheck(
  gmail: gmail_v1.Gmail,
  epoch: number,
  windowIds: string[],
  failures: Failure[],
  retry: GmailRetryOptions,
): Promise<CrossCheck> {
  const errors: CrossCheckError[] = [];
  const spam = await crossCheckListing(gmail, `after:${epoch - 1} in:spam`, failures, errors, retry);
  const trash = await crossCheckListing(gmail, `after:${epoch - 1} in:trash`, failures, errors, retry);
  const anywhere = await crossCheckListing(gmail, `after:${epoch - 1} in:anywhere`, failures, errors, retry);
  const window = new Set(windowIds);
  const unexplainedIds = [...anywhere.ids].filter(id => !window.has(id) && !spam.ids.has(id) && !trash.ids.has(id));
  // A listing that failed cannot explain or reveal anything, so the check is consistent only
  // when every listing ran to the end and left nothing unexplained. The window listing itself
  // is always complete here: an incomplete one fails the whole call.
  const complete = spam.complete && trash.complete && anywhere.complete;
  const counts = { window: window.size, spam: spam.ids.size, trash: trash.ids.size, anywhere: anywhere.ids.size };
  const shared = { complete, unexplainedIds, errors, counts, ...counts };
  if (!complete) {
    return { ...shared, status: 'failed', consistent: false };
  }
  if (unexplainedIds.length > 0) {
    return { ...shared, status: 'inconsistent', consistent: false };
  }
  return { ...shared, status: 'consistent', consistent: true };
}

export async function batchFetchWindow(
  gmail: gmail_v1.Gmail,
  input: BatchFetchWindowInput,
  now: () => Date = () => new Date(),
  retry: GmailRetryOptions = {},
): Promise<BatchFetchWindowResult> {
  const boundaryMs = Date.parse(input.watermark);
  const epoch = Math.floor(boundaryMs / 1000);
  const windowQuery = `after:${epoch - 1} -in:spam -in:trash`;

  const emailAddress = await withGmailRetry(() => getGmailEmailAddress(gmail), retry);
  const failures: Failure[] = [];
  const windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true, retry });
  // A window whose listing is incomplete is not a window: fail here, before the guard and
  // before any deletion, so nothing under output_dir changes.
  if (!windowList.complete) {
    const attempts = windowList.attempts ?? 1;
    throw new Error(
      `window listing failed: query "${windowQuery}" page ${windowList.failedPage} `
      + `status ${failureStatus(windowList.error)} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
    );
  }

  const base = {
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowList.ids.length,
    maxMessages: input.max_messages,
    // Always true in a returned result: an incomplete listing fails the call above. Kept so
    // the result shape is stable.
    listingComplete: true,
  };

  if (windowList.ids.length > input.max_messages) {
    return BatchFetchWindowOutputSchema.parse({
      checkedAt: now().toISOString(),
      ...base,
      status: 'truncated',
      truncated: true,
      inWindow: 0,
      belowBoundaryOrExcluded: 0,
      failures,
      crossCheck: CROSS_CHECK_SKIPPED,
      triage: [],
    });
  }

  const outputDir = input.output_dir;
  const messagesDir = path.join(outputDir, 'messages');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const windowMetadataPath = path.join(outputDir, 'window-metadata.json');
  // Remove exactly the three paths the tool owns, metadata first, so that from here until
  // the final publish no manifest exists that could describe deleted or partial files.
  // Nothing else under output_dir is read, matched or deleted, and the guard runs before
  // the first deletion so a refused run leaves every earlier output intact.
  assertMessagesDirDeletable(messagesDir, manifestPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(windowMetadataPath, { force: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
  writeJson(path.join(messagesDir, MESSAGES_DIR_MARKER), { tool: 'batch_fetch_window' });

  const kept: KeptMessage[] = [];
  let belowBoundaryOrExcluded = 0;
  for (const id of windowList.ids) {
    let data: gmail_v1.Schema$Message;
    try {
      data = (await withGmailRetry(() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }), retry)).data;
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push(failure(id, 'messages.get', error));
      continue;
    }
    const internal = Number(data.internalDate);
    const labels = data.labelIds ?? [];
    if (internal < boundaryMs || labels.includes('SPAM') || labels.includes('TRASH')) {
      belowBoundaryOrExcluded += 1;
      continue;
    }
    kept.push({ id, data, internal, labels });
  }

  kept.sort((left, right) => left.internal - right.internal);
  const width = Math.max(3, String(kept.length).length);
  const manifestMessages: ManifestEntry[] = [];
  const metadataMessages: Array<Record<string, unknown>> = [];

  for (const [index, { id, data, labels }] of kept.entries()) {
    const headers = (data.payload?.headers ?? []) as MessageHeader[];
    const resolved = await resolveMessageBody(gmail, id, data.payload as MessagePart | undefined, retry);
    for (const bodyFailure of resolved.failures) {
      failures.push({
        id,
        error: bodyFailure.code,
        operation: 'body-part-fetch',
        status: failureStatus(bodyFailure.error),
        attempts: bodyFailure.attempts,
      });
    }
    const body = resolved.body;
    const attachments = resolved.attachments;
    const from = headerValue(headers, 'From');
    const subject = headerValue(headers, 'Subject');
    const dateHeader = headerValue(headers, 'Date');
    const file = path.join(messagesDir, `${String(index + 1).padStart(width, '0')}.json`);
    writeJson(file, {
      id,
      threadId: data.threadId,
      internalDate: data.internalDate,
      labelIds: labels,
      from,
      to: headerValue(headers, 'To'),
      cc: headerValue(headers, 'Cc'),
      subject,
      dateHeader,
      snippet: data.snippet ?? '',
      attachments,
      body,
    });
    manifestMessages.push({
      file,
      id,
      internalDate: data.internalDate,
      labelIds: labels,
      from,
      subject,
      dateHeader,
      attachments: attachments.length,
    });
    metadataMessages.push({
      id,
      internalDate: data.internalDate,
      labelIds: labels,
      headers: headers.filter(header => METADATA_HEADERS.has((header.name ?? '').toLowerCase())),
    });
  }

  const crossCheck = input.cross_check
    ? await runCrossCheck(gmail, epoch, windowList.ids, failures, retry)
    : CROSS_CHECK_SKIPPED;

  // Stamped after every fetch and check, immediately before publication, so it dates the files rather than the listing.
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
    crossCheck,
  };

  const triage = manifestMessages.map(entry =>
    [entry.file, entry.from, entry.subject, entry.dateHeader, `${entry.attachments} att`].join(' | ')
  );
  // A skipped cross-check is not a defect in the window, so it leaves the status at ok.
  const status = failures.length > 0 || crossCheck.status === 'inconsistent' || crossCheck.status === 'failed'
    ? 'incomplete'
    : 'ok';
  // Validate before publishing, so a schema rejection can never follow a published manifest.
  const result = BatchFetchWindowOutputSchema.parse({ ...summary, status, triage });

  publishJson(messagesDir, windowMetadataPath, {
    checkedAt: summary.checkedAt,
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    messages: metadataMessages,
  });
  publishJson(messagesDir, manifestPath, { ...summary, messages: manifestMessages });

  return result;
}

export async function handleBatchFetchWindow(
  gmail: gmail_v1.Gmail,
  args: unknown,
  now: () => Date = () => new Date(),
) {
  const validatedArgs = BatchFetchWindowSchema.parse(args);
  return structuredResult(await batchFetchWindow(gmail, validatedArgs, now));
}
