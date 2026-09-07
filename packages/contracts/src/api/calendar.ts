/** Organization calendar — named calendars, local events, and Google / Notion / Apple import. */

export const CALENDAR_SOURCES = ['local', 'google', 'notion', 'apple'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const CALENDAR_KINDS = ['shared', 'team', 'personal'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export const CALENDAR_COLOR_PALETTE = [
  '#5b6cff',
  '#e16259',
  '#e9a23b',
  '#4f9d69',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#0f766e',
] as const;

export interface OrgCalendar {
  id: string;
  orgId: string;
  name: string;
  color: string;
  source: CalendarSource;
  /** Shared with the org, owned by a team, or one person's calendar. */
  kind: CalendarKind;
  /** Set when kind is personal — the directory user who owns this calendar. */
  ownerUserId: string | null;
  /** Set when kind is team — the org team this calendar belongs to. */
  teamId: string | null;
  visible: boolean;
  externalId: string | null;
  icsUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEvent {
  id: string;
  orgId: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 start instant (or date-only `YYYY-MM-DD` when allDay). */
  startsAt: string;
  /** ISO-8601 end instant (or date-only `YYYY-MM-DD` when allDay). */
  endsAt: string;
  allDay: boolean;
  color: string;
  /** RFC 5545 RRULE body, without the `RRULE:` prefix. */
  recurrence: string | null;
  timezone: string | null;
  /** Comma-separated attendee emails or names (ICS import / extra guests). */
  attendees: string | null;
  /** Organization members invited as individuals (directory user ids). */
  guestUserIds: string[];
  /** Organization teams invited as a group. */
  guestTeamIds: string[];
  /**
   * Directory user ids this event appears on — creator, personal-calendar owner,
   * individual guests, and members of invited / owning teams.
   */
  scheduleUserIds: string[];
  /** Google Calendar event id when this row was synced or pushed. */
  googleEventId: string | null;
  /** Stable id from the import source (ICS UID, Notion page id, Google event id). */
  externalUid: string | null;
  source: CalendarSource;
  /** Distinct per recurring instance; equals `id` for non-recurring rows. */
  instanceId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
  calendars: OrgCalendar[];
  googleConnected: boolean;
  notionConnected: boolean;
  lastSyncedAt: number | null;
}

export interface UpsertCalendarEventRequest {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  calendarId?: string | null;
  color?: string | null;
  recurrence?: string | null;
  timezone?: string | null;
  attendees?: string | null;
  guestUserIds?: string[];
  guestTeamIds?: string[];
  /** When true and Google is connected, also create/update on Google Calendar. */
  syncToGoogle?: boolean;
}

export interface UpsertOrgCalendarRequest {
  name: string;
  color?: string | null;
  visible?: boolean;
  kind?: CalendarKind;
  /** Required when kind is team. */
  teamId?: string | null;
}

export interface PatchOrgCalendarRequest {
  name?: string;
  color?: string | null;
  visible?: boolean;
}

export interface ImportCalendarRequest {
  source: 'google' | 'notion' | 'apple';
  /** Raw iCalendar text (Apple Calendar / any .ics export). */
  ics?: string;
  /** Public webcal/https URL published from Apple Calendar or iCloud. */
  icsUrl?: string;
  name?: string;
  color?: string;
  /** Optional Notion database id; otherwise every dated database is imported. */
  databaseId?: string;
}

export interface CalendarSyncResponse {
  imported: number;
  calendarId?: string;
  events: CalendarEvent[];
  calendars: OrgCalendar[];
  lastSyncedAt: number;
}

export const BOOKING_DURATIONS = [15, 30, 45, 60] as const;
export type BookingDurationMinutes = (typeof BOOKING_DURATIONS)[number];

/** Weekly hours a booking link offers. Weekdays are 0 (Sunday) through 6. */
export interface BookingAvailability {
  timezone: string;
  weekdays: number[];
  /** Wall-clock `HH:MM` in `timezone`. */
  startTime: string;
  /** Wall-clock `HH:MM` in `timezone`. */
  endTime: string;
}

export interface CalendarBookingType {
  id: string;
  orgId: string;
  ownerUserId: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number;
  availability: BookingAvailability;
  /** Public booking URL. Present after create so the host can copy it again. */
  url: string;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertCalendarBookingTypeRequest {
  title: string;
  description?: string | null;
  location?: string | null;
  durationMinutes?: number;
  calendarId?: string | null;
  timezone?: string | null;
  weekdays?: number[];
  startTime?: string | null;
  endTime?: string | null;
}

export interface CalendarBookingTypesResponse {
  bookingTypes: CalendarBookingType[];
}

export interface CreatedCalendarBookingType {
  bookingType: CalendarBookingType;
  /** Raw token, returned once at creation. Prefer `bookingType.url`. */
  token: string;
}

export interface CalendarBookingSlot {
  startsAt: string;
  endsAt: string;
}

export interface PublicBookingPage {
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number;
  hostName: string;
  availability: BookingAvailability;
}

export interface PublicBookingSlotsResponse {
  slots: CalendarBookingSlot[];
}

export interface CreatePublicBookingRequest {
  name: string;
  email: string;
  startsAt: string;
}

export interface CreatedPublicBooking {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  hostName: string;
  /** RFC 5545 METHOD:REQUEST invite for the guest. */
  ics: string;
  /** Google Calendar "Add to calendar" template URL. */
  googleUrl: string;
}

export interface CalendarInviteResponse {
  ics: string;
  googleUrl: string;
}
