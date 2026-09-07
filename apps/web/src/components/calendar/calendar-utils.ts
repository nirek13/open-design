import type { CalendarEvent, OrgCalendar } from '@open-design/contracts';

export const HOUR_START = 6;
export const HOUR_END = 22;
export const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => i + HOUR_START);
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const SLOT_PX = 52;

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

export function weekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function dateKey(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toInputValue(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

export function fromInputValue(value: string, allDay: boolean): string {
  if (allDay) return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function keysForEvent(event: CalendarEvent): string[] {
  const startKey = dateKey(event.startsAt);
  let endKey = dateKey(event.endsAt);
  if (event.allDay && event.endsAt.length <= 10 && event.endsAt > event.startsAt) {
    const exclusive = new Date(`${event.endsAt}T00:00:00`);
    exclusive.setDate(exclusive.getDate() - 1);
    endKey = dateKey(exclusive);
  }
  const keys: string[] = [];
  let cursor = new Date(`${startKey}T00:00:00`);
  const last = new Date(`${endKey}T00:00:00`);
  while (cursor.getTime() <= last.getTime() && keys.length < 62) {
    keys.push(dateKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys.length > 0 ? keys : [startKey];
}

export function eventMinutes(event: CalendarEvent): { top: number; height: number } {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const origin = HOUR_START * 60;
  const top = Math.max(0, startMin - origin);
  const height = Math.max(18, (endMin || startMin + 30) - Math.max(startMin, origin));
  return { top: (top / 60) * SLOT_PX, height: (height / 60) * SLOT_PX };
}

export function nowLineTop(now = new Date()): number | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const origin = HOUR_START * 60;
  const end = HOUR_END * 60;
  if (minutes < origin || minutes > end) return null;
  return ((minutes - origin) / 60) * SLOT_PX;
}

export function formatEventTime(event: CalendarEvent, allDayLabel: string): string {
  if (event.allDay) return allDayLabel;
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${new Date(event.startsAt).toLocaleTimeString([], opts)} – ${new Date(event.endsAt).toLocaleTimeString([], opts)}`;
}

export function rrulePreset(rule: string | null | undefined): 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' {
  const freq = /FREQ=([A-Z]+)/i.exec(rule ?? '')?.[1]?.toUpperCase();
  if (freq === 'DAILY') return 'daily';
  if (freq === 'WEEKLY') return 'weekly';
  if (freq === 'MONTHLY') return 'monthly';
  if (freq === 'YEARLY') return 'yearly';
  return 'none';
}

export function presetToRrule(preset: string, startsAt: string): string | null {
  const date = new Date(startsAt.includes('T') ? startsAt : `${startsAt}T00:00:00`);
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY;INTERVAL=1';
    case 'weekly':
      return `FREQ=WEEKLY;INTERVAL=1;BYDAY=${days[date.getDay()]}`;
    case 'monthly':
      return `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${date.getDate()}`;
    case 'yearly':
      return 'FREQ=YEARLY;INTERVAL=1';
    default:
      return null;
  }
}

export function sourceLabelKey(source: CalendarEvent['source']): 'calendar.fromGoogle' | 'calendar.fromNotion' | 'calendar.fromApple' | null {
  if (source === 'google') return 'calendar.fromGoogle';
  if (source === 'notion') return 'calendar.fromNotion';
  if (source === 'apple') return 'calendar.fromApple';
  return null;
}

export function eventAccent(color: string | undefined, fallback = 'var(--accent)'): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

export function monthDays(cursor: Date): Date[] {
  const first = monthStart(cursor);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function eventsOverlap(
  a: Pick<CalendarEvent, 'startsAt' | 'endsAt'>,
  b: Pick<CalendarEvent, 'startsAt' | 'endsAt'>,
): boolean {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

/** Shared/team/own personal calendars follow the visible checkbox; other people's personal calendars only appear when overlaid. */
export function eventVisibleOnBoard(
  event: CalendarEvent,
  calendars: OrgCalendar[],
  overlayUserIds: ReadonlySet<string>,
  viewerUserId: string | null,
): boolean {
  if ((event.scheduleUserIds ?? []).some((userId) => overlayUserIds.has(userId))) return true;
  const calendar = calendars.find((item) => item.id === event.calendarId);
  if (!calendar) return true;
  if (calendar.kind === 'personal' && calendar.ownerUserId && calendar.ownerUserId !== viewerUserId) {
    return overlayUserIds.has(calendar.ownerUserId);
  }
  return calendar.visible;
}
