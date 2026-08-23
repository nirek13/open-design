import { describe, expect, it } from 'vitest';

import {
  extractGoogleEvents,
  googleEventStorageId,
  parseGoogleEventStorageId,
} from '../src/workspace-data/google-calendar-composio.js';

describe('extractGoogleEvents', () => {
  it('reads Google Calendar API items nested under Composio data', () => {
    const events = extractGoogleEvents({
      toolName: 'GOOGLECALENDAR_EVENTS_LIST',
      data: {
        items: [
          {
            id: 'abc',
            summary: 'Standup',
            location: 'Meet',
            start: { dateTime: '2026-08-22T13:00:00-04:00' },
            end: { dateTime: '2026-08-22T13:30:00-04:00' },
          },
        ],
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        id: 'abc',
        title: 'Standup',
        location: 'Meet',
        allDay: false,
      }),
    ]);
  });

  it('reads all-day events and secondary calendar ids', () => {
    const events = extractGoogleEvents({
      data: JSON.stringify({
        events: [
          {
            id: 'day',
            calendar_id: 'work@group.calendar.google.com',
            title: 'Offsite',
            start: { date: '2026-08-22' },
            end: { date: '2026-08-23' },
          },
        ],
      }),
    });
    expect(events[0]).toMatchObject({
      id: googleEventStorageId('work@group.calendar.google.com', 'day'),
      allDay: true,
      startsAt: '2026-08-22',
      endsAt: '2026-08-23',
    });
  });

  it('parses storage ids for patch/delete', () => {
    expect(parseGoogleEventStorageId('plain')).toEqual({ calendarId: 'primary', eventId: 'plain' });
    expect(parseGoogleEventStorageId('cal::evt')).toEqual({ calendarId: 'cal', eventId: 'evt' });
  });
});
