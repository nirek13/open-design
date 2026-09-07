import { describe, expect, it } from 'vitest';

import { eventsOverlap, eventVisibleOnBoard, keysForEvent, presetToRrule, rrulePreset } from '../../src/components/calendar/calendar-utils';
import type { CalendarEvent, OrgCalendar } from '@open-design/contracts';

describe('calendar-utils', () => {
  it('maps recurrence presets to RRULE values', () => {
    expect(rrulePreset(null)).toBe('none');
    expect(rrulePreset('FREQ=WEEKLY;BYDAY=MO')).toBe('weekly');
    expect(presetToRrule('daily', '2026-09-08T09:00')).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('spans all-day events across exclusive end dates', () => {
    expect(keysForEvent({
      id: '1',
      orgId: 'org',
      calendarId: 'cal',
      title: 'Offsite',
      description: null,
      location: null,
      startsAt: '2026-09-10',
      endsAt: '2026-09-12',
      allDay: true,
      color: '#5b6cff',
      recurrence: null,
      timezone: null,
      attendees: null,
      guestUserIds: [],
      guestTeamIds: [],
      scheduleUserIds: [],
      googleEventId: null,
      externalUid: null,
      source: 'apple',
      instanceId: '1',
      createdBy: 'u',
      createdAt: 0,
      updatedAt: 0,
    })).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('detects overlapping instants and hides others’ personal calendars until overlaid', () => {
    expect(eventsOverlap(
      { startsAt: '2026-09-08T15:00:00', endsAt: '2026-09-08T16:00:00' },
      { startsAt: '2026-09-08T15:30:00', endsAt: '2026-09-08T16:30:00' },
    )).toBe(true);
    expect(eventsOverlap(
      { startsAt: '2026-09-08T15:00:00', endsAt: '2026-09-08T16:00:00' },
      { startsAt: '2026-09-08T16:00:00', endsAt: '2026-09-08T17:00:00' },
    )).toBe(false);

    const personal: OrgCalendar = {
      id: 'ada-cal',
      orgId: 'org',
      name: 'Ada',
      color: '#5b6cff',
      source: 'local',
      kind: 'personal',
      ownerUserId: 'ada',
      teamId: null,
      visible: true,
      externalId: null,
      icsUrl: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const event: CalendarEvent = {
      id: '1',
      orgId: 'org',
      calendarId: 'ada-cal',
      title: 'Focus',
      description: null,
      location: null,
      startsAt: '2026-09-08T15:00:00',
      endsAt: '2026-09-08T16:00:00',
      allDay: false,
      color: '#5b6cff',
      recurrence: null,
      timezone: null,
      attendees: null,
      guestUserIds: [],
      guestTeamIds: [],
      scheduleUserIds: ['ada'],
      googleEventId: null,
      externalUid: null,
      source: 'local',
      instanceId: '1',
      createdBy: 'ada',
      createdAt: 0,
      updatedAt: 0,
    };
    expect(eventVisibleOnBoard(event, [personal], new Set(), 'me')).toBe(false);
    expect(eventVisibleOnBoard(event, [personal], new Set(['ada']), 'me')).toBe(true);
    expect(eventVisibleOnBoard(event, [personal], new Set(), 'ada')).toBe(true);
  });
});
