import { describe, expect, it } from 'vitest';

import { parseIcs, serializeIcsInvite, googleCalendarTemplateUrl } from '../src/workspace-data/ics.js';
import { listOpenSlots, zonedInstant } from '../src/workspace-data/calendar-booking.js';

describe('serializeIcsInvite', () => {
  it('emits a METHOD:REQUEST that parseIcs can read back', () => {
    const ics = serializeIcsInvite({
      uid: 'meet-1',
      title: 'Intro',
      description: 'Hello',
      location: 'Meet',
      startsAt: '2026-09-10T15:00:00.000Z',
      endsAt: '2026-09-10T15:30:00.000Z',
      organizerName: 'Ada',
      organizerEmail: 'ada@example.com',
      attendeeName: 'Lin',
      attendeeEmail: 'lin@example.com',
    });
    expect(ics).toContain('METHOD:REQUEST');
    const parsed = parseIcs(ics);
    expect(parsed.events[0]).toMatchObject({
      uid: 'meet-1',
      title: 'Intro',
      location: 'Meet',
      attendees: 'Lin',
    });
    expect(googleCalendarTemplateUrl({
      title: 'Intro',
      startsAt: '2026-09-10T15:00:00.000Z',
      endsAt: '2026-09-10T15:30:00.000Z',
    })).toContain('calendar.google.com/calendar/render');
  });
});

describe('listOpenSlots', () => {
  const availability = {
    timezone: 'UTC',
    weekdays: [1, 2, 3, 4, 5],
    startTime: '09:00',
    endTime: '12:00',
  };

  it('skips weekends, past times, and overlapping busy blocks', () => {
    const slots = listOpenSlots({
      from: '2026-09-11',
      to: '2026-09-15',
      durationMinutes: 60,
      availability,
      busy: [{ startsAt: '2026-09-14T10:00:00.000Z', endsAt: '2026-09-14T11:00:00.000Z' }],
      now: new Date('2026-09-11T08:00:00.000Z'),
    });
    // 11 Fri 09,10,11; 12-13 weekend skipped; 14 Mon 09,11 (10 busy)
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-09-11T09:00:00.000Z',
      '2026-09-11T10:00:00.000Z',
      '2026-09-11T11:00:00.000Z',
      '2026-09-14T09:00:00.000Z',
      '2026-09-14T11:00:00.000Z',
    ]);
  });

  it('places wall-clock hours in the host timezone', () => {
    const start = zonedInstant('2026-09-08', '09:00', 'America/New_York');
    expect(start.toISOString()).toBe('2026-09-08T13:00:00.000Z');
  });
});
