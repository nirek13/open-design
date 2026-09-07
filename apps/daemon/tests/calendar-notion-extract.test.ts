import { describe, expect, it } from 'vitest';

import { extractNotionCalendarEvents, extractNotionDatabases } from '../src/workspace-data/notion-calendar-composio.js';

describe('extractNotionCalendarEvents', () => {
  it('reads database rows with a date property', () => {
    const events = extractNotionCalendarEvents({
      results: [
        {
          object: 'page',
          id: 'page-1',
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Ship calendar' }] },
            Date: { type: 'date', date: { start: '2026-09-08T15:00:00.000Z', end: '2026-09-08T16:00:00.000Z' } },
          },
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({
        id: 'page-1',
        title: 'Ship calendar',
        startsAt: '2026-09-08T15:00:00.000Z',
        allDay: false,
        databaseId: 'db-1',
      }),
    ]);
  });

  it('reads all-day Notion dates and skips databases themselves', () => {
    const payload = {
      results: [
        { object: 'database', id: 'db-2', title: [{ plain_text: 'Launches' }] },
        {
          id: 'page-2',
          properties: {
            title: { title: [{ plain_text: 'Launch day' }] },
            When: { type: 'date', date: { start: '2026-09-10', end: '2026-09-11' } },
          },
        },
      ],
    };
    expect(extractNotionDatabases(payload)).toEqual([{ id: 'db-2', title: 'Launches' }]);
    expect(extractNotionCalendarEvents(payload)[0]).toMatchObject({
      title: 'Launch day',
      startsAt: '2026-09-10',
      allDay: true,
    });
  });
});
