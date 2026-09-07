// Expand RFC 5545 RRULE values across a visible calendar range.
// Supports FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY.

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const MAX_INSTANCES = 400;

export interface RecurrenceWindow {
  from: string;
  to: string;
}

export interface RecurrenceOccurrence {
  startsAt: string;
  endsAt: string;
}

function parseRrule(rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rule.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

function asDate(iso: string): Date {
  return new Date(iso.includes('T') ? iso : `${iso}T00:00:00`);
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLike(template: string, date: Date): string {
  if (!template.includes('T')) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  if (template.endsWith('Z')) return date.toISOString();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function durationMs(startsAt: string, endsAt: string): number {
  return asDate(endsAt).getTime() - asDate(startsAt).getTime();
}

function applyDuration(startsAt: string, originalStart: string, originalEnd: string): string {
  const ms = durationMs(originalStart, originalEnd);
  const end = new Date(asDate(startsAt).getTime() + Math.max(ms, 0));
  return formatLike(originalEnd, end);
}

function inWindow(iso: string, window: RecurrenceWindow): boolean {
  return iso >= window.from && iso <= window.to;
}

function weekdayCode(date: Date): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[date.getDay()]!;
}

function parseUntil(value: string): string {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (match) {
    const [, y, mo, d, hh, mm, ss] = match;
    return value.endsWith('Z')
      ? `${y}-${mo}-${d}T${hh}:${mm}:${ss}.000Z`
      : `${y}-${mo}-${d}T${hh}:${mm}:${ss}`;
  }
  return value;
}

function addMonths(date: Date, months: number): Date {
  const next = cloneDate(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() !== day) next.setDate(0);
  return next;
}

export function expandRecurrence(
  startsAt: string,
  endsAt: string,
  rrule: string | null | undefined,
  window: RecurrenceWindow,
): RecurrenceOccurrence[] {
  if (!rrule?.trim()) {
    if (endsAt < window.from || startsAt > window.to) return [];
    return [{ startsAt, endsAt }];
  }
  const parsed = parseRrule(rrule);
  const freq = (parsed.FREQ ?? '').toUpperCase();
  const interval = Math.max(1, Number(parsed.INTERVAL ?? 1) || 1);
  const count = parsed.COUNT ? Math.min(MAX_INSTANCES, Math.max(1, Number(parsed.COUNT) || 1)) : MAX_INSTANCES;
  const until = parsed.UNTIL ? parseUntil(parsed.UNTIL) : null;
  const byDay = parsed.BYDAY
    ? parsed.BYDAY.split(',').map((part) => part.replace(/^-?\d+/, '').toUpperCase()).filter(Boolean)
    : [];
  const byMonthDay = parsed.BYMONTHDAY
    ? parsed.BYMONTHDAY.split(',').map((part) => Number(part)).filter((n) => Number.isFinite(n) && n !== 0)
    : [];

  const origin = asDate(startsAt);
  const out: RecurrenceOccurrence[] = [];
  const seen = new Set<string>();

  const push = (date: Date) => {
    const start = formatLike(startsAt, date);
    if (until && start > until) return;
    if (start < startsAt) return;
    if (!inWindow(start, window) && start > window.to) return;
    if (seen.has(start)) return;
    seen.add(start);
    if (inWindow(start, window) || (start <= window.from && applyDuration(start, startsAt, endsAt) >= window.from)) {
      out.push({ startsAt: start, endsAt: applyDuration(start, startsAt, endsAt) });
    }
  };

  if (freq === 'WEEKLY' && byDay.length > 0) {
    const cursor = cloneDate(origin);
    cursor.setDate(cursor.getDate() - cursor.getDay());
    let weeks = 0;
    while (out.length < count && weeks < MAX_INSTANCES) {
      if (weeks % interval === 0) {
        for (let i = 0; i < 7; i += 1) {
          const day = cloneDate(cursor);
          day.setDate(cursor.getDate() + i);
          day.setHours(origin.getHours(), origin.getMinutes(), origin.getSeconds(), origin.getMilliseconds());
          if (byDay.includes(weekdayCode(day))) push(day);
          if (out.length >= count) break;
        }
      }
      cursor.setDate(cursor.getDate() + 7);
      weeks += 1;
      const stamp = formatLike(startsAt, cursor);
      if (until && stamp > until) break;
      if (stamp > window.to) break;
    }
    return out.slice(0, count);
  }

  let cursor = cloneDate(origin);
  for (let i = 0; i < MAX_INSTANCES && out.length < count; i += 1) {
    const stamp = formatLike(startsAt, cursor);
    if (until && stamp > until) break;
    if (stamp > window.to && i > 0) break;
    if (freq === 'MONTHLY' && byMonthDay.length > 0) {
      if (byMonthDay.includes(cursor.getDate()) || byMonthDay.includes(cursor.getDate() - new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate() - 1)) {
        push(cursor);
      }
    } else {
      push(cursor);
    }
    if (freq === 'DAILY') cursor.setDate(cursor.getDate() + interval);
    else if (freq === 'WEEKLY') cursor.setDate(cursor.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') cursor = addMonths(cursor, interval);
    else if (freq === 'YEARLY') cursor = addMonths(cursor, 12 * interval);
    else break;
  }
  return out.slice(0, count);
}

export function rruleFromPreset(preset: string, startsAt: string): string | null {
  const day = WEEKDAYS[asDate(startsAt).getDay()];
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY;INTERVAL=1';
    case 'weekly':
      return `FREQ=WEEKLY;INTERVAL=1;BYDAY=${day}`;
    case 'monthly':
      return `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${asDate(startsAt).getDate()}`;
    case 'yearly':
      return 'FREQ=YEARLY;INTERVAL=1';
    default:
      return null;
  }
}
