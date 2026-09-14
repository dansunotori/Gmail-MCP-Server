import fs from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { getGmailEmailAddress, listAllGmailMessageIds } from './gmail-sync.js';
import { headerValue, resolveMessageBody, type MessageHeader, type MessagePart } from './message-body.js';

export interface BatchFetchWindowInput {
  // ISO 8601 timestamp with an explicit zone; the window is inclusive of this instant.
  watermark: string;
  // Absolute directory that receives messages/, manifest.json and window-metadata.json.
  output_dir: string;
}

export interface BatchFetchWindowResult {
  checkedAt: string;
  emailAddress: string;
  watermark: string;
  boundaryMs: number;
  query: string;
  pages: number;
  listed: number;
  inWindow: number;
  belowBoundaryOrExcluded: number;
  triage: string[];
}

type KeptMessage = {
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

const METADATA_HEADERS = new Set(['From', 'To', 'Subject', 'Date']);

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

export async function batchFetchWindow(
  gmail: gmail_v1.Gmail,
  input: BatchFetchWindowInput,
  now: () => Date = () => new Date(),
): Promise<BatchFetchWindowResult> {
  const boundaryMs = Date.parse(input.watermark);
  const epoch = Math.floor(boundaryMs / 1000);
  const windowQuery = `after:${epoch - 1} -in:spam -in:trash`;

  const emailAddress = await getGmailEmailAddress(gmail);
  const windowList = await listAllGmailMessageIds(gmail, { query: windowQuery, includeSpamTrash: true });
  // A listing that stopped early cannot be reported by this result, so it is refused
  // rather than passed off as a complete window.
  if (!windowList.complete && windowList.error) {
    throw windowList.error;
  }

  const base = {
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    query: windowQuery,
    pages: windowList.pages,
    listed: windowList.ids.length,
  };

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
    const data = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    const internal = Number(data.internalDate);
    const labels = data.labelIds ?? [];
    if (internal < boundaryMs || labels.includes('SPAM') || labels.includes('TRASH')) {
      belowBoundaryOrExcluded += 1;
      continue;
    }
    kept.push({ data, internal, labels });
  }

  kept.sort((left, right) => left.internal - right.internal);
  const width = 3;
  const manifestMessages: ManifestEntry[] = [];
  const metadataMessages: Array<Record<string, unknown>> = [];

  for (const [index, { data, labels }] of kept.entries()) {
    const id = data.id ?? '';
    const headers = (data.payload?.headers ?? []) as MessageHeader[];
    const resolved = await resolveMessageBody(gmail, id, data.payload as MessagePart | undefined);
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
      headers: headers.filter(header => METADATA_HEADERS.has(header.name ?? '')),
    });
  }

  // Stamped after every fetch, immediately before publication, as the reference does.
  const summary = {
    checkedAt: now().toISOString(),
    ...base,
    inWindow: kept.length,
    belowBoundaryOrExcluded,
  };

  publishJson(messagesDir, windowMetadataPath, {
    checkedAt: summary.checkedAt,
    emailAddress,
    watermark: input.watermark,
    boundaryMs,
    messages: metadataMessages,
  });
  publishJson(messagesDir, manifestPath, { ...summary, messages: manifestMessages });

  const triage = manifestMessages.map(entry =>
    [entry.file, entry.from, entry.subject, entry.dateHeader, `${entry.attachments} att`].join(' | ')
  );
  return { ...summary, triage };
}
