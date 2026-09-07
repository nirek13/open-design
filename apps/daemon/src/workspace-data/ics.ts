// RFC 5545 subset used to import Apple Calendar / iCloud / any .ics export.
// Unfolds lines, reads VEVENT + X-WR-CALNAME, and keeps RRULE / UID intact.

export interface ParsedIcsEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  recurrence: string | null;
  timezone: string | null;
  attendees: string | null;
}

export interface ParsedIcsCalendar {
  name: string;
  events: ParsedIcsEvent[];
}

const MAX_ICS_CHARS = 8 * 1024 * 1024;

export function unfoldIcs(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function splitIcsValue(line: string): { name: string; params: Record<string, string>; value: string } {
  const colon = line.indexOf(':');
  const head = colon < 0 ? line : line.slice(0, colon);
  const value = colon < 0 ? '' : line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: (name ?? '').toUpperCase(), params, value };
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function icsDateToIso(value: string, params: Record<string, string>): { iso: string; allDay: boolean; timezone: string | null } {
  const trimmed = value.trim();
  const tzid = params.TZID ?? null;
  const explicitDate = (params.VALUE ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(trimmed);
  if (explicitDate) {
    const y = trimmed.slice(0, 4);
    const m = trimmed.slice(4, 6);
    const d = trimmed.slice(6, 8);
    return { iso: `${y}-${m}-${d}`, allDay: true, timezone: tzid };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (!match) {
    return { iso: trimmed, allDay: false, timezone: tzid };
  }
  const [, y, mo, d, hh, mm, ss, z] = match;
  if (z) {
    return { iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss}.000Z`, allDay: false, timezone: 'UTC' };
  }
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss}`,
    allDay: false,
    timezone: tzid,
  };
}

function addDaysIso(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMsIso(iso: string, ms: number): string {
  const date = new Date(iso.includes('T') ? iso : `${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const next = new Date(date.getTime() + ms);
  if (!iso.includes('T')) {
    return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
  }
  if (iso.endsWith('Z')) return next.toISOString();
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}:${pad(next.getSeconds())}`;
}

function parseDurationMs(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function parseIcs(raw: string): ParsedIcsCalendar {
  if (raw.length > MAX_ICS_CHARS) {
    throw new Error('ICS file is too large (max 8 MB)');
  }
  const unfolded = unfoldIcs(raw);
  const lines = unfolded.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  let calendarName = 'Apple Calendar';
  const events: ParsedIcsEvent[] = [];
  let current: Record<string, { params: Record<string, string>; value: string }> | null = null;
  let attendeeParts: string[] = [];

  const flush = () => {
    if (!current) return;
    const startField = current.DTSTART;
    if (!startField) {
      current = null;
      attendeeParts = [];
      return;
    }
    const start = icsDateToIso(startField.value, startField.params);
    let endsAt = start.iso;
    let allDay = start.allDay;
    if (current.DTEND) {
      const end = icsDateToIso(current.DTEND.value, current.DTEND.params);
      endsAt = end.iso;
      allDay = allDay || end.allDay;
    } else if (current.DURATION) {
      const ms = parseDurationMs(current.DURATION.value);
      if (ms != null) {
        endsAt = allDay ? addDaysIso(start.iso, Math.max(1, Math.round(ms / 86_400_000))) : addMsIso(start.iso, ms);
      }
    } else if (allDay) {
      endsAt = addDaysIso(start.iso, 1);
    } else {
      endsAt = addMsIso(start.iso, 60 * 60 * 1000);
    }
    const uid = current.UID?.value?.trim() || `ics-${events.length}-${start.iso}`;
    const title = unescapeIcs(current.SUMMARY?.value ?? 'Untitled').trim() || 'Untitled';
    const rrule = current.RRULE?.value?.trim() || null;
    events.push({
      uid,
      title,
      description: current.DESCRIPTION ? unescapeIcs(current.DESCRIPTION.value).trim() || null : null,
      location: current.LOCATION ? unescapeIcs(current.LOCATION.value).trim() || null : null,
      startsAt: start.iso,
      endsAt,
      allDay,
      recurrence: rrule,
      timezone: start.timezone,
      attendees: attendeeParts.length > 0 ? attendeeParts.join(', ') : null,
    });
    current = null;
    attendeeParts = [];
  };

  for (const line of lines) {
    const parsed = splitIcsValue(line);
    if (parsed.name === 'BEGIN' && parsed.value.toUpperCase() === 'VEVENT') {
      current = {};
      attendeeParts = [];
      continue;
    }
    if (parsed.name === 'END' && parsed.value.toUpperCase() === 'VEVENT') {
      flush();
      continue;
    }
    if (parsed.name === 'X-WR-CALNAME' && parsed.value.trim()) {
      calendarName = unescapeIcs(parsed.value).trim();
      continue;
    }
    if (!current) continue;
    if (parsed.name === 'ATTENDEE') {
      const cn = parsed.params.CN ? unescapeIcs(parsed.params.CN) : '';
      const mail = parsed.value.replace(/^mailto:/i, '').trim();
      attendeeParts.push(cn || mail);
      continue;
    }
    current[parsed.name] = { params: parsed.params, value: parsed.value };
  }
  flush();

  return { name: calendarName, events };
}

export function normalizeCalendarFeedUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.toLowerCase().startsWith('webcal://')) {
    return `https://${trimmed.slice('webcal://'.length)}`;
  }
  return trimmed;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join('\r\n');
}

function icsUtcStamp(iso: string): string {
  const date = new Date(iso.includes('T') ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return iso.replace(/[-:]/g, '').replace(/\.\d+Z?$/, 'Z');
  }
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function icsDateValue(iso: string, allDay: boolean): { name: string; value: string } {
  if (allDay || !iso.includes('T')) {
    return { name: 'VALUE=DATE', value: iso.slice(0, 10).replace(/-/g, '') };
  }
  return { name: '', value: icsUtcStamp(iso) };
}

export interface IcsInviteInput {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  organizerName?: string | null;
  organizerEmail?: string | null;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
}

/** RFC 5545 METHOD:REQUEST so a guest can add the meeting to their calendar. */
export function serializeIcsInvite(input: IcsInviteInput): string {
  const stamp = icsUtcStamp(new Date().toISOString());
  const start = icsDateValue(input.startsAt, Boolean(input.allDay));
  const end = icsDateValue(input.endsAt, Boolean(input.allDay));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Open Design//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${stamp}`,
    start.name ? `DTSTART;${start.name}:${start.value}` : `DTSTART:${start.value}`,
    end.name ? `DTEND;${end.name}:${end.value}` : `DTEND:${end.value}`,
    `SUMMARY:${escapeIcs(input.title.trim() || 'Meeting')}`,
  ];
  if (input.description?.trim()) lines.push(`DESCRIPTION:${escapeIcs(input.description.trim())}`);
  if (input.location?.trim()) lines.push(`LOCATION:${escapeIcs(input.location.trim())}`);
  if (input.organizerEmail?.trim()) {
    const cn = input.organizerName?.trim() ? `;CN=${escapeIcs(input.organizerName.trim())}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${input.organizerEmail.trim()}`);
  }
  if (input.attendeeEmail?.trim()) {
    const cn = input.attendeeName?.trim() ? `;CN=${escapeIcs(input.attendeeName.trim())}` : '';
    lines.push(`ATTENDEE${cn};RSVP=TRUE:mailto:${input.attendeeEmail.trim()}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** Google Calendar template URL for the same event. */
export function googleCalendarTemplateUrl(input: {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
}): string {
  const dates = input.allDay || !input.startsAt.includes('T')
    ? `${input.startsAt.slice(0, 10).replace(/-/g, '')}/${input.endsAt.slice(0, 10).replace(/-/g, '')}`
    : `${icsUtcStamp(input.startsAt)}/${icsUtcStamp(input.endsAt)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title.trim() || 'Meeting',
    dates,
  });
  if (input.description?.trim()) params.set('details', input.description.trim());
  if (input.location?.trim()) params.set('location', input.location.trim());
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export async function fetchIcsFromUrl(url: string): Promise<string> {
  const href = normalizeCalendarFeedUrl(url);
  if (!/^https?:\/\//i.test(href)) {
    throw new Error('Calendar URL must be https:// or webcal://');
  }
  const response = await fetch(href, {
    headers: { accept: 'text/calendar, text/plain, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Calendar URL returned ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_ICS_CHARS) {
    throw new Error('ICS file is too large (max 8 MB)');
  }
  return text;
}
