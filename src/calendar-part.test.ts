import { describe, expect, it, vi } from 'vitest';
import { CalendarParseError, parseCalendar, resolveCalendarPart } from './calendar-part.js';
import { GMAIL_RETRY_MAX_ATTEMPTS } from './gmail-sync.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');

const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:abc@example.com', ...lines, 'END:VEVENT'];

describe('parseCalendar', () => {
  it('reads the METHOD of an invitation and a cancellation', () => {
    expect(parseCalendar(ics('METHOD:REQUEST', ...event('SUMMARY:Planning')))).toEqual({ method: 'REQUEST' });
    expect(parseCalendar(ics('METHOD:CANCEL', ...event('STATUS:CANCELLED')))).toEqual({ method: 'CANCEL' });
  });

  it('reads the replying attendee and PARTSTAT of a reply, across folded lines and quoted parameters', () => {
    const accepted = ics(
      'METHOD:REPLY',
      ...event(
        'ATTENDEE;CN="Golev, Alexander";PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:sasha.golev@g',
        ' mail.com',
      ),
    );
    expect(parseCalendar(accepted)).toEqual({
      method: 'REPLY',
      reply: { attendee: 'sasha.golev@gmail.com', partstat: 'ACCEPTED' },
    });
    const declined = ics('METHOD:reply', ...event('ATTENDEE;partstat=declined:MAILTO:Nadia@Example.com'));
    expect(parseCalendar(declined)).toEqual({ method: 'REPLY', reply: { attendee: 'Nadia@Example.com', partstat: 'DECLINED' } });
  });

  it('reads parameters whose value is a comma-separated list of quoted values', () => {
    const reply = ics('METHOD:REPLY', ...event(
      'ATTENDEE;MEMBER="mailto:team@example.com","mailto:ops@example.com";PARTSTAT=TENTATIVE:mailto:sender@example.com',
    ));
    expect(parseCalendar(reply)).toEqual({ method: 'REPLY', reply: { attendee: 'sender@example.com', partstat: 'TENTATIVE' } });
  });

  it('takes the delegator as the replying attendee of a delegated reply, whatever the order', () => {
    const delegator = 'ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:a@example.com","mailto:delegate@example.com":mailto:sender@example.com';
    const delegate = 'ATTENDEE;PARTSTAT=NEEDS-ACTION;DELEGATED-FROM="mailto:sender@example.com":mailto:delegate@example.com';
    const expected = { method: 'REPLY', reply: { attendee: 'sender@example.com', partstat: 'DELEGATED' } };
    expect(parseCalendar(ics('METHOD:REPLY', ...event(delegator, delegate)))).toEqual(expected);
    expect(parseCalendar(ics('METHOD:REPLY', ...event(delegate, delegator)))).toEqual(expected);
  });

  it('recognises a delegator by its own DELEGATED-TO when the delegate entry has no DELEGATED-FROM', () => {
    const reply = ics('METHOD:REPLY', ...event(
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:delegate@example.com',
      'ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:Delegate@example.com":mailto:sender@example.com',
    ));
    expect(parseCalendar(reply)).toEqual({ method: 'REPLY', reply: { attendee: 'sender@example.com', partstat: 'DELEGATED' } });
  });

  it('reads one attendee across the components of a recurring reply, taking PARTSTAT from the master component', () => {
    const series = ['BEGIN:VEVENT', 'UID:r1', 'RRULE:FREQ=WEEKLY', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com', 'END:VEVENT'];
    const sameInstance = ['BEGIN:VEVENT', 'UID:r1', 'RECURRENCE-ID:20261020T090000Z', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:A@example.com', 'END:VEVENT'];
    const declinedInstance = ['BEGIN:VEVENT', 'UID:r1', 'RECURRENCE-ID:20261027T090000Z', 'ATTENDEE;PARTSTAT=DECLINED:mailto:a@example.com', 'END:VEVENT'];
    const expected = { method: 'REPLY', reply: { attendee: 'a@example.com', partstat: 'ACCEPTED' } };
    expect(parseCalendar(ics('METHOD:REPLY', ...series, ...sameInstance))).toEqual(expected);
    expect(parseCalendar(ics('METHOD:REPLY', ...declinedInstance, ...series))).toEqual(expected);
    // Without a master component, the first component the attendee answers in decides.
    expect(parseCalendar(ics('METHOD:REPLY', ...declinedInstance))).toEqual({
      method: 'REPLY', reply: { attendee: 'a@example.com', partstat: 'DECLINED' },
    });
  });

  it('takes the delegate as the replier when the delegate answers in a reply that lists both', () => {
    const delegator = 'ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:delegate@example.com":mailto:sender@example.com';
    for (const partstat of ['ACCEPTED', 'DECLINED']) {
      const delegate = `ATTENDEE;PARTSTAT=${partstat};DELEGATED-FROM="mailto:sender@example.com":mailto:delegate@example.com`;
      const expected = { method: 'REPLY', reply: { attendee: 'delegate@example.com', partstat } };
      expect(parseCalendar(ics('METHOD:REPLY', ...event(delegator, delegate)))).toEqual(expected);
      expect(parseCalendar(ics('METHOD:REPLY', ...event(delegate, delegator)))).toEqual(expected);
    }
  });

  it('takes the only attendee of a delegate\'s own reply', () => {
    const own = ics('METHOD:REPLY', ...event('ATTENDEE;PARTSTAT=ACCEPTED;DELEGATED-FROM="mailto:sender@example.com":mailto:delegate@example.com'));
    expect(parseCalendar(own)).toEqual({ method: 'REPLY', reply: { attendee: 'delegate@example.com', partstat: 'ACCEPTED' } });
  });

  it('rejects a reply whose replying attendee cannot be told apart', () => {
    const two = ics('METHOD:REPLY', ...event('ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com', 'ATTENDEE;PARTSTAT=DECLINED:mailto:b@example.com'));
    expect(() => parseCalendar(two)).toThrow(new CalendarParseError('REPLY has more than one ATTENDEE and no single replier'));
    const twoDelegators = ics('METHOD:REPLY', ...event(
      'ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:c@example.com":mailto:a@example.com',
      'ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:c@example.com":mailto:b@example.com',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:c@example.com',
    ));
    expect(() => parseCalendar(twoDelegators)).toThrow(new CalendarParseError('REPLY has more than one ATTENDEE and no single replier'));
  });

  it('accepts LF line endings and a METHOD with parameters', () => {
    expect(parseCalendar('BEGIN:VCALENDAR\nMETHOD;X-PARAM=1:PUBLISH\nEND:VCALENDAR\n')).toEqual({ method: 'PUBLISH' });
  });

  it('rejects a part with no METHOD, and a reply with no attendee or no PARTSTAT', () => {
    expect(() => parseCalendar(ics(...event('SUMMARY:x')))).toThrow(new CalendarParseError('no METHOD property'));
    expect(() => parseCalendar('not a calendar')).toThrow(new CalendarParseError('no METHOD property'));
    expect(() => parseCalendar(ics('METHOD:REPLY', ...event()))).toThrow(new CalendarParseError('REPLY has no ATTENDEE'));
    expect(() => parseCalendar(ics('METHOD:REPLY', ...event('ATTENDEE:mailto:a@example.com'))))
      .toThrow(new CalendarParseError('REPLY ATTENDEE has no PARTSTAT'));
  });
});

describe('resolveCalendarPart', () => {
  const gmailWith = (handler: (id: string) => Promise<{ data: { data?: string } }>) =>
    ({ users: { messages: { attachments: { get: vi.fn(({ id }: { id: string }) => handler(id)) } } } });

  it('finds nothing in a message without a calendar part', async () => {
    const gmail = gmailWith(async () => ({ data: {} }));
    expect(await resolveCalendarPart(gmail as never, 'm1', {
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/plain', body: { data: b64('hello') } }],
    })).toEqual({ failures: [] });
    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
  });

  it('reads an inline calendar part and fetches one stored as an attachment', async () => {
    const inline = await resolveCalendarPart(gmailWith(async () => ({ data: {} })) as never, 'm1', {
      parts: [{ mimeType: 'TEXT/CALENDAR', body: { data: b64(ics('METHOD:REQUEST')) } }],
    });
    expect(inline).toEqual({ calendar: { method: 'REQUEST' }, failures: [] });

    const gmail = gmailWith(async () => ({ data: { data: b64(ics('METHOD:CANCEL')) } }));
    const stored = await resolveCalendarPart(gmail as never, 'm2', {
      parts: [{ mimeType: 'text/calendar', filename: 'invite.ics', body: { attachmentId: 'ics-1', size: 400 } }],
    });
    expect(stored).toEqual({ calendar: { method: 'CANCEL' }, failures: [] });
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith({ userId: 'me', messageId: 'm2', id: 'ics-1' });
  });

  it('records a part that cannot be parsed, and still uses another part that can', async () => {
    const result = await resolveCalendarPart(gmailWith(async () => ({ data: {} })) as never, 'm1', {
      parts: [
        { mimeType: 'text/calendar', body: { data: b64('garbage') } },
        { mimeType: 'text/calendar', body: { data: b64(ics('METHOD:REQUEST')) } },
      ],
    });
    expect(result.calendar).toEqual({ method: 'REQUEST' });
    expect(result.failures).toEqual([{ code: 'calendar-part: no METHOD property', status: 'unparseable', attempts: 1 }]);
  });

  it('decodes a stored calendar part by the charset its Content-Type names, and records one it cannot decode', async () => {
    const utf16 = gmailWith(async () => ({ data: { data: Buffer.from(ics('METHOD:CANCEL'), 'utf16le').toString('base64url') } }));
    const stored = await resolveCalendarPart(utf16 as never, 'm1', {
      parts: [{ mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; method=CANCEL; charset=UTF-16LE' }], body: { attachmentId: 'ics-1' } }],
    });
    expect(stored).toEqual({ calendar: { method: 'CANCEL' }, failures: [] });

    const unknown = await resolveCalendarPart(gmailWith(async () => ({ data: { data: b64(ics('METHOD:CANCEL')) } })) as never, 'm1', {
      parts: [{ mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; charset=x-no-such-charset' }], body: { attachmentId: 'ics-1' } }],
    });
    expect(unknown).toEqual({ failures: [{ code: 'calendar-part-charset: x-no-such-charset', status: 'unknown-charset', attempts: 1 }] });
  });

  it('records a calendar part whose fetch still fails after its retries', async () => {
    const unavailable = Object.assign(new Error('HTTP 503'), { response: { status: 503, data: {} } });
    const gmail = gmailWith(async () => { throw unavailable; });
    const result = await resolveCalendarPart(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/calendar', filename: 'invite.ics', body: { attachmentId: 'ics-1' } }],
    }, { sleep: async () => {} });
    expect(result).toEqual({
      failures: [{ code: 'calendar-part-fetch: 503', status: 503, attempts: GMAIL_RETRY_MAX_ATTEMPTS }],
    });
  });

  it('rethrows an auth failure', async () => {
    const unauthorised = Object.assign(new Error('HTTP 401'), { response: { status: 401, data: {} } });
    const gmail = gmailWith(async () => { throw unauthorised; });
    await expect(resolveCalendarPart(gmail as never, 'm1', {
      parts: [{ mimeType: 'text/calendar', body: { attachmentId: 'ics-1' } }],
    })).rejects.toBe(unauthorised);
  });
});
