import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  createCalendarEvent,
  createOrgCalendar,
  ensureDefaultCalendar,
  ensurePersonalCalendar,
  getOrCreateSourceCalendar,
  listCalendarEvents,
  listCalendars,
  upsertImportedEvent,
} from '../src/workspace-data/calendar.js';

describe('organization calendar', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-cal-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  it('creates a default calendar and expands weekly recurrence in range', async () => {
    const calendar = await ensureDefaultCalendar(db(), orgId);
    expect(calendar.name).toBe('Organization');
    expect(calendar.kind).toBe('shared');
    await createCalendarEvent(db(), orgId, 'user-1', {
      title: 'Standup',
      startsAt: '2026-09-07T13:00:00',
      endsAt: '2026-09-07T13:30:00',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    });
    const listed = await listCalendarEvents(db(), orgId, {
      from: '2026-09-07',
      to: '2026-09-22',
      expand: true,
    });
    expect(listed.map((event) => event.startsAt.slice(0, 10))).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]);
    expect(new Set(listed.map((event) => event.id)).size).toBe(1);
  });

  it('upserts Apple and Notion imports onto named source calendars', async () => {
    const apple = await getOrCreateSourceCalendar(db(), orgId, 'apple', 'iCloud', { externalId: 'icloud' });
    await upsertImportedEvent(db(), orgId, 'user-1', {
      title: 'Flight',
      startsAt: '2026-09-12T09:00:00',
      endsAt: '2026-09-12T12:00:00',
      source: 'apple',
      calendarId: apple.id,
      externalUid: 'flight-1',
    });
    await upsertImportedEvent(db(), orgId, 'user-1', {
      title: 'Flight (updated)',
      startsAt: '2026-09-12T10:00:00',
      endsAt: '2026-09-12T13:00:00',
      source: 'apple',
      calendarId: apple.id,
      externalUid: 'flight-1',
    });
    const notion = await getOrCreateSourceCalendar(db(), orgId, 'notion', 'Launches', { externalId: 'db-1' });
    await upsertImportedEvent(db(), orgId, 'user-1', {
      title: 'Launch',
      startsAt: '2026-09-10',
      endsAt: '2026-09-11',
      allDay: true,
      source: 'notion',
      calendarId: notion.id,
      externalUid: 'page-1',
    });
    const events = await listCalendarEvents(db(), orgId);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.source === 'apple')?.title).toBe('Flight (updated)');
    expect((await listCalendars(db(), orgId)).map((calendar) => calendar.source).sort()).toEqual([
      'apple',
      'local',
      'notion',
    ]);
  });

  it('creates team calendars and puts invited people on a teammate schedule', async () => {
    const personal = await ensurePersonalCalendar(db(), orgId, 'user-ada');
    expect(personal.kind).toBe('personal');
    expect(personal.ownerUserId).toBe('user-ada');
    const teamCal = await createOrgCalendar(db(), orgId, {
      name: 'Design',
      kind: 'team',
      teamId: 'team-design',
    });
    expect(teamCal.kind).toBe('team');
    const event = await createCalendarEvent(db(), orgId, 'user-ada', {
      title: 'Critique',
      startsAt: '2026-09-08T15:00:00',
      endsAt: '2026-09-08T16:00:00',
      calendarId: teamCal.id,
      guestUserIds: ['user-lin'],
      guestTeamIds: ['team-design'],
    });
    expect(event.guestUserIds).toEqual(['user-lin']);
    expect(event.guestTeamIds).toEqual(['team-design']);
    const people = {
      userIdsByTeamId: new Map([['team-design', ['user-ada', 'user-bea']]]),
    };
    const listed = await listCalendarEvents(db(), orgId, undefined, people);
    const critique = listed.find((item) => item.id === event.id);
    expect(critique?.scheduleUserIds.sort()).toEqual(['user-ada', 'user-bea', 'user-lin']);
    const linOnly = await listCalendarEvents(db(), orgId, undefined, {
      ...people,
      filterUserId: 'user-lin',
    });
    expect(linOnly.map((item) => item.title)).toEqual(['Critique']);
    const stranger = await listCalendarEvents(db(), orgId, undefined, {
      ...people,
      filterUserId: 'user-stranger',
    });
    expect(stranger).toEqual([]);
  });
});
