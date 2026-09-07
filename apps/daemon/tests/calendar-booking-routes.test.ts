import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerCalendarRoutes } from '../src/routes/calendar.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { IdentityService } from '../src/auth/identity.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { createCalendarEvent } from '../src/workspace-data/calendar.js';

describe('calendar booking routes', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  let orgId = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-cal-book-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    const app = express();
    app.use(express.json());
    registerCalendarRoutes(app, {
      db: {} as never,
      auth: {} as never,
      calendar: {
        manager,
        identity: new IdentityService({ mode: 'local-owner', issuer: null, publishableKey: null }),
        connectors: { getCredential: () => null } as never,
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function json(method: string, url: string, body?: unknown) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }

  it('creates a booking link, hides busy times, and writes an ICS invite', async () => {
    const created = await json('POST', `/api/orgs/${orgId}/calendar/booking-types`, {
      title: 'Intro',
      durationMinutes: 30,
      timezone: 'UTC',
      weekdays: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '11:00',
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.body.bookingType.url).toContain(`/book/${created.body.token}`);
    expect(created.body.bookingType.tokenHash).toBeUndefined();

    const token = created.body.token as string;
    await createCalendarEvent(manager.workspaceExecutor(orgId), orgId, created.body.bookingType.ownerUserId, {
      title: 'Busy',
      startsAt: '2026-09-14T09:00:00.000Z',
      endsAt: '2026-09-14T09:30:00.000Z',
      calendarId: created.body.bookingType.calendarId,
    });

    const page = await json('GET', `/api/book/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.title).toBe('Intro');
    expect(page.body.hostName).toBeTruthy();

    const slots = await json('GET', `/api/book/${token}/slots?from=2026-09-14&to=2026-09-15`);
    expect(slots.status).toBe(200);
    const starts = (slots.body.slots as Array<{ startsAt: string }>).map((slot) => slot.startsAt);
    expect(starts).not.toContain('2026-09-14T09:00:00.000Z');
    expect(starts).toContain('2026-09-14T09:30:00.000Z');

    const booked = await json('POST', `/api/book/${token}`, {
      name: 'Lin',
      email: 'lin@example.com',
      startsAt: '2026-09-14T09:30:00.000Z',
    });
    expect(booked.status).toBe(201);
    expect(booked.body.ics).toContain('METHOD:REQUEST');
    expect(booked.body.ics).toContain('lin@example.com');
    expect(booked.body.googleUrl).toContain('calendar.google.com');

    const conflict = await json('POST', `/api/book/${token}`, {
      name: 'Bea',
      email: 'bea@example.com',
      startsAt: '2026-09-14T09:30:00.000Z',
    });
    expect(conflict.status).toBe(409);

    const listed = await json('GET', `/api/orgs/${orgId}/calendar/booking-types`);
    expect(listed.body.bookingTypes).toHaveLength(1);

    const events = await json('GET', `/api/orgs/${orgId}/calendar/events?from=2026-09-14&to=2026-09-15`);
    expect(events.body.events.some((event: { title: string }) => event.title === 'Intro')).toBe(true);
  });
});
