// Calendly-style booking links: a host publishes availability, a guest picks
// a free slot, and we write a calendar event plus an ICS invite.

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  BookingAvailability,
  CalendarBookingSlot,
  CalendarBookingType,
  UpsertCalendarBookingTypeRequest,
} from '@open-design/contracts';
import { BOOKING_DURATIONS } from '@open-design/contracts';
import type { SqlExecutor } from '../storage/sql.js';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { hashInviteToken, tokenHashesMatch } from './tenancy.js';
import { ensurePersonalCalendar, listCalendarEvents, type CalendarPeopleContext } from './calendar.js';

const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';
const DEFAULT_TZ = 'UTC';
const MAX_SLOT_DAYS = 28;

const TYPE_COLS = `
  id, workspace_id AS "orgId", owner_user_id AS "ownerUserId", calendar_id AS "calendarId",
  title, description, location, duration_minutes AS "durationMinutes",
  timezone, weekdays, start_time AS "startTime", end_time AS "endTime",
  token_hash AS "tokenHash", url, revoked_at AS "revokedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

interface TypeRow {
  id: string;
  orgId: string;
  ownerUserId: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number | string;
  timezone: string;
  weekdays: string;
  startTime: string;
  endTime: string;
  tokenHash: string;
  url: string;
  revokedAt: number | string | null;
  createdAt: number | string;
  updatedAt: number | string;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseHm(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function formatHm(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

/** UTC offset of `timeZone` at `date`, in minutes (negative west of UTC). */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** Instant for a wall-clock time in an IANA zone. */
export function zonedInstant(dateKey: string, hm: string, timeZone: string): Date {
  const parsed = parseHm(hm) ?? { h: 0, m: 0 };
  const wallAsUtc = new Date(`${dateKey}T${formatHm(parsed.h, parsed.m)}:00.000Z`).getTime();
  let instant = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const offset = tzOffsetMinutes(new Date(instant), timeZone);
    instant = wallAsUtc - offset * 60_000;
  }
  return new Date(instant);
}

function weekdayInZone(dateKey: string, timeZone: string): number {
  const noon = zonedInstant(dateKey, '12:00', timeZone);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).formatToParts(noon);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday ?? 'Sun');
}

function dateKeyFrom(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addUtcDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyFrom(date);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function normalizeAvailability(
  input: Partial<BookingAvailability> | UpsertCalendarBookingTypeRequest,
  fallbackTz = DEFAULT_TZ,
): BookingAvailability {
  const timezone = (typeof input.timezone === 'string' && input.timezone.trim()) || fallbackTz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw workspaceValidationError([{ path: 'timezone', message: 'unknown timezone' }]);
  }
  const weekdays = Array.isArray(input.weekdays)
    ? [...new Set(input.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : DEFAULT_WEEKDAYS;
  if (weekdays.length === 0) {
    throw workspaceValidationError([{ path: 'weekdays', message: 'pick at least one weekday' }]);
  }
  const startTime = typeof input.startTime === 'string' && parseHm(input.startTime)
    ? formatHm(parseHm(input.startTime)!.h, parseHm(input.startTime)!.m)
    : DEFAULT_START;
  const endTime = typeof input.endTime === 'string' && parseHm(input.endTime)
    ? formatHm(parseHm(input.endTime)!.h, parseHm(input.endTime)!.m)
    : DEFAULT_END;
  const start = parseHm(startTime)!;
  const end = parseHm(endTime)!;
  if (end.h * 60 + end.m <= start.h * 60 + start.m) {
    throw workspaceValidationError([{ path: 'endTime', message: 'end must be after start' }]);
  }
  return { timezone, weekdays, startTime, endTime };
}

export function normalizeDuration(value: unknown): number {
  const minutes = typeof value === 'number' ? value : Number(value);
  if ((BOOKING_DURATIONS as readonly number[]).includes(minutes)) return minutes;
  throw workspaceValidationError([{ path: 'durationMinutes', message: 'duration must be 15, 30, 45, or 60 minutes' }]);
}

function parseWeekdays(raw: string): number[] {
  return raw.split(',').map((part) => Number(part.trim())).filter((day) => Number.isInteger(day));
}

function mapType(row: TypeRow, publicBaseUrl?: string): CalendarBookingType {
  return {
    id: row.id,
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    calendarId: row.calendarId,
    title: row.title,
    description: row.description,
    location: row.location,
    durationMinutes: num(row.durationMinutes),
    availability: {
      timezone: row.timezone,
      weekdays: parseWeekdays(row.weekdays),
      startTime: row.startTime,
      endTime: row.endTime,
    },
    url: relocateBookingUrl(row.url, publicBaseUrl),
    revokedAt: row.revokedAt == null ? null : num(row.revokedAt),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

export function relocateBookingUrl(storedUrl: string, publicBaseUrl?: string): string {
  if (!publicBaseUrl) return storedUrl;
  try {
    const parsed = new URL(storedUrl);
    if (!parsed.pathname.startsWith('/book/')) return storedUrl;
    return `${publicBaseUrl.replace(/\/+$/u, '')}${parsed.pathname}${parsed.search}`;
  } catch {
    return storedUrl;
  }
}

export function bookingUrlFor(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/u, '')}/book/${encodeURIComponent(token)}`;
}

export function listOpenSlots(input: {
  from: string;
  to: string;
  durationMinutes: number;
  availability: BookingAvailability;
  busy: Array<{ startsAt: string; endsAt: string }>;
  now?: Date;
}): CalendarBookingSlot[] {
  const now = input.now ?? new Date();
  const durationMs = input.durationMinutes * 60_000;
  const busy = input.busy.map((item) => ({
    start: new Date(item.startsAt.includes('T') ? item.startsAt : `${item.startsAt}T00:00:00`).getTime(),
    end: new Date(item.endsAt.includes('T') ? item.endsAt : `${item.endsAt}T00:00:00`).getTime(),
  })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
  const slots: CalendarBookingSlot[] = [];
  let cursor = input.from.slice(0, 10);
  const last = input.to.slice(0, 10);
  let days = 0;
  while (cursor < last && days < MAX_SLOT_DAYS) {
    days += 1;
    const weekday = weekdayInZone(cursor, input.availability.timezone);
    if (input.availability.weekdays.includes(weekday)) {
      let start = zonedInstant(cursor, input.availability.startTime, input.availability.timezone);
      const windowEnd = zonedInstant(cursor, input.availability.endTime, input.availability.timezone);
      while (start.getTime() + durationMs <= windowEnd.getTime()) {
        const end = new Date(start.getTime() + durationMs);
        if (start.getTime() >= now.getTime()) {
          const taken = busy.some((item) => rangesOverlap(start.getTime(), end.getTime(), item.start, item.end));
          if (!taken) {
            slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString() });
          }
        }
        start = new Date(start.getTime() + durationMs);
      }
    }
    cursor = addUtcDays(cursor, 1);
  }
  return slots;
}

export async function listBookingTypes(
  db: SqlExecutor,
  orgId: string,
  ownerUserId: string,
  publicBaseUrl?: string,
): Promise<CalendarBookingType[]> {
  const rows = await db.all<TypeRow>(
    `SELECT ${TYPE_COLS} FROM od_calendar_booking_types
     WHERE workspace_id = ? AND owner_user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [orgId, ownerUserId],
  );
  return rows.map((row) => mapType(row, publicBaseUrl));
}

export async function getBookingType(
  db: SqlExecutor,
  orgId: string,
  id: string,
): Promise<(CalendarBookingType & { tokenHash: string }) | null> {
  const row = await db.get<TypeRow>(
    `SELECT ${TYPE_COLS} FROM od_calendar_booking_types WHERE workspace_id = ? AND id = ?`,
    [orgId, id],
  );
  if (!row) return null;
  return { ...mapType(row), tokenHash: row.tokenHash };
}

export async function createBookingType(
  db: SqlExecutor,
  directory: SqlExecutor,
  orgId: string,
  ownerUserId: string,
  input: UpsertCalendarBookingTypeRequest,
  publicBaseUrl: string,
): Promise<{ bookingType: CalendarBookingType; token: string }> {
  const title = input.title.trim();
  if (!title) throw workspaceValidationError([{ path: 'title', message: 'title is required' }]);
  const durationMinutes = normalizeDuration(input.durationMinutes ?? 30);
  const availability = normalizeAvailability(input);
  const calendar = input.calendarId
    ? { id: input.calendarId }
    : await ensurePersonalCalendar(db, orgId, ownerUserId);
  const now = Date.now();
  const id = `book-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const url = bookingUrlFor(publicBaseUrl, token);
  await db.run(
    `INSERT INTO od_calendar_booking_types (
      id, workspace_id, owner_user_id, calendar_id, title, description, location,
      duration_minutes, timezone, weekdays, start_time, end_time, token_hash, url,
      revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      orgId,
      ownerUserId,
      calendar.id,
      title,
      input.description?.trim() || null,
      input.location?.trim() || null,
      durationMinutes,
      availability.timezone,
      availability.weekdays.join(','),
      availability.startTime,
      availability.endTime,
      tokenHash,
      url,
      now,
      now,
    ],
  );
  await directory.run(
    'INSERT INTO od_booking_routes (token_hash, workspace_id, booking_type_id, created_at) VALUES (?, ?, ?, ?)',
    [tokenHash, orgId, id, now],
  );
  const created = await getBookingType(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create booking link');
  return { bookingType: publicType(created, publicBaseUrl), token };
}

function relocateBookingType(type: CalendarBookingType, publicBaseUrl: string): CalendarBookingType {
  return { ...type, url: relocateBookingUrl(type.url, publicBaseUrl) };
}

function publicType(type: CalendarBookingType & { tokenHash?: string }, publicBaseUrl: string): CalendarBookingType {
  const { tokenHash: _tokenHash, ...rest } = type as CalendarBookingType & { tokenHash?: string };
  void _tokenHash;
  return relocateBookingType(rest, publicBaseUrl);
}

export async function revokeBookingType(
  db: SqlExecutor,
  directory: SqlExecutor,
  orgId: string,
  ownerUserId: string,
  id: string,
): Promise<void> {
  const existing = await getBookingType(db, orgId, id);
  if (!existing || existing.ownerUserId !== ownerUserId) {
    throw new WorkspaceDataError('NOT_FOUND', 404, 'booking link not found');
  }
  const now = Date.now();
  await db.run(
    `UPDATE od_calendar_booking_types SET revoked_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [now, now, orgId, id],
  );
  await directory.run('DELETE FROM od_booking_routes WHERE token_hash = ?', [existing.tokenHash]);
}

export async function resolveBookingToken(
  directory: SqlExecutor,
  token: string,
): Promise<{ orgId: string; bookingTypeId: string } | null> {
  const tokenHash = hashInviteToken(token);
  const row = await directory.get<{ orgId: string; bookingTypeId: string; tokenHash: string }>(
    `SELECT token_hash AS "tokenHash", workspace_id AS "orgId", booking_type_id AS "bookingTypeId"
     FROM od_booking_routes WHERE token_hash = ?`,
    [tokenHash],
  );
  if (!row || !tokenHashesMatch(row.tokenHash, tokenHash)) return null;
  return { orgId: row.orgId, bookingTypeId: row.bookingTypeId };
}

export async function loadPublicBookingType(
  db: SqlExecutor,
  orgId: string,
  bookingTypeId: string,
): Promise<CalendarBookingType | null> {
  const type = await getBookingType(db, orgId, bookingTypeId);
  if (!type || type.revokedAt) return null;
  return type;
}

export async function slotsForBookingType(
  db: SqlExecutor,
  orgId: string,
  type: CalendarBookingType,
  range: { from: string; to: string },
  people?: CalendarPeopleContext,
  now?: Date,
): Promise<CalendarBookingSlot[]> {
  const from = range.from.slice(0, 10);
  const to = range.to.slice(0, 10);
  const events = await listCalendarEvents(db, orgId, { from, to, expand: true }, {
    userIdsByTeamId: people?.userIdsByTeamId ?? new Map(),
    filterUserId: type.ownerUserId,
  });
  return listOpenSlots({
    from,
    to,
    durationMinutes: type.durationMinutes,
    availability: type.availability,
    busy: events.map((event) => ({ startsAt: event.startsAt, endsAt: event.endsAt })),
    ...(now ? { now } : {}),
  });
}

export function assertSlotOpen(
  type: CalendarBookingType,
  startsAt: string,
  slots: CalendarBookingSlot[],
): { startsAt: string; endsAt: string } {
  const startMs = new Date(startsAt).getTime();
  if (!Number.isFinite(startMs)) {
    throw workspaceValidationError([{ path: 'startsAt', message: 'startsAt must be an ISO timestamp' }]);
  }
  const match = slots.find((slot) => new Date(slot.startsAt).getTime() === startMs);
  if (!match) {
    throw new WorkspaceDataError('CONFLICT', 409, 'that time is no longer available');
  }
  return match;
}

export async function recordBooking(
  db: SqlExecutor,
  orgId: string,
  bookingTypeId: string,
  eventId: string,
  guest: { name: string; email: string; startsAt: string; endsAt: string },
): Promise<void> {
  try {
    await db.run(
      `INSERT INTO od_calendar_bookings (
        id, workspace_id, booking_type_id, event_id, guest_name, guest_email, starts_at, ends_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        orgId,
        bookingTypeId,
        eventId,
        guest.name,
        guest.email,
        guest.startsAt,
        guest.endsAt,
        Date.now(),
      ],
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (/unique|duplicate/i.test(message)) {
      throw new WorkspaceDataError('CONFLICT', 409, 'that time is no longer available');
    }
    throw err;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeGuest(body: { name?: unknown; email?: unknown; startsAt?: unknown }): {
  name: string;
  email: string;
  startsAt: string;
} {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const startsAt = typeof body.startsAt === 'string' ? body.startsAt.trim() : '';
  const issues = [];
  if (!name) issues.push({ path: 'name', message: 'name is required' });
  if (!EMAIL_RE.test(email)) issues.push({ path: 'email', message: 'email is required' });
  if (!startsAt) issues.push({ path: 'startsAt', message: 'startsAt is required' });
  if (issues.length) throw workspaceValidationError(issues);
  return { name, email, startsAt };
}
