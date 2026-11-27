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
import { resolveCalendarPart } from './calendar-part.js';
import { withContext } from './error-text.js';
import { headerValue, optionalHeader, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
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
  // The RFC 822 Message-ID header, null when the message has none: two Gmail ids with the
  // same value hold one message (a self-addressed message's sent and received copies).
  messageIdHeader: string | null;
  attachments: number;
};

// A message ready to be written: its file content, and its manifest and window-metadata
// entries. Built before anything on disk is touched.
type PreparedMessage = {
  file: string;
  content: Record<string, unknown>;
  manifest: ManifestEntry;
  metadata: Record<string, unknown>;
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

// The guard: messages/ may be deleted only when it is absent, empty, or holds the marker and
// nothing but the tool's own files. The first foreign entries are named in the refusal. A
// manifest.json beside it proves nothing: only the marker does.
function assertMessagesDirDeletable(messagesDir: string): void {
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
  const foreign = entries.filter(entry => !isOwnedEntry(entry)).map(entry => String(entry.name)).sort();
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? `, … (${foreign.length} entries)` : '');
    throw new Error(`refusing to delete ${messagesDir}: it contains entries batch_fetch_window did not write: ${shown}`);
  }
  if (entries.length > 0 && !entries.some(entry => String(entry.name) === MESSAGES_DIR_MARKER)) {
    throw new Error(`refusing to delete ${messagesDir}: it has no ${MESSAGES_DIR_MARKER} marker, so batch_fetch_window did not create it`);
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

// The window the cross-check covers: the search bounds of its listings, the listed messages,
// and, for a bounded window, its dating.
type CheckedWindow = { bounds: string; ids: string[]; dating?: WindowDating };

async function runCrossCheck(
  gmail: gmail_v1.Gmail,
  checked: CheckedWindow,
  failures: Failure[],
  retry: GmailRetryOptions,
): Promise<CrossCheck> {
  const errors: CrossCheckError[] = [];
  const listings = [
    await crossCheckListing(gmail, `${checked.bounds} in:spam`, failures, errors, retry),
    await crossCheckListing(gmail, `${checked.bounds} in:trash`, failures, errors, retry),
    await crossCheckListing(gmail, `${checked.bounds} in:anywhere`, failures, errors, retry),
  ];
  const window = new Set(checked.ids);
  // A bounded window's listings hold whole seconds at each bound. Every message they show that
  // the interior listing does not hold is dated, and those dated outside the window leave all
  // three listings; one that cannot be dated stays, so the check never explains it away. The
  // window's own interior listing serves when there was one; otherwise the check lists the
  // interior itself, and when that listing fails the check is failed and dates nothing more.
  let outside = new Set<string>();
  if (checked.dating !== undefined) {
    const { dating } = checked;
    if (dating.interior === undefined && dating.interiorQuery !== undefined) {
      const listed = await crossCheckListing(gmail, dating.interiorQuery, failures, errors, retry);
      listings.push(listed);
      if (listed.complete) dating.interior = listed.ids;
    }
    const interior = dating.interiorQuery === undefined ? new Set<string>() : dating.interior;
    const shown = new Set(listings.slice(0, 3).flatMap(listing => [...listing.ids]));
    const dated = interior === undefined ? new Set<string>() : await dating.outsideOf([...shown].filter(id => !interior.has(id)), 'inside');
    // A date learned earlier holds whichever listing of the check failed since.
    outside = new Set([...dated, ...dating.knownOutside()]);
  }
  const [spam, trash, anywhere] = listings.slice(0, 3).map(listing => new Set([...listing.ids].filter(id => !outside.has(id))));
  const unexplainedIds = [...anywhere].filter(id => !window.has(id) && !spam.has(id) && !trash.has(id));
  // A listing that failed cannot explain or reveal anything, so the check is consistent only
  // when every listing ran to the end and left nothing unexplained. The window listing itself
  // is always complete here: an incomplete one fails the whole call.
  const complete = listings.every(listing => listing.complete);
  const counts = { window: window.size, spam: spam.size, trash: trash.size, anywhere: anywhere.size };
  const shared = { complete, unexplainedIds, errors, counts, ...counts };
  if (!complete) {
    return { ...shared, status: 'failed', consistent: false };
  }
  if (unexplainedIds.length > 0) {
    return { ...shared, status: 'inconsistent', consistent: false };
  }
  return { ...shared, status: 'consistent', consistent: true };
}

// A window listing that did not complete fails the whole call, before the guard and before any
// deletion, so nothing under output_dir changes.
async function completeListing(gmail: gmail_v1.Gmail, query: string, retry: GmailRetryOptions): Promise<ListAllMessageIdsResult> {
  const listing = await listAllGmailMessageIds(gmail, { query, includeSpamTrash: true, retry });
  if (!listing.complete) {
    const attempts = listing.attempts ?? 1;
    throw withContext(
      `window listing failed: query "${query}" page ${listing.failedPage} `
      + `status ${failureStatus(listing.error)} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      listing.error,
    );
  }
  return listing;
}

// A message's internalDate as a number, or undefined when the message carries none.
function usableDate(data: gmail_v1.Schema$Message): number | undefined {
  const internal = Number(data.internalDate);
  return data.internalDate === undefined || data.internalDate === null || !Number.isFinite(internal) ? undefined : internal;
}

function noDateFailure(id: string, attempts: number): Failure {
  return { id, error: 'no internalDate', operation: 'messages.get', status: 'no-internal-date', attempts };
}

// The dating of a bounded window. Gmail's search bounds count whole seconds, so the window's
// listings also hold the messages of the watermark's second dated before it and of the end's
// second dated after it. interiorQuery lists, across every label, seconds strictly inside the
// window however Gmail reads after: and before: (none when the window is too short to have
// such seconds), and interior holds its IDs once listed: a message it holds is inside the
// window, and any other is dated, so a message missing from it for any reason is never taken to
// be inside. outsideOf dates messages (format metadata, fields id and internalDate, each
// message once) and gives those dated outside the window. A lookup that fails, or a response
// without the date, is recorded in failures with the calls it made, and that message counts as
// undated says: outside, where an unknown date must not let a message into the window, or
// inside, where it must not explain a message away. knownOutside gives every message dated
// outside the window so far, with no further lookup.
type WindowDating = {
  interiorQuery?: string;
  interior?: Set<string>;
  outsideOf: (ids: string[], undated: 'outside' | 'inside') => Promise<Set<string>>;
  knownOutside: () => Set<string>;
};

function windowDating(gmail: gmail_v1.Gmail, boundaryMs: number, untilMs: number, failures: Failure[], retry: GmailRetryOptions): WindowDating {
  const dates = new Map<string, number | undefined>();
  const dateOf = async (id: string): Promise<number | undefined> => {
    let calls = 0;
    try {
      const { data } = await withGmailRetry(() => {
        calls += 1;
        return gmail.users.messages.get({ userId: 'me', id, format: 'metadata', fields: 'id,internalDate' });
      }, retry);
      const internal = usableDate(data);
      if (internal === undefined) failures.push(noDateFailure(id, calls));
      return internal;
    } catch (error) {
      if (isAuthError(error)) throw error;
      failures.push(failure(id, 'messages.get', error));
      return undefined;
    }
  };
  // after:a before:b holds the seconds after a and before b, and at worst a and b as well, so
  // starting one second past the watermark's second and ending one before the end's keeps it
  // strictly inside the window either way; it holds a second only when b - a is at least 2.
  const [first, last] = [Math.floor(boundaryMs / 1000) + 1, Math.floor(untilMs / 1000) - 1];
  const isOutside = (internal: number) => internal < boundaryMs || internal > untilMs;
  return {
    ...(last - first >= 2 ? { interiorQuery: `after:${first} before:${last} in:anywhere` } : {}),
    knownOutside: () => new Set([...dates].filter(([, internal]) => internal !== undefined && isOutside(internal)).map(([id]) => id)),
    outsideOf: async (ids, undated) => {
      const outside = new Set<string>();
      for (const id of new Set(ids)) {
        if (!dates.has(id)) dates.set(id, await dateOf(id));
        const internal = dates.get(id);
        if (internal === undefined ? undated === 'outside' : isOutside(internal)) outside.add(id);
      }
      return outside;
    },
  };
}

// The listed messages of a bounded window that leave it: those the interior listing does not
// hold, dated outside the window or not dated at all, so listed, max_messages and the download
// hold only messages known to be inside it. An empty listing needs no dating.
async function listedOutside(gmail: gmail_v1.Gmail, listed: string[], dating: WindowDating, retry: GmailRetryOptions): Promise<Set<string>> {
  if (listed.length === 0) return new Set();
  const interior = dating.interiorQuery === undefined ? new Set<string>() : new Set((await completeListing(gmail, dating.interiorQuery, retry)).ids);
  dating.interior = interior;
  return dating.outsideOf(listed.filter(id => !interior.has(id)), 'outside');
}

export async function batchFetchWindow(
  gmail: gmail_v1.Gmail,
  input: BatchFetchWindowInput,
  now: () => Date = () => new Date(),
  retry: GmailRetryOptions = {},
): Promise<BatchFetchWindowResult> {
  const boundaryMs = Date.parse(input.watermark);
  const epoch = Math.floor(boundaryMs / 1000);
  const untilMs = input.until === undefined ? undefined : Date.parse(input.until);
  const bounds = untilMs === undefined
    ? `after:${epoch - 1}`
    : `after:${epoch - 1} before:${Math.floor(untilMs / 1000) + 1}`;
  const windowQuery = `${bounds} -in:spam -in:trash`;

  const emailAddress = await withGmailRetry(() => getGmailEmailAddress(gmail), retry);
  const failures: Failure[] = [];
  const windowList = await completeListing(gmail, windowQuery, retry);
  const dating = untilMs === undefined ? undefined : windowDating(gmail, boundaryMs, untilMs, failures, retry);
  const outside = dating === undefined ? new Set<string>() : await listedOutside(gmail, windowList.ids, dating, retry);
  const windowIds = windowList.ids.filter(id => !outside.has(id));

  const base = {
    emailAddress,
    watermark: input.watermark,
    ...(input.until === undefined ? {} : { until: input.until }),
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowIds.length,
    maxMessages: input.max_messages,
    // Always true in a returned result: an incomplete listing fails the call above. Present so
    // the result shape is stable.
    listingComplete: true,
  };

  if (windowIds.length > input.max_messages) {
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
  // Fail fast on a foreign messages/ before spending any download; the guard runs again
  // immediately before the deletion below.
  assertMessagesDirDeletable(messagesDir);

  const kept: KeptMessage[] = [];
  let belowBoundaryOrExcluded = 0;
  for (const id of windowIds) {
    let data: gmail_v1.Schema$Message;
    let calls = 0;
    try {
      data = (await withGmailRetry(() => {
        calls += 1;
        return gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      }, retry)).data;
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push(failure(id, 'messages.get', error));
      continue;
    }
    const internal = Number(data.internalDate);
    // A bounded window holds only messages it can date inside it.
    if (untilMs !== undefined && usableDate(data) === undefined) {
      failures.push(noDateFailure(id, calls));
      continue;
    }
    const labels = data.labelIds ?? [];
    if (internal < boundaryMs || (untilMs !== undefined && internal > untilMs) || labels.includes('SPAM') || labels.includes('TRASH')) {
      belowBoundaryOrExcluded += 1;
      continue;
    }
    kept.push({ id, data, internal, labels });
  }

  kept.sort((left, right) => left.internal - right.internal);
  const width = Math.max(3, String(kept.length).length);

  // Resolve every body part now, so that after this loop the tool needs nothing further from
  // Gmail for the files themselves.
  const prepared: PreparedMessage[] = [];
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
    const { calendar, failures: calendarFailures } = await resolveCalendarPart(gmail, id, data.payload as MessagePart | undefined, retry);
    for (const calendarFailure of calendarFailures) {
      failures.push({
        id,
        error: calendarFailure.code,
        operation: 'calendar-part',
        status: calendarFailure.status,
        attempts: calendarFailure.attempts,
      });
    }
    const from = headerValue(headers, 'From');
    const subject = headerValue(headers, 'Subject');
    const dateHeader = headerValue(headers, 'Date');
    const messageIdHeader = optionalHeader(headers, 'Message-ID');
    const file = path.join(messagesDir, `${String(index + 1).padStart(width, '0')}.json`);
    prepared.push({
      file,
      content: {
        id,
        threadId: data.threadId,
        internalDate: data.internalDate,
        labelIds: labels,
        from,
        to: headerValue(headers, 'To'),
        cc: headerValue(headers, 'Cc'),
        subject,
        dateHeader,
        messageIdHeader,
        snippet: data.snippet ?? '',
        attachments: resolved.attachments,
        body: resolved.body,
        bodySource: resolved.bodySource,
        htmlBody: resolved.htmlBody,
        // Only a message whose HTML part could not be fetched carries this.
        ...(resolved.htmlBodyError === undefined ? {} : { htmlBodyError: resolved.htmlBodyError }),
        alternatives: resolved.alternatives,
        // Only a message whose plain part could not be fetched or decoded carries this.
        ...(resolved.plainBodyError === undefined ? {} : { plainBodyError: resolved.plainBodyError }),
        // Only a message with a text/calendar part carries these.
        ...(calendar === undefined ? {} : { calendarMethod: calendar.method }),
        ...(calendar?.reply === undefined ? {} : { calendarReply: calendar.reply }),
      },
      manifest: {
        file,
        id,
        internalDate: data.internalDate,
        labelIds: labels,
        from,
        subject,
        dateHeader,
        messageIdHeader,
        attachments: resolved.attachments.length,
      },
      metadata: {
        id,
        internalDate: data.internalDate,
        labelIds: labels,
        headers: headers.filter(header => METADATA_HEADERS.has((header.name ?? '').toLowerCase())),
      },
    });
  }

  const crossCheck = input.cross_check
    ? await runCrossCheck(gmail, { bounds, ids: windowIds, ...(dating === undefined ? {} : { dating }) }, failures, retry)
    : CROSS_CHECK_SKIPPED;

  // Every Gmail call is behind us, so from here only the local file system can fail. Remove
  // exactly the three paths the tool owns, metadata first, so that until the final publish no
  // manifest exists that could describe deleted or partial files. Nothing else under
  // output_dir is read, matched or deleted, and the guard runs again right before the first
  // deletion so a refused run leaves every earlier output intact.
  assertMessagesDirDeletable(messagesDir);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(windowMetadataPath, { force: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);
  writeJson(path.join(messagesDir, MESSAGES_DIR_MARKER), { tool: 'batch_fetch_window' });
  for (const { file, content } of prepared) {
    writeJson(file, content);
  }
  const manifestMessages = prepared.map(entry => entry.manifest);
  const metadataMessages = prepared.map(entry => entry.metadata);

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
