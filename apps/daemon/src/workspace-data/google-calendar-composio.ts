// Parse Composio Google Calendar payloads and call the live tool slugs.
// The catalog historically used GOOGLECALENDAR_LIST_EVENTS; Composio's
// current slugs are EVENTS_LIST / EVENTS_LIST_ALL_CALENDARS.

import type { BoundedJsonObject } from '../live-artifacts/schema.js';
import { composioConnectorProvider } from '../connectors/composio.js';
import type { ConnectorCredentialMaterial } from '../connectors/service.js';

export interface GoogleCalendarEventDraft {
  id: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

const GOOGLE_CONNECTOR_ID = 'googlecalendar';

function googleTool(name: string, sideEffect: 'read' | 'write') {
  return {
    name,
    providerToolId: name,
    description: name,
    inputSchema: { type: 'object' },
    safety: {
      sideEffect,
      approval: sideEffect === 'read' ? 'auto' : 'confirm',
      reason: 'google calendar',
    },
  } as never;
}

async function executeGoogleTool(
  toolName: string,
  input: BoundedJsonObject,
  credentials: ConnectorCredentialMaterial | undefined,
  sideEffect: 'read' | 'write' = 'read',
): Promise<unknown> {
  return composioConnectorProvider.execute(
    { id: GOOGLE_CONNECTOR_ID } as never,
    googleTool(toolName, sideEffect),
    input,
    credentials,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function collectEventLikeObjects(value: unknown, into: Record<string, unknown>[]): void {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectEventLikeObjects(item, into);
    return;
  }
  const rec = asRecord(parsed);
  if (!rec) return;
  const looksLikeEvent = Boolean(
    (typeof rec.id === 'string' || typeof rec.event_id === 'string' || typeof rec.eventId === 'string')
    && (rec.start || rec.start_datetime || rec.startsAt || rec.summary || rec.title),
  );
  if (looksLikeEvent) into.push(rec);
  for (const key of ['items', 'events', 'event_list', 'summary_view', 'data', 'response_data', 'response']) {
    if (key in rec) collectEventLikeObjects(rec[key], into);
  }
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function startEnd(rec: Record<string, unknown>, which: 'start' | 'end'): { instant: string | null; allDay: boolean } {
  const nested = asRecord(rec[which]);
  const dateTime = nested
    ? stringField(nested, 'dateTime', 'date_time', 'datetime')
    : stringField(rec, which === 'start' ? 'start_datetime' : 'end_datetime', which === 'start' ? 'startsAt' : 'endsAt');
  const dateOnly = nested ? stringField(nested, 'date') : stringField(rec, which === 'start' ? 'start_date' : 'end_date');
  if (dateTime) return { instant: dateTime, allDay: false };
  if (dateOnly) return { instant: dateOnly, allDay: true };
  return { instant: null, allDay: false };
}

export function googleEventStorageId(calendarId: string, eventId: string): string {
  return calendarId === 'primary' ? eventId : `${calendarId}::${eventId}`;
}

export function parseGoogleEventStorageId(stored: string): { calendarId: string; eventId: string } {
  const split = stored.indexOf('::');
  if (split <= 0) return { calendarId: 'primary', eventId: stored };
  return { calendarId: stored.slice(0, split), eventId: stored.slice(split + 2) };
}

export function extractGoogleEvents(payload: unknown): GoogleCalendarEventDraft[] {
  const found: Record<string, unknown>[] = [];
  collectEventLikeObjects(payload, found);
  const out: GoogleCalendarEventDraft[] = [];
  const seen = new Set<string>();
  for (const event of found) {
    const id = stringField(event, 'id', 'event_id', 'eventId');
    if (!id) continue;
    const calendarId =
      stringField(event, 'calendar_id', 'calendarId', 'calendar')
      ?? 'primary';
    const start = startEnd(event, 'start');
    const end = startEnd(event, 'end');
    const startsAt = start.instant;
    if (!startsAt) continue;
    const endsAt = end.instant ?? startsAt;
    const storageId = googleEventStorageId(calendarId, id);
    if (seen.has(storageId)) continue;
    seen.add(storageId);
    out.push({
      id: storageId,
      calendarId,
      title: stringField(event, 'summary', 'title') ?? 'Untitled',
      description: stringField(event, 'description'),
      location: stringField(event, 'location'),
      startsAt,
      endsAt,
      allDay: start.allDay || end.allDay || event.all_day === true || event.allDay === true,
    });
  }
  return out;
}

export async function listGoogleCalendarEvents(
  credentials: ConnectorCredentialMaterial | undefined,
  range: { timeMin: string; timeMax: string },
): Promise<GoogleCalendarEventDraft[]> {
  try {
    const all = await executeGoogleTool(
      'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
      {
        time_min: range.timeMin,
        time_max: range.timeMax,
        single_events: true,
        response_detail: 'full',
        max_results_per_calendar: 2500,
      },
      credentials,
    );
    const extracted = extractGoogleEvents(all);
    if (extracted.length > 0) return extracted;
    // Empty can be a real empty calendar; still try primary list in case
    // LIST_ALL returned the compact summary_view without event ids.
  } catch {
    // Fall through to the single-calendar list tool.
  }
  const pages: GoogleCalendarEventDraft[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 8; i += 1) {
    const result = await executeGoogleTool(
      'GOOGLECALENDAR_EVENTS_LIST',
      {
        calendarId: 'primary',
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        singleEvents: true,
        maxResults: 2500,
        orderBy: 'startTime',
        ...(pageToken ? { pageToken } : {}),
      },
      credentials,
    );
    pages.push(...extractGoogleEvents(result));
    const rec = asRecord(parseMaybeJson(asRecord(result)?.data)) ?? asRecord(result);
    const next = rec ? stringField(rec, 'nextPageToken', 'next_page_token') : null;
    if (!next) break;
    pageToken = next;
  }
  return pages;
}

function naiveDateTime(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso}T00:00:00`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 19);
  return date.toISOString().slice(0, 19);
}

export async function createGoogleCalendarEvent(
  credentials: ConnectorCredentialMaterial | undefined,
  input: { title: string; description: string | null; location: string | null; startsAt: string; endsAt: string; allDay: boolean },
): Promise<string | null> {
  try {
    const arguments_: BoundedJsonObject = {
      summary: input.title,
      start_datetime: naiveDateTime(input.startsAt),
      end_datetime: naiveDateTime(input.endsAt),
      timezone: 'UTC',
      calendar_id: 'primary',
      create_meeting_room: false,
    };
    if (input.description) arguments_.description = input.description;
    if (input.location) arguments_.location = input.location;
    const result = await executeGoogleTool(
      'GOOGLECALENDAR_CREATE_EVENT',
      arguments_,
      credentials,
      'write',
    );
    const extracted = extractGoogleEvents(result);
    if (extracted[0]) return extracted[0].id;
    const rec = asRecord(parseMaybeJson(asRecord(result)?.data)) ?? asRecord(result);
    const id = rec ? stringField(rec, 'id', 'event_id', 'eventId') : null;
    return id ? googleEventStorageId('primary', id) : null;
  } catch {
    return null;
  }
}

export async function patchGoogleCalendarEvent(
  credentials: ConnectorCredentialMaterial | undefined,
  storedId: string,
  input: { title: string; description: string | null; location: string | null; startsAt: string; endsAt: string; allDay: boolean },
): Promise<void> {
  const { calendarId, eventId } = parseGoogleEventStorageId(storedId);
  const arguments_: BoundedJsonObject = {
    calendar_id: calendarId,
    event_id: eventId,
    summary: input.title,
    start_time: input.allDay ? input.startsAt.slice(0, 10) : input.startsAt,
    end_time: input.allDay ? input.endsAt.slice(0, 10) : input.endsAt,
    timezone: 'UTC',
  };
  if (input.description) arguments_.description = input.description;
  if (input.location) arguments_.location = input.location;
  await executeGoogleTool(
    'GOOGLECALENDAR_PATCH_EVENT',
    arguments_,
    credentials,
    'write',
  );
}

export async function deleteGoogleCalendarEvent(
  credentials: ConnectorCredentialMaterial | undefined,
  storedId: string,
): Promise<void> {
  const { calendarId, eventId } = parseGoogleEventStorageId(storedId);
  try {
    await executeGoogleTool(
      'GOOGLECALENDAR_DELETE_EVENT',
      { calendar_id: calendarId, event_id: eventId },
      credentials,
      'write',
    );
  } catch {
    // Treat missing remote events as already gone.
  }
}
