/** Calendar events for an organization, optionally synced with Google Calendar. */

export interface CalendarEvent {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 start instant (or date-only `YYYY-MM-DD` when allDay). */
  startsAt: string;
  /** ISO-8601 end instant (or date-only `YYYY-MM-DD` when allDay). */
  endsAt: string;
  allDay: boolean;
  /** Google Calendar event id when this row was synced or pushed. */
  googleEventId: string | null;
  source: 'local' | 'google';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
  googleConnected: boolean;
  lastSyncedAt: number | null;
}

export interface UpsertCalendarEventRequest {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  /** When true and Google is connected, also create/update on Google Calendar. */
  syncToGoogle?: boolean;
}

export interface CalendarSyncResponse {
  imported: number;
  events: CalendarEvent[];
  lastSyncedAt: number;
}
