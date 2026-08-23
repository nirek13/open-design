// Organization calendar — month grid, event CRUD, Google Calendar sync.
//
// Google auth uses the same Composio connector path as Integrations
// (`connectConnector('googlecalendar')`). Status comes from
// `/api/connectors/status` (a map, not an array). We never mark the
// connector connected until that map says so, and we surface a clear
// recovery path when Composio is not configured.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { CalendarEvent } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  connectConnector,
  createOrgCalendarEvent,
  deleteOrgCalendarEvent,
  fetchConnectorStatuses,
  fetchOrgCalendarEvents,
  syncOrgGoogleCalendar,
  updateOrgCalendarEvent,
} from '../../providers/registry';
import { navigate } from '../../router';
import styles from './CalendarView.module.css';

const GOOGLE_CONNECTOR_ID = 'googlecalendar';
const AUTH_POLL_MS = 2500;
const AUTH_POLL_MAX_MS = 3 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface Props {
  active: boolean;
}

interface Draft {
  id?: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}


function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function dateKey(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toInputValue(iso: string, allDay: boolean): string {
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

function fromInputValue(value: string, allDay: boolean): string {
  if (allDay) return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function newDraft(day: Date): Draft {
  const key = dateKey(day);
  return {
    title: '',
    description: '',
    location: '',
    startsAt: `${key}T09:00`,
    endsAt: `${key}T10:00`,
    allDay: false,
  };
}

const HOUR_START = 6;
const HOUR_END = 22;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => i + HOUR_START);

type CalendarViewMode = 'month' | 'week' | 'day';

function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

function weekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function keysForEvent(event: CalendarEvent): string[] {
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

function eventMinutes(event: CalendarEvent): { top: number; height: number } {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const origin = HOUR_START * 60;
  const top = Math.max(0, startMin - origin);
  const height = Math.max(18, (endMin || startMin + 30) - Math.max(startMin, origin));
  return { top: (top / 60) * 52, height: (height / 60) * 52 };
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type StatusMap = Awaited<ReturnType<typeof fetchConnectorStatuses>>;

function isGoogleConnected(statuses: StatusMap | null | undefined): boolean {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
  const entry = (statuses as Record<string, { status?: string }>)[GOOGLE_CONNECTOR_ID];
  return entry?.status === 'connected';
}

async function waitForGoogleConnected(signal: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < AUTH_POLL_MAX_MS) {
    const statuses = await fetchConnectorStatuses();
    if (isGoogleConnected(statuses)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, AUTH_POLL_MS));
  }
  return false;
}


function formatEventTime(event: CalendarEvent, allDayLabel: string): string {
  if (event.allDay) return allDayLabel;
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${new Date(event.startsAt).toLocaleTimeString([], opts)} – ${new Date(event.endsAt).toLocaleTimeString([], opts)}`;
}

export function CalendarView({ active }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [cursor, setCursor] = useState(() => monthStart(new Date()));
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week');
  const [query, setQuery] = useState('');
  const autoSyncedRef = useRef(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const authAbortRef = useRef<AbortController | null>(null);
  const todayKey = dateKey(new Date());

  const monthLabel = useMemo(() => {
    if (viewMode === 'day') {
      return selectedDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (viewMode === 'week') {
      const start = weekStart(selectedDay);
      const end = addDays(start, 6);
      return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [cursor, selectedDay, viewMode]);

  const days = useMemo(() => {
    const first = monthStart(cursor);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }, [cursor]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const needle = query.trim().toLowerCase();
    for (const event of events) {
      if (needle && !`${event.title} ${event.location ?? ''} ${event.description ?? ''}`.toLowerCase().includes(needle)) {
        continue;
      }
      for (const key of keysForEvent(event)) {
        const list = map.get(key) ?? [];
        list.push(event);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }
    return map;
  }, [events, query]);

  const selectedEvents = eventsByDay.get(dateKey(selectedDay)) ?? [];
  const weekDays = useMemo(() => {
    const start = weekStart(selectedDay);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDay]);

  const reload = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const from = [dateKey(days[0]!), dateKey(weekStart(selectedDay))].sort()[0]!;
      const to = dateKey(addDays(days[days.length - 1]!, 1));
      const [calendar, statuses] = await Promise.all([
        fetchOrgCalendarEvents(activeOrgId, { from, to }),
        fetchConnectorStatuses().catch(() => null),
      ]);
      setEvents(calendar.events);
      setLastSyncedAt(calendar.lastSyncedAt);
      setGoogleConnected(Boolean(isGoogleConnected(statuses) || calendar.googleConnected));
    } catch (err) {
      setError(asError(err));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, days, selectedDay]);

  useEffect(() => {
    if (!active) return;
    void reload();
  }, [active, reload]);

  useEffect(() => {
    autoSyncedRef.current = false;
  }, [activeOrgId]);

  useEffect(() => () => {
    authAbortRef.current?.abort();
  }, []);

  async function onConnectGoogle() {
    if (!activeOrgId || connecting || authPending) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectConnector(GOOGLE_CONNECTOR_ID);
      if (result.error) {
        if (/composio|not configured|api key/i.test(result.error)) {
          setError(t('calendar.composioRequired'));
        } else {
          setError(result.error);
        }
        return;
      }
      if (result.connector?.status === 'connected') {
        setGoogleConnected(true);
        setAuthPending(false);
        return;
      }

      setAuthPending(true);
      authAbortRef.current?.abort();
      const controller = new AbortController();
      authAbortRef.current = controller;
      const connected = await waitForGoogleConnected(controller.signal);
      if (controller.signal.aborted) return;
      if (connected) {
        setGoogleConnected(true);
        setAuthPending(false);
        setError(null);
        autoSyncedRef.current = false;
      } else {
        setAuthPending(false);
        setError(t('calendar.connectTimeout'));
      }
    } catch (err) {
      setError(asError(err));
      setAuthPending(false);
    } finally {
      setConnecting(false);
    }
  }

  async function onSyncGoogle() {
    if (!activeOrgId) return;
    if (!googleConnected) {
      await onConnectGoogle();
      const statuses = await fetchConnectorStatuses().catch(() => null);
      if (!isGoogleConnected(statuses)) return;
      setGoogleConnected(true);
    }
    setSyncing(true);
    setError(null);
    try {
      const result = await syncOrgGoogleCalendar(activeOrgId);
      setEvents(result.events);
      setLastSyncedAt(result.lastSyncedAt);
      setGoogleConnected(true);
    } catch (err) {
      const message = asError(err);
      if (/not connected|Connect Google/i.test(message)) {
        setGoogleConnected(false);
        setError(t('calendar.connectFirst'));
      } else {
        setError(message);
      }
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (!active || !activeOrgId || !googleConnected) return;
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    void onSyncGoogle();
  }, [active, activeOrgId, googleConnected]);

  async function onSave() {
    if (!activeOrgId || !draft?.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        location: draft.location.trim() || null,
        startsAt: fromInputValue(draft.startsAt, draft.allDay),
        endsAt: fromInputValue(draft.endsAt, draft.allDay),
        allDay: draft.allDay,
        syncToGoogle: googleConnected,
      };
      if (draft.id) await updateOrgCalendarEvent(activeOrgId, draft.id, body);
      else await createOrgCalendarEvent(activeOrgId, body);
      setDraft(null);
      await reload();
    } catch (err) {
      setError(asError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(eventId: string) {
    if (!activeOrgId) return;
    setSaving(true);
    try {
      await deleteOrgCalendarEvent(activeOrgId, eventId);
      setDraft(null);
      await reload();
    } catch (err) {
      setError(asError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!activeOrgId) {
    return (
      <div className={styles.root} data-testid="calendar-view">
        <EmptyState title={t('calendar.needOrg')} description={t('calendar.needOrgBody')} />
      </div>
    );
  }

  const statusClass = googleConnected
    ? styles.statusConnected
    : authPending
      ? styles.statusPending
      : styles.statusIdle;
  const statusLabel = googleConnected
    ? t('calendar.statusConnected')
    : authPending
      ? t('calendar.statusPending')
      : t('calendar.statusDisconnected');
  const showComposioCta = Boolean(error && /composio|api key|Integrations/i.test(error));

  return (
    <div className={styles.root} data-testid="calendar-view">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t('calendar.title')}</h1>
            <span className={`${styles.statusPill} ${statusClass}`}>{statusLabel}</span>
          </div>
          <p className={styles.subtitle}>{t('calendar.subtitle')}</p>
          <Input
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('calendar.searchPlaceholder')}
            aria-label={t('calendar.searchPlaceholder')}
          />
        </div>
        <div className={styles.headerActions}>
          <div className={styles.navGroup}>
            <Button
              variant="ghost"
              onClick={() => {
                if (viewMode === 'month') setCursor((c) => shiftMonth(c, -1));
                else setSelectedDay((day) => addDays(day, viewMode === 'week' ? -7 : -1));
              }}
              aria-label={t('calendar.prev')}
            >
              ‹
            </Button>
            <span className={styles.monthLabel}>{monthLabel}</span>
            <Button
              variant="ghost"
              onClick={() => {
                if (viewMode === 'month') setCursor((c) => shiftMonth(c, 1));
                else setSelectedDay((day) => addDays(day, viewMode === 'week' ? 7 : 1));
              }}
              aria-label={t('calendar.next')}
            >
              ›
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const now = new Date();
                setCursor(monthStart(now));
                setSelectedDay(now);
              }}
            >
              {t('calendar.today')}
            </Button>
            <div className={styles.viewSwitch} role="tablist" aria-label={t('calendar.views')}>
              {(['month', 'week', 'day'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode}
                  className={viewMode === mode ? styles.viewSwitchActive : styles.viewSwitchBtn}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'month' ? t('calendar.view.month') : mode === 'week' ? t('calendar.view.week') : t('calendar.view.day')}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.actionGroup}>
            <Button onClick={() => setDraft(newDraft(selectedDay))}>{t('calendar.newEvent')}</Button>
            {googleConnected ? (
              <Button variant="subtle" disabled={syncing} onClick={() => void onSyncGoogle()}>
                {syncing ? t('calendar.syncing') : t('calendar.syncGoogle')}
              </Button>
            ) : (
              <Button
                variant="subtle"
                disabled={connecting || authPending}
                onClick={() => void onConnectGoogle()}
              >
                {connecting || authPending ? t('calendar.connecting') : t('calendar.connectGoogle')}
              </Button>
            )}
          </div>
        </div>
      </header>

      {lastSyncedAt ? (
        <p className={styles.syncMeta}>
          {t('calendar.lastSynced', { when: new Date(lastSyncedAt).toLocaleString() })}
        </p>
      ) : null}

      {error ? (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          {showComposioCta ? (
            <Button variant="ghost" onClick={() => navigate({ kind: 'home', view: 'integrations' })}>
              {t('calendar.openIntegrations')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.layout}>
        <section className={viewMode === 'month' ? styles.grid : styles.weekWrap} aria-label={monthLabel}>
          {viewMode === 'month' ? (
            <>
          {WEEKDAYS.map((label) => (
            <div key={label} className={styles.weekday}>{label}</div>
          ))}
          {loading && events.length === 0
            ? Array.from({ length: 14 }, (_, i) => <Skeleton key={i} className={styles.daySkeleton} />)
            : days.map((day) => {
              const key = dateKey(day);
              const inMonth = day.getMonth() === cursor.getMonth();
              const selected = key === dateKey(selectedDay);
              const isToday = key === todayKey;
              const list = eventsByDay.get(key) ?? [];
              return (
                <button
                  key={key}
                  type="button"
                  className={[
                    styles.day,
                    inMonth ? '' : styles.dayOutside,
                    selected ? styles.daySelected : '',
                    isToday ? styles.dayToday : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => setSelectedDay(day)}
                  onDoubleClick={() => setDraft(newDraft(day))}
                >
                  <span className={styles.dayNumber}>{day.getDate()}</span>
                  <span className={styles.dayEvents}>
                    {list.slice(0, 3).map((event) => (
                      <span
                        key={event.id}
                        className={`${styles.dayEventChip} ${event.source === 'google' ? styles.dayEventGoogle : ''}`}
                        title={event.title}
                      >
                        {event.allDay ? event.title : `${new Date(event.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${event.title}`}
                      </span>
                    ))}
                    {list.length > 3 ? <span className={styles.dayMore}>+{list.length - 3}</span> : null}
                  </span>
                </button>
              );
            })}
            </>
          ) : (
            <div className={styles.weekBoard}>
              <div className={styles.weekHead} style={{ gridTemplateColumns: viewMode === 'day' ? '56px 1fr' : '56px repeat(7, minmax(0, 1fr))' }}>
                <span />
                {(viewMode === 'day' ? [selectedDay] : weekDays).map((day) => {
                  const key = dateKey(day);
                  const isToday = key === todayKey;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.weekHeadDay} ${isToday ? styles.dayToday : ''} ${key === dateKey(selectedDay) ? styles.daySelected : ''}`}
                      onClick={() => setSelectedDay(day)}
                    >
                      <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                      <strong>{day.getDate()}</strong>
                    </button>
                  );
                })}
              </div>
              <div className={styles.weekAllDay} style={{ gridTemplateColumns: viewMode === 'day' ? '56px 1fr' : '56px repeat(7, minmax(0, 1fr))' }}>
                <span className={styles.weekHourLabel}>{t('calendar.allDay')}</span>
                {(viewMode === 'day' ? [selectedDay] : weekDays).map((day) => {
                  const list = (eventsByDay.get(dateKey(day)) ?? []).filter((event) => event.allDay);
                  return (
                    <div key={dateKey(day)} className={styles.weekAllDayCell}>
                      {list.map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          className={`${styles.dayEventChip} ${event.source === 'google' ? styles.dayEventGoogle : ''}`}
                          onClick={() => setDraft({
                            id: event.id,
                            title: event.title,
                            description: event.description ?? '',
                            location: event.location ?? '',
                            startsAt: toInputValue(event.startsAt, event.allDay),
                            endsAt: toInputValue(event.endsAt, event.allDay),
                            allDay: event.allDay,
                          })}
                        >
                          {event.title}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div
                className={styles.weekBody}
                style={{ gridTemplateColumns: viewMode === 'day' ? '56px 1fr' : '56px repeat(7, minmax(0, 1fr))' }}
              >
                <div className={styles.weekHours}>
                  {HOURS.map((hour) => (
                    <div key={hour} className={styles.weekHour} style={{ height: 52 }}>
                      {`${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? 'a' : 'p'}`}
                    </div>
                  ))}
                </div>
                {(viewMode === 'day' ? [selectedDay] : weekDays).map((day) => {
                  const key = dateKey(day);
                  const timed = (eventsByDay.get(key) ?? []).filter((event) => !event.allDay);
                  return (
                    <div
                      key={key}
                      className={styles.weekColumn}
                      style={{ height: HOURS.length * 52 }}
                      onDoubleClick={(ev) => {
                        const rect = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
                        const y = ev.clientY - rect.top;
                        const hour = HOUR_START + Math.floor(y / 52);
                        const draftDay = newDraft(day);
                        const hh = String(Math.min(HOUR_END - 1, Math.max(HOUR_START, hour))).padStart(2, '0');
                        setDraft({
                          ...draftDay,
                          startsAt: `${key}T${hh}:00`,
                          endsAt: `${key}T${String(Math.min(23, Number(hh) + 1)).padStart(2, '0')}:00`,
                        });
                      }}
                    >
                      {HOURS.map((hour) => (
                        <div key={hour} className={styles.weekSlot} style={{ height: 52 }} />
                      ))}
                      {timed.map((event) => {
                        const pos = eventMinutes(event);
                        return (
                          <button
                            key={event.id}
                            type="button"
                            className={`${styles.weekEvent} ${event.source === 'google' ? styles.weekEventGoogle : ''}`}
                            style={{ top: pos.top, height: pos.height }}
                            onClick={() => setDraft({
                              id: event.id,
                              title: event.title,
                              description: event.description ?? '',
                              location: event.location ?? '',
                              startsAt: toInputValue(event.startsAt, event.allDay),
                              endsAt: toInputValue(event.endsAt, event.allDay),
                              allDay: event.allDay,
                            })}
                          >
                            <strong>{event.title}</strong>
                            <span>{formatEventTime(event, t('calendar.allDay'))}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <aside className={styles.sidebar}>
          <h2 className={styles.sidebarTitle}>
            {selectedDay.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </h2>
          {selectedEvents.length === 0 ? (
            <p className={styles.sidebarEmpty}>{t('calendar.noEvents')}</p>
          ) : (
            <ul className={styles.eventList}>
              {selectedEvents.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    className={styles.eventRow}
                    onClick={() => setDraft({
                      id: event.id,
                      title: event.title,
                      description: event.description ?? '',
                      location: event.location ?? '',
                      startsAt: toInputValue(event.startsAt, event.allDay),
                      endsAt: toInputValue(event.endsAt, event.allDay),
                      allDay: event.allDay,
                    })}
                  >
                    <span className={`${styles.eventAccent} ${event.source === 'google' ? styles.eventAccentGoogle : ''}`} />
                    <span className={styles.eventBody}>
                      <span className={styles.eventTitle}>{event.title}</span>
                      <span className={styles.eventMeta}>
                        {formatEventTime(event, t('calendar.allDay'))}
                        {event.source === 'google' ? ` · ${t('calendar.fromGoogle')}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="ghost" onClick={() => setDraft(newDraft(selectedDay))}>
            {t('calendar.addForDay')}
          </Button>
        </aside>
      </div>

      {draft ? (
        <div
          className={styles.modalScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setDraft(null);
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('calendar.eventEditor')}>
            <h3 className={styles.modalTitle}>
              {draft.id ? t('calendar.editEvent') : t('calendar.newEvent')}
            </h3>
            <label className={styles.field}>
              <span>{t('calendar.fieldTitle')}</span>
              <Input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                autoFocus
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })}
              />
              {t('calendar.allDay')}
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>{t('calendar.starts')}</span>
                <Input
                  type={draft.allDay ? 'date' : 'datetime-local'}
                  value={draft.startsAt}
                  onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>{t('calendar.ends')}</span>
                <Input
                  type={draft.allDay ? 'date' : 'datetime-local'}
                  value={draft.endsAt}
                  onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
                />
              </label>
            </div>
            <label className={styles.field}>
              <span>{t('calendar.location')}</span>
              <Input
                value={draft.location}
                onChange={(event) => setDraft({ ...draft, location: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>{t('calendar.description')}</span>
              <textarea
                className={styles.textarea}
                rows={4}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className={styles.modalActions}>
              {draft.id ? (
                <Button variant="ghost" disabled={saving} onClick={() => void onDelete(draft.id!)}>
                  {t('calendar.delete')}
                </Button>
              ) : <span />}
              <div className={styles.modalActionsRight}>
                <Button variant="ghost" onClick={() => setDraft(null)}>{t('calendar.cancel')}</Button>
                <Button disabled={saving || !draft.title.trim()} onClick={() => void onSave()}>
                  {saving ? t('calendar.saving') : t('calendar.save')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
