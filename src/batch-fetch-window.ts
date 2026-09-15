import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { failureCode, getGmailEmailAddress, isAuthError, listAllGmailMessageIds, structuredResult } from './gmail-sync.js';
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';
import { BatchFetchWindowOutputSchema, BatchFetchWindowSchema } from './tools.js';

export type BatchFetchWindowInput = z.infer<typeof BatchFetchWindowSchema>;
export type BatchFetchWindowResult = z.infer<typeof BatchFetchWindowOutputSchema>;

type Failure = { id: string; error: string };

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

async function crossCheckListing(
  gmail: gmail_v1.Gmail,
  query: string,
  failures: Failure[],
): Promise<Set<string>> {
  try {
    const result = await listAllGmailMessageIds(gmail, { query, includeSpamTrash: true });
    if (!result.complete && result.error) {
      failures.push({ id: `cross-check:${query}`, error: failureCode(result.error) });
    }
    return new Set(result.ids);
  } catch (error) {
    if (isAuthError(error)) {
      throw error;
    }
    failures.push({ id: `cross-check:${query}`, error: failureCode(error) });
    return new Set();
  }
}

export async function batchFetchWindow(
  gmail: gmail_v1.Gmail,
  input: BatchFetchWindowInput,
  now: () => Date = () => new Date(),
): Promise<BatchFetchWindowResult> {
  const boundaryMs = Date.parse(input.watermark);
  const epoch = Math.floor(boundaryMs / 1000);
  const windowQuery = `after:${epoch - 1} -in:spam -in:trash`;

  const emailAddress = await getGmailEmailAddress(gmail);
  const failures: Failure[] = [];
  const windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true });
  if (!windowList.complete && windowList.error) {
    failures.push({ id: `window-listing:page-${windowList.pages + 1}`, error: failureCode(windowList.error) });
  }

  const base = {
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowList.ids.length,
    maxMessages: input.max_messages,
    listingComplete: windowList.complete,
  };

  if (windowList.ids.length > input.max_messages) {
    return BatchFetchWindowOutputSchema.parse({
      checkedAt: now().toISOString(),
      ...base,
      status: failures.length > 0 || !windowList.complete ? 'incomplete' : 'truncated',
      truncated: true,
      inWindow: 0,
      belowBoundaryOrExcluded: 0,
      failures,
      triage: [],
    });
  }

  const outputDir = input.output_dir;
  const messagesDir = path.join(outputDir, 'messages');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const windowMetadataPath = path.join(outputDir, 'window-metadata.json');
  // Remove exactly the three paths the tool owns, metadata first, so that from here until
  // the final publish no manifest exists that could describe deleted or partial files.
  // Nothing else under output_dir is read, matched or deleted.
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(windowMetadataPath, { force: true });
  fs.rmSync(messagesDir, { recursive: true, force: true });
  fs.mkdirSync(messagesDir);

  const kept: KeptMessage[] = [];
  let belowBoundaryOrExcluded = 0;
  for (const id of windowList.ids) {
    let data: gmail_v1.Schema$Message;
    try {
      data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    } catch (error) {
      if (isAuthError(error)) {
        throw error;
      }
      failures.push({ id, error: failureCode(error) });
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
    const resolved = await resolveMessageBody(gmail, id, data.payload as MessagePart | undefined);
    for (const failure of resolved.failures) {
      failures.push({ id, error: failure.code });
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

  let crossCheck: BatchFetchWindowResult['crossCheck'];
  if (input.cross_check) {
    const spam = await crossCheckListing(gmail, `after:${epoch - 1} in:spam`, failures);
    const trash = await crossCheckListing(gmail, `after:${epoch - 1} in:trash`, failures);
    const anywhere = await crossCheckListing(gmail, `after:${epoch - 1} in:anywhere`, failures);
    const windowIds = new Set(windowList.ids);
    const unexplainedIds = [...anywhere].filter(id => !windowIds.has(id) && !spam.has(id) && !trash.has(id));
    crossCheck = {
      window: windowList.ids.length,
      spam: spam.size,
      trash: trash.size,
      anywhere: anywhere.size,
      unexplainedIds,
      consistent: unexplainedIds.length === 0,
    };
  }

  // Stamped after every fetch and check, immediately before publication, so it dates the files rather than the listing.
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    truncated: false,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
    failures,
    ...(crossCheck ? { crossCheck } : {}),
  };

  const triage = manifestMessages.map(entry =>
    [entry.file, entry.from, entry.subject, entry.dateHeader, `${entry.attachments} att`].join(' | ')
  );
  const status = failures.length > 0 || !windowList.complete || (crossCheck !== undefined && !crossCheck.consistent)
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
