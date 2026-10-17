/**
 * The text/calendar part of a message (an invitation, a cancellation, an attendee's reply),
 * read from the part itself: its METHOD and, for a REPLY, the replying attendee and their
 * PARTSTAT. batch_fetch_window writes these into the message file.
 */

import type { gmail_v1 } from 'googleapis';
import {
  failureCode,
  isAuthError,
  retryAttempts,
  toGmailRequestError,
  withGmailRetry,
  type GmailRetryOptions,
} from './gmail-sync.js';
import { decodeBase64Url, type MessagePart } from './message-body.js';

export interface CalendarFields {
  method: string;
  // Present for a REPLY only.
  reply?: { attendee: string; partstat: string };
}

export class CalendarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarParseError';
  }
}

// A calendar part that could not be fetched or parsed. `status` is the HTTP status or
// network code of a failed fetch, or "unparseable".
export interface CalendarFailure {
  code: string;
  status: number | string;
  attempts: number;
}

export interface ResolvedCalendar {
  calendar?: CalendarFields;
  failures: CalendarFailure[];
}

// A parameter's values in order: a parameter may carry a comma-separated list
// (DELEGATED-TO="mailto:a","mailto:b"). `component` numbers the component (VEVENT, VTODO,
// …) the line belongs to, 0 for lines directly in VCALENDAR.
type ContentLine = { name: string; params: Map<string, string[]>; value: string; component: number };

// RFC 5545 content lines: a line that starts with a space or tab continues the one before.
function contentLines(text: string): ContentLine[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines: ContentLine[] = [];
  const open: number[] = [];
  let components = 0;
  for (const line of unfolded.split(/\r?\n/)) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    if (parsed.name === 'BEGIN' && parsed.value.trim().toUpperCase() !== 'VCALENDAR') {
      open.push(++components);
    } else if (parsed.name === 'END' && parsed.value.trim().toUpperCase() !== 'VCALENDAR') {
      open.pop();
    }
    lines.push({ ...parsed, component: open[open.length - 1] ?? 0 });
  }
  return lines;
}

// One parameter value: double-quoted (and then free to contain ";", ":" and ","), or a run
// of characters other than those delimiters (RFC 5545 section 3.1).
const PARAM_VALUE = /^(?:"([^"]*)"|([^";:,]*))/;

// NAME *(";" PARAM "=" VALUE *("," VALUE)) ":" VALUE
function parseContentLine(line: string): Omit<ContentLine, 'component'> | undefined {
  const nameMatch = /^([A-Za-z0-9-]+)/.exec(line);
  if (!nameMatch) return undefined;
  const params = new Map<string, string[]>();
  let rest = line.slice(nameMatch[1].length);
  while (rest.startsWith(';')) {
    const paramName = /^;([A-Za-z0-9-]+)=/.exec(rest);
    if (!paramName) return undefined;
    rest = rest.slice(paramName[0].length);
    const values: string[] = [];
    for (;;) {
      const value = PARAM_VALUE.exec(rest) as RegExpExecArray;
      values.push(value[1] ?? value[2]);
      rest = rest.slice(value[0].length);
      if (!rest.startsWith(',')) break;
      rest = rest.slice(1);
    }
    params.set(paramName[1].toUpperCase(), values);
  }
  if (!rest.startsWith(':')) return undefined;
  return { name: nameMatch[1].toUpperCase(), params, value: rest.slice(1) };
}

const address = (value: string) => value.trim().replace(/^mailto:/i, '');
const addressKey = (value: string) => address(value).toLowerCase();

// The ATTENDEE lines and PARTSTAT of the attendee who sent a REPLY. Attendees are people, not
// lines: one address repeated across the components of a recurring event is one attendee.
// A reply normally lists only its sender. A delegation reply also lists the other party (RFC
// 5546 sections 4.2.5 to 4.2.7), and the statuses tell the two apart: when the delegator
// sends it, the delegator is DELEGATED and the delegate has not answered (NEEDS-ACTION); when
// the delegate answers, the delegate carries that answer. So the replier is the one attendee
// with an answer (any PARTSTAT but NEEDS-ACTION and DELEGATED), or, when nobody has answered,
// the one attendee who delegated. Anything else is ambiguous and is not guessed at. Property
// order never decides it.
function replyingAttendee(attendees: ContentLine[], all: ContentLine[]): { lines: ContentLine[]; partstat?: string } {
  const byAddress = new Map<string, ContentLine[]>();
  for (const line of attendees) {
    const key = addressKey(line.value);
    byAddress.set(key, [...(byAddress.get(key) ?? []), line]);
  }
  const people = [...byAddress.values()].map(lines => ({ lines, partstat: partstatOf(lines, all)?.toUpperCase() }));
  if (people.length === 1) {
    return people[0];
  }
  const answered = people.filter(person => person.partstat !== undefined && person.partstat !== 'NEEDS-ACTION' && person.partstat !== 'DELEGATED');
  if (answered.length === 1) {
    return answered[0];
  }
  const delegated = people.filter(person => person.partstat === 'DELEGATED');
  if (answered.length === 0 && delegated.length === 1) {
    return delegated[0];
  }
  throw new CalendarParseError('REPLY has more than one ATTENDEE and no single replier');
}

// The attendee's PARTSTAT from the master component (the one without RECURRENCE-ID), so one
// declined occurrence does not stand for an accepted series; failing that, from the first
// component the attendee answers in.
function partstatOf(lines: ContentLine[], all: ContentLine[]): string | undefined {
  const occurrences = new Set(all.filter(line => line.name === 'RECURRENCE-ID').map(line => line.component));
  const ordered = [...lines.filter(line => !occurrences.has(line.component)), ...lines.filter(line => occurrences.has(line.component))];
  return ordered.map(line => line.params.get('PARTSTAT')?.[0]).find(value => value !== undefined && value !== '');
}

export function parseCalendar(text: string): CalendarFields {
  const lines = contentLines(text);
  const method = lines.find(line => line.name === 'METHOD')?.value.trim().toUpperCase();
  if (!method) {
    throw new CalendarParseError('no METHOD property');
  }
  if (method !== 'REPLY') {
    return { method };
  }
  const attendees = lines.filter(line => line.name === 'ATTENDEE');
  if (attendees.length === 0) {
    throw new CalendarParseError('REPLY has no ATTENDEE');
  }
  const replier = replyingAttendee(attendees, lines);
  if (!replier.partstat) {
    throw new CalendarParseError('REPLY ATTENDEE has no PARTSTAT');
  }
  return {
    method,
    reply: { attendee: address(replier.lines[0].value), partstat: replier.partstat },
  };
}

function calendarParts(payload: MessagePart | null | undefined, found: MessagePart[] = []): MessagePart[] {
  if (!payload) return found;
  if ((payload.mimeType ?? '').toLowerCase() === 'text/calendar') found.push(payload);
  for (const part of payload.parts ?? []) calendarParts(part, found);
  return found;
}

// Reads every text/calendar part, inline or stored as an attachment, and returns the fields
// of the first one that parses. Each part that cannot be fetched or parsed is a failure; an
// auth failure is thrown, as for body parts.
export async function resolveCalendarPart(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: MessagePart | null | undefined,
  retry: GmailRetryOptions = {},
): Promise<ResolvedCalendar> {
  const failures: CalendarFailure[] = [];
  let calendar: CalendarFields | undefined;
  for (const part of calendarParts(payload)) {
    let text = decodeBase64Url(part.body?.data);
    const attachmentId = part.body?.attachmentId;
    if (text === '' && attachmentId) {
      try {
        const response = await withGmailRetry(() => gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        }), retry);
        text = decodeBase64Url(response.data.data);
      } catch (error) {
        if (isAuthError(error)) {
          throw error;
        }
        const wrapped = toGmailRequestError(error);
        failures.push({
          code: `calendar-part-fetch: ${failureCode(error)}`,
          status: wrapped.status ?? failureCode(error),
          attempts: retryAttempts(error),
        });
        continue;
      }
    }
    try {
      const parsed = parseCalendar(text);
      calendar ??= parsed;
    } catch (error) {
      if (!(error instanceof CalendarParseError)) {
        throw error;
      }
      failures.push({ code: `calendar-part: ${error.message}`, status: 'unparseable', attempts: 1 });
    }
  }
  return calendar === undefined ? { failures } : { calendar, failures };
}
