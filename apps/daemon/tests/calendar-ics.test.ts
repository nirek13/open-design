import { describe, expect, it } from 'vitest';

import { icsDateToIso, parseIcs, unfoldIcs } from '../src/workspace-data/ics.js';

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Work
BEGIN:VEVENT
UID:standup-1
DTSTART:20260908T130000Z
DTEND:20260908T133000Z
SUMMARY:Standup
LOCATION:Meet
DESCRIPTION:Daily sync
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
BEGIN:VEVENT
UID:offsite
DTSTART;VALUE=DATE:20260910
DTEND;VALUE=DATE:20260912
SUMMARY:Offsite
ATTENDEE;CN=Ada:mailto:ada@example.com
END:VEVENT
END:VCALENDAR
`;

describe('parseIcs', () => {
  it('unfolds folded lines', () => {
    expect(unfoldIcs('SUMMARY:Hel\r\n lo')).toBe('SUMMARY:Hello');
  });

  it('reads named calendars, timed events, all-day events, and attendees', () => {
    const parsed = parseIcs(SAMPLE);
    expect(parsed.name).toBe('Work');
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({
      uid: 'standup-1',
      title: 'Standup',
      location: 'Meet',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect(parsed.events[1]).toMatchObject({
      uid: 'offsite',
      title: 'Offsite',
      allDay: true,
      startsAt: '2026-09-10',
      endsAt: '2026-09-12',
      attendees: 'Ada',
    });
  });

  it('parses TZID wall times as naive ISO', () => {
    expect(icsDateToIso('20260908T090000', { TZID: 'America/New_York' })).toEqual({
      iso: '2026-09-08T09:00:00',
      allDay: false,
      timezone: 'America/New_York',
    });
  });
});
