// Organization calendar — Notion Calendar-style week/day/month/agenda,
// named calendars, and Google / Notion / Apple import.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@open-design/components';
import type { CalendarEvent, OrgCalendar, OrgMember, OrgTeam } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  connectConnector,
  createOrgCalendarEvent,
  createOrgNamedCalendar,
  deleteOrgCalendarEvent,
  fetchConnectorStatuses,
  fetchOrgCalendarEvent,
  fetchOrgCalendarEvents,
  fetchOrgMembers,
  fetchOrgTeams,
  importOrgCalendar,
  syncOrgGoogleCalendar,
  syncOrgNotionCalendar,
  updateOrgCalendarEvent,
  updateOrgNamedCalendar,
  fetchCalendarEventInvite,
} from '../../providers/registry';
import { navigate } from '../../router';
import { SendToChatPicker } from '../apps/SendToChatPicker';
import { sendEventToChat } from '../apps/sendToChat';
import {
  HOUR_START,
  HOUR_END,
  HOURS,
  SLOT_PX,
  WEEKDAYS,
  addDays,
  asError,
  dateKey,
  eventAccent,
  eventMinutes,
  eventVisibleOnBoard,
  eventsOverlap,
  formatEventTime,
  fromInputValue,
  keysForEvent,
  monthDays,
  monthStart,
  nowLineTop,
  presetToRrule,
  rrulePreset,
  shiftMonth,
  sourceLabelKey,
  toInputValue,
  weekStart,
  type CalendarViewMode,
} from './calendar-utils';
import { BookingLinksDialog } from './BookingLinksDialog';
import styles from './CalendarView.module.css';

const GOOGLE_CONNECTOR_ID = 'googlecalendar';
const NOTION_CONNECTOR_ID = 'notion';
const AUTH_POLL_MS = 2500;
const AUTH_POLL_MAX_MS = 3 * 60 * 1000;

interface Props {
  active: boolean;
  /** Deep-link target from `/calendar/:eventId`. */
  initialEventId?: string;
}

interface Draft {
  id?: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  attendees: string;
  guestUserIds: string[];
  guestTeamIds: string[];
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
}

type ImportTab = 'google' | 'notion' | 'apple';

function newDraft(day: Date, calendarId: string, hour?: number): Draft {
  const key = dateKey(day);
  const hh = String(Math.min(HOUR_END - 1, Math.max(HOUR_START, hour ?? 9))).padStart(2, '0');
  const next = String(Math.min(23, Number(hh) + 1)).padStart(2, '0');
  return {
    calendarId,
    title: '',
    description: '',
    location: '',
    attendees: '',
    guestUserIds: [],
    guestTeamIds: [],
    startsAt: `${key}T${hh}:00`,
    endsAt: `${key}T${next}:00`,
    allDay: false,
    recurrence: 'none',
  };
}

function draftFromEvent(event: CalendarEvent): Draft {
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description ?? '',
    location: event.location ?? '',
    attendees: event.attendees ?? '',
    guestUserIds: event.guestUserIds ?? [],
    guestTeamIds: event.guestTeamIds ?? [],
    startsAt: toInputValue(event.startsAt, event.allDay),
    endsAt: toInputValue(event.endsAt, event.allDay),
    allDay: event.allDay,
    recurrence: rrulePreset(event.recurrence),
  };
}

type StatusMap = Awaited<ReturnType<typeof fetchConnectorStatuses>>;

function isConnectorConnected(statuses: StatusMap | null | undefined, id: string): boolean {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
  const entry = (statuses as Record<string, { status?: string }>)[id];
  return entry?.status === 'connected';
}

async function waitForConnected(id: string, signal: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < AUTH_POLL_MAX_MS) {
    const statuses = await fetchConnectorStatuses();
    if (isConnectorConnected(statuses, id)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, AUTH_POLL_MS));
  }
  return false;
}

export function CalendarView({ active, initialEventId }: Props) {
  const t = useT();
  const org = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const { activeOrgId } = org;
  const viewerUserId = org.auth?.viewer?.userId ?? null;
  const [cursor, setCursor] = useState(() => monthStart(new Date()));
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week');
  const [query, setQuery] = useState('');
  const autoSyncedRef = useRef(false);
  const openedEventRef = useRef<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<OrgCalendar[]>([]);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [notionConnected, setNotionConnected] = useState(false);
  const [authPending, setAuthPending] = useState<'google' | 'notion' | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportTab>('google');
  const [icsText, setIcsText] = useState('');
  const [icsUrl, setIcsUrl] = useState('');
  const [icsName, setIcsName] = useState('');
  const [importing, setImporting] = useState(false);
  const [newCalendarName, setNewCalendarName] = useState('');
  const [newCalendarKind, setNewCalendarKind] = useState<'shared' | 'team'>('shared');
  const [newCalendarTeamId, setNewCalendarTeamId] = useState('');
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [overlayUserIds, setOverlayUserIds] = useState<Set<string>>(() => new Set());
  const [guestQuery, setGuestQuery] = useState('');
  const authAbortRef = useRef<AbortController | null>(null);
  const todayKey = dateKey(new Date());
  const defaultCalendarId = calendars.find((calendar) => calendar.kind === 'personal' && calendar.ownerUserId === viewerUserId)?.id
    ?? calendars.find((calendar) => calendar.source === 'local')?.id
    ?? calendars[0]?.id
    ?? '';

  const monthLabel = useMemo(() => {
    if (viewMode === 'day' || viewMode === 'agenda') {
      return selectedDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (viewMode === 'week') {
      const start = weekStart(selectedDay);
      const end = addDays(start, 6);
      return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [cursor, selectedDay, viewMode]);

  const days = useMemo(() => monthDays(cursor), [cursor]);
  const miniDays = days;
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const needle = query.trim().toLowerCase();
    for (const event of events) {
      if (!eventVisibleOnBoard(event, calendars, overlayUserIds, viewerUserId)) continue;
      if (needle && !`${event.title} ${event.location ?? ''} ${event.description ?? ''} ${event.attendees ?? ''}`.toLowerCase().includes(needle)) {
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
  }, [calendars, events, overlayUserIds, query, viewerUserId]);

  const selectedEvents = eventsByDay.get(dateKey(selectedDay)) ?? [];
  const weekDays = useMemo(() => {
    const start = weekStart(selectedDay);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDay]);

  const agendaDays = useMemo(() => {
    const start = viewMode === 'agenda' ? selectedDay : weekStart(selectedDay);
    return Array.from({ length: 14 }, (_, i) => addDays(start, i));
  }, [selectedDay, viewMode]);

  const reload = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const from = [dateKey(days[0]!), dateKey(weekStart(selectedDay))].sort()[0]!;
      const to = dateKey(addDays(days[days.length - 1]!, 1));
      const [calendar, statuses, orgMembers, orgTeams] = await Promise.all([
        fetchOrgCalendarEvents(activeOrgId, { from, to }),
        fetchConnectorStatuses().catch(() => null),
        fetchOrgMembers(activeOrgId).catch(() => [] as OrgMember[]),
        fetchOrgTeams(activeOrgId).catch(() => [] as OrgTeam[]),
      ]);
      setEvents(calendar.events);
      setCalendars(calendar.calendars ?? []);
      setMembers(orgMembers.filter((member) => member.status === 'active'));
      setTeams(orgTeams);
      setLastSyncedAt(calendar.lastSyncedAt);
      setGoogleConnected(Boolean(isConnectorConnected(statuses, GOOGLE_CONNECTOR_ID) || calendar.googleConnected));
      setNotionConnected(Boolean(isConnectorConnected(statuses, NOTION_CONNECTOR_ID) || calendar.notionConnected));
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
    if (!active || !activeOrgId || !initialEventId) return;
    if (openedEventRef.current === initialEventId) return;
    const found = events.find((event) => event.id === initialEventId);
    if (found) {
      openedEventRef.current = initialEventId;
      setDraft(draftFromEvent(found));
      setSelectedDay(new Date(found.startsAt));
      return;
    }
    let cancelled = false;
    void fetchOrgCalendarEvent(activeOrgId, initialEventId)
      .then((event) => {
        if (cancelled) return;
        openedEventRef.current = initialEventId;
        const day = new Date(event.startsAt);
        if (!Number.isNaN(day.getTime())) setSelectedDay(day);
        setDraft(draftFromEvent(event));
      })
      .catch(() => {
        // The list reload may still surface the event for the current range.
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, events, initialEventId]);

  useEffect(() => {
    autoSyncedRef.current = false;
  }, [activeOrgId]);

  useEffect(() => () => {
    authAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 't') {
        const now = new Date();
        setCursor(monthStart(now));
        setSelectedDay(now);
      } else if (event.key === 'n') {
        setDraft(newDraft(selectedDay, defaultCalendarId));
      } else if (event.key === 'ArrowLeft') {
        if (viewMode === 'month') setCursor((c) => shiftMonth(c, -1));
        else setSelectedDay((day) => addDays(day, viewMode === 'week' ? -7 : -1));
      } else if (event.key === 'ArrowRight') {
        if (viewMode === 'month') setCursor((c) => shiftMonth(c, 1));
        else setSelectedDay((day) => addDays(day, viewMode === 'week' ? 7 : 1));
      } else if (event.key === '1') setViewMode('month');
      else if (event.key === '2') setViewMode('week');
      else if (event.key === '3') setViewMode('day');
      else if (event.key === '4') setViewMode('agenda');
      else if (event.key === 'Escape') {
        setDraft(null);
        setImportOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, defaultCalendarId, selectedDay, viewMode]);

  async function connectAndWait(id: 'googlecalendar' | 'notion') {
    if (!activeOrgId || connecting || authPending) return false;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectConnector(id);
      if (result.error) {
        if (/composio|not configured|api key/i.test(result.error)) {
          setError(id === 'notion' ? t('calendar.notionComposio') : t('calendar.composioRequired'));
        } else {
          setError(result.error);
        }
        return false;
      }
      if (result.connector?.status === 'connected') {
        if (id === 'googlecalendar') setGoogleConnected(true);
        else setNotionConnected(true);
        setAuthPending(null);
        return true;
      }
      setAuthPending(id === 'googlecalendar' ? 'google' : 'notion');
      authAbortRef.current?.abort();
      const controller = new AbortController();
      authAbortRef.current = controller;
      const connected = await waitForConnected(id, controller.signal);
      if (controller.signal.aborted) return false;
      if (connected) {
        if (id === 'googlecalendar') setGoogleConnected(true);
        else setNotionConnected(true);
        setAuthPending(null);
        setError(null);
        autoSyncedRef.current = false;
        return true;
      }
      setAuthPending(null);
      setError(id === 'notion' ? t('calendar.notionTimeout') : t('calendar.connectTimeout'));
      return false;
    } catch (err) {
      setError(asError(err));
      setAuthPending(null);
      return false;
    } finally {
      setConnecting(false);
    }
  }

  async function onSyncGoogle() {
    if (!activeOrgId) return;
    if (!googleConnected) {
      const ok = await connectAndWait(GOOGLE_CONNECTOR_ID);
      if (!ok) return;
    }
    setSyncing(true);
    setError(null);
    try {
      const result = await syncOrgGoogleCalendar(activeOrgId);
      applySync(result);
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

  async function onSyncNotion() {
    if (!activeOrgId) return;
    if (!notionConnected) {
      const ok = await connectAndWait(NOTION_CONNECTOR_ID);
      if (!ok) return;
    }
    setSyncing(true);
    setError(null);
    try {
      const result = await syncOrgNotionCalendar(activeOrgId);
      applySync(result);
    } catch (err) {
      const message = asError(err);
      if (/not connected|Connect Notion/i.test(message)) {
        setNotionConnected(false);
        setError(t('calendar.connectNotionFirst'));
      } else {
        setError(message);
      }
    } finally {
      setSyncing(false);
    }
  }

  function applySync(result: { events: CalendarEvent[]; calendars?: OrgCalendar[]; lastSyncedAt: number; googleConnected?: boolean; notionConnected?: boolean }) {
    setEvents(result.events);
    if (result.calendars) setCalendars(result.calendars);
    setLastSyncedAt(result.lastSyncedAt);
    if (result.googleConnected) setGoogleConnected(true);
    if (result.notionConnected) setNotionConnected(true);
  }

  useEffect(() => {
    if (!active || !activeOrgId || !googleConnected) return;
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    void onSyncGoogle();
  }, [active, activeOrgId, googleConnected]);

  async function persistDraft() {
    if (!activeOrgId || !draft?.title.trim()) {
      throw new Error(t('calendar.send.needTitle'));
    }
    const body = {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      location: draft.location.trim() || null,
      attendees: draft.attendees.trim() || null,
      guestUserIds: draft.guestUserIds,
      guestTeamIds: draft.guestTeamIds,
      startsAt: fromInputValue(draft.startsAt, draft.allDay),
      endsAt: fromInputValue(draft.endsAt, draft.allDay),
      allDay: draft.allDay,
      calendarId: draft.calendarId || defaultCalendarId,
      recurrence: presetToRrule(draft.recurrence, fromInputValue(draft.startsAt, draft.allDay)),
      syncToGoogle: googleConnected,
    };
    const saved = draft.id
      ? await updateOrgCalendarEvent(activeOrgId, draft.id, body)
      : await createOrgCalendarEvent(activeOrgId, body);
    setDraft(draftFromEvent(saved));
    return saved;
  }

  async function onSave() {
    if (!activeOrgId || !draft?.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await persistDraft();
      setDraft(null);
      setSendOpen(false);
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
      setSendOpen(false);
      await reload();
    } catch (err) {
      setError(asError(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleCalendar(calendar: OrgCalendar) {
    if (!activeOrgId) return;
    const updated = await updateOrgNamedCalendar(activeOrgId, calendar.id, { visible: !calendar.visible });
    setCalendars((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function addCalendar() {
    if (!activeOrgId || !newCalendarName.trim()) return;
    if (newCalendarKind === 'team' && !newCalendarTeamId) return;
    const created = await createOrgNamedCalendar(activeOrgId, {
      name: newCalendarName.trim(),
      kind: newCalendarKind,
      teamId: newCalendarKind === 'team' ? newCalendarTeamId : null,
    });
    setCalendars((current) => [...current, created]);
    setNewCalendarName('');
  }

  function toggleOverlay(userId: string) {
    setOverlayUserIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleGuestUser(userId: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      guestUserIds: draft.guestUserIds.includes(userId)
        ? draft.guestUserIds.filter((id) => id !== userId)
        : [...draft.guestUserIds, userId],
    });
  }

  function toggleGuestTeam(teamId: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      guestTeamIds: draft.guestTeamIds.includes(teamId)
        ? draft.guestTeamIds.filter((id) => id !== teamId)
        : [...draft.guestTeamIds, teamId],
    });
  }

  function memberName(userId: string): string {
    return members.find((member) => member.userId === userId)?.displayName
      ?? teams.find((team) => team.id === userId)?.name
      ?? userId;
  }

  function calendarLabel(calendar: OrgCalendar): string {
    if (calendar.kind === 'personal') {
      if (calendar.ownerUserId === viewerUserId) return t('calendar.myCalendar');
      const owner = members.find((member) => member.userId === calendar.ownerUserId);
      return owner?.displayName || calendar.name;
    }
    if (calendar.kind === 'team') {
      const team = teams.find((item) => item.id === calendar.teamId);
      return team ? `${team.name}` : calendar.name;
    }
    return calendar.name;
  }

  async function onImportApple() {
    if (!activeOrgId) return;
    if (!icsText.trim() && !icsUrl.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importOrgCalendar(activeOrgId, {
        source: 'apple',
        ics: icsText.trim() || undefined,
        icsUrl: icsUrl.trim() || undefined,
        name: icsName.trim() || undefined,
      });
      applySync(result);
      setImportOpen(false);
      setIcsText('');
      setIcsUrl('');
    } catch (err) {
      setError(asError(err));
    } finally {
      setImporting(false);
    }
  }

  function onIcsFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setIcsText(String(reader.result ?? ''));
      if (!icsName) setIcsName(file.name.replace(/\.ics$/i, ''));
    };
    reader.readAsText(file);
  }

  if (!activeOrgId) {
    return (
      <div className={styles.root} data-testid="calendar-view">
        <EmptyState title={t('calendar.needOrg')} description={t('calendar.needOrgBody')} />
      </div>
    );
  }

  const statusClass = googleConnected || notionConnected
    ? styles.statusConnected
    : authPending
      ? styles.statusPending
      : styles.statusIdle;
  const statusLabel = googleConnected && notionConnected
    ? t('calendar.statusConnected')
    : googleConnected
      ? t('calendar.statusConnected')
      : notionConnected
        ? t('calendar.statusNotion')
        : authPending
          ? t('calendar.statusPending')
          : t('calendar.statusDisconnected');
  const showComposioCta = Boolean(error && /composio|api key|Integrations/i.test(error));
  const nowTop = nowLineTop();

  function chipStyle(event: CalendarEvent) {
    const color = eventAccent(event.color);
    return { background: `color-mix(in srgb, ${color} 28%, var(--bg-panel))`, borderLeft: `3px solid ${color}` };
  }

  function openDay(day: Date, hour?: number) {
    setSelectedDay(day);
    setCursor(monthStart(day));
    setDraft(newDraft(day, defaultCalendarId, hour));
  }

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
              {(['month', 'week', 'day', 'agenda'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode}
                  className={viewMode === mode ? styles.viewSwitchActive : styles.viewSwitchBtn}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'month' ? t('calendar.view.month')
                    : mode === 'week' ? t('calendar.view.week')
                      : mode === 'day' ? t('calendar.view.day')
                        : t('calendar.view.agenda')}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.actionGroup}>
            <Button variant="subtle" onClick={() => setBookingOpen(true)} data-testid="calendar-booking-links">{t('calendar.bookingLinks')}</Button>
            <Button variant="subtle" onClick={() => setImportOpen(true)}>{t('calendar.import')}</Button>
            <Button onClick={() => setDraft(newDraft(selectedDay, defaultCalendarId))}>{t('calendar.newEvent')}</Button>
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

      <div className={`${styles.layout} ${viewMode === 'agenda' ? styles.layoutAgenda : ''}`}>
        <aside className={styles.rail}>
          <div className={styles.miniGrid} aria-hidden="true">
            {WEEKDAYS.map((label) => (
              <span key={label} className={styles.miniWeekday}>{label.slice(0, 2)}</span>
            ))}
            {miniDays.map((day) => {
              const key = dateKey(day);
              const inMonth = day.getMonth() === cursor.getMonth();
              return (
                <button
                  key={key}
                  type="button"
                  className={[
                    styles.miniDay,
                    inMonth ? '' : styles.dayOutside,
                    key === dateKey(selectedDay) ? styles.miniDaySelected : '',
                    key === todayKey ? styles.miniDayToday : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => {
                    setSelectedDay(day);
                    setCursor(monthStart(day));
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <h2 className={styles.railTitle}>{t('calendar.calendars')}</h2>
          <ul className={styles.calendarList}>
            {calendars.filter((calendar) => !(calendar.kind === 'personal' && calendar.ownerUserId !== viewerUserId) && calendar.kind !== 'team').map((calendar) => (
              <li key={calendar.id}>
                <label className={styles.calendarRow}>
                  <input
                    type="checkbox"
                    checked={calendar.visible}
                    onChange={() => void toggleCalendar(calendar)}
                  />
                  <span className={styles.calendarDot} style={{ background: calendar.color }} />
                  <span className={styles.calendarName}>{calendarLabel(calendar)}</span>
                  <span className={styles.calendarSource}>{calendar.kind === 'personal' ? t('calendar.kind.personal') : calendar.source}</span>
                </label>
              </li>
            ))}
          </ul>
          <h2 className={styles.railTitle}>{t('calendar.teamCalendar')}</h2>
          {teams.length === 0 ? (
            <p className={styles.railHint}>
              {t('calendar.noTeams')}
              <button type="button" className={styles.railLink} onClick={() => navigate({ kind: 'home', view: 'organization' })}>
                {t('calendar.openOrganization')}
              </button>
            </p>
          ) : (
            <ul className={styles.calendarList}>
              {calendars.filter((calendar) => calendar.kind === 'team').map((calendar) => (
                <li key={calendar.id}>
                  <label className={styles.calendarRow}>
                    <input
                      type="checkbox"
                      checked={calendar.visible}
                      onChange={() => void toggleCalendar(calendar)}
                    />
                    <span className={styles.calendarDot} style={{ background: calendar.color }} />
                    <span className={styles.calendarName}>{calendarLabel(calendar)}</span>
                    <span className={styles.calendarSource}>{t('calendar.kind.team')}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form
            className={styles.addCalendar}
            onSubmit={(event) => {
              event.preventDefault();
              void addCalendar();
            }}
          >
            <Select
              value={newCalendarKind}
              onChange={(event) => setNewCalendarKind(event.target.value === 'team' ? 'team' : 'shared')}
              aria-label={t('calendar.newCalendarKind')}
            >
              <option value="shared">{t('calendar.kind.shared')}</option>
              <option value="team">{t('calendar.kind.team')}</option>
            </Select>
            {newCalendarKind === 'team' ? (
              <Select
                value={newCalendarTeamId}
                onChange={(event) => {
                  const teamId = event.target.value;
                  setNewCalendarTeamId(teamId);
                  const team = teams.find((item) => item.id === teamId);
                  if (team && !newCalendarName.trim()) setNewCalendarName(team.name);
                }}
                aria-label={t('calendar.pickTeam')}
              >
                <option value="">{t('calendar.pickTeam')}</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </Select>
            ) : null}
            <Input
              value={newCalendarName}
              onChange={(event) => setNewCalendarName(event.target.value)}
              placeholder={t('calendar.newCalendar')}
              aria-label={t('calendar.newCalendar')}
            />
            <Button
              type="submit"
              variant="ghost"
              disabled={!newCalendarName.trim() || (newCalendarKind === 'team' && !newCalendarTeamId)}
            >
              {t('calendar.addCalendar')}
            </Button>
          </form>
          {members.some((member) => member.userId !== viewerUserId) ? (
            <>
          <h2 className={styles.railTitle}>{t('calendar.people')}</h2>
            <ul className={styles.calendarList}>
              {members.filter((member) => member.userId !== viewerUserId).map((member) => (
                <li key={member.id}>
                  <label className={styles.calendarRow} title={t('calendar.overlayHint')}>
                    <input
                      type="checkbox"
                      checked={overlayUserIds.has(member.userId)}
                      onChange={() => toggleOverlay(member.userId)}
                      aria-label={t('calendar.overlayHint')}
                    />
                    <span className={styles.calendarDot} style={{ background: calendars.find((calendar) => calendar.kind === 'personal' && calendar.ownerUserId === member.userId)?.color || 'var(--accent)' }} />
                    <span className={styles.calendarName}>{member.displayName}</span>
                  </label>
                </li>
              ))}
            </ul>
            </>
          ) : null}
        </aside>

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
                      onDoubleClick={() => openDay(day)}
                    >
                      <span className={styles.dayNumber}>{day.getDate()}</span>
                      <span className={styles.dayEvents}>
                        {list.slice(0, 3).map((event) => (
                          <span
                            key={event.instanceId}
                            className={styles.dayEventChip}
                            style={chipStyle(event)}
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
          ) : viewMode === 'agenda' ? (
            <div className={styles.agenda}>
              {agendaDays.map((day) => {
                const list = eventsByDay.get(dateKey(day)) ?? [];
                if (list.length === 0) return null;
                return (
                  <section key={dateKey(day)} className={styles.agendaDay}>
                    <h3>{day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
                    <ul>
                      {list.map((event) => (
                        <li key={event.instanceId}>
                          <button type="button" className={styles.eventRow} onClick={() => setDraft(draftFromEvent(event))}>
                            <span className={styles.eventAccent} style={{ background: eventAccent(event.color) }} />
                            <span className={styles.eventBody}>
                              <span className={styles.eventTitle}>{event.title}</span>
                              <span className={styles.eventMeta}>{formatEventTime(event, t('calendar.allDay'))}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {agendaDays.every((day) => (eventsByDay.get(dateKey(day)) ?? []).length === 0) ? (
                <p className={styles.sidebarEmpty}>{t('calendar.agendaEmpty')}</p>
              ) : null}
            </div>
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
                          key={event.instanceId}
                          type="button"
                          className={styles.dayEventChip}
                          style={chipStyle(event)}
                          onClick={() => setDraft(draftFromEvent(event))}
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
                    <div key={hour} className={styles.weekHour} style={{ height: SLOT_PX }}>
                      {`${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? 'a' : 'p'}`}
                    </div>
                  ))}
                </div>
                {(viewMode === 'day' ? [selectedDay] : weekDays).map((day) => {
                  const key = dateKey(day);
                  const timed = (eventsByDay.get(key) ?? []).filter((event) => !event.allDay);
                  const showNow = key === todayKey && nowTop != null;
                  return (
                    <div
                      key={key}
                      className={styles.weekColumn}
                      style={{ height: HOURS.length * SLOT_PX }}
                      onDoubleClick={(ev) => {
                        const rect = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
                        const hour = HOUR_START + Math.floor((ev.clientY - rect.top) / SLOT_PX);
                        openDay(day, hour);
                      }}
                    >
                      {HOURS.map((hour) => (
                        <div key={hour} className={styles.weekSlot} style={{ height: SLOT_PX }} />
                      ))}
                      {showNow ? <div className={styles.nowLine} style={{ top: nowTop }} /> : null}
                      {timed.map((event) => {
                        const pos = eventMinutes(event);
                        return (
                          <button
                            key={event.instanceId}
                            type="button"
                            className={styles.weekEvent}
                            style={{ top: pos.top, height: pos.height, ...chipStyle(event) }}
                            onClick={() => setDraft(draftFromEvent(event))}
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

        {viewMode !== 'agenda' ? (
          <aside className={styles.sidebar}>
            <h2 className={styles.sidebarTitle}>
              {selectedDay.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })}
            </h2>
            {overlayUserIds.size > 0 ? (
              <p className={styles.sidebarEmpty}>
                {t('calendar.scheduleOf', { name: [...overlayUserIds].map(memberName).join(', ') })}
              </p>
            ) : null}
            {selectedEvents.length === 0 ? (
              <p className={styles.sidebarEmpty}>{t('calendar.noEvents')}</p>
            ) : (
              <ul className={styles.eventList}>
                {selectedEvents.map((event) => {
                  const sourceKey = sourceLabelKey(event.source);
                  return (
                    <li key={event.instanceId}>
                      <button type="button" className={styles.eventRow} onClick={() => setDraft(draftFromEvent(event))}>
                        <span className={styles.eventAccent} style={{ background: eventAccent(event.color) }} />
                        <span className={styles.eventBody}>
                          <span className={styles.eventTitle}>{event.title}</span>
                          <span className={styles.eventMeta}>
                            {formatEventTime(event, t('calendar.allDay'))}
                            {sourceKey ? ` · ${t(sourceKey)}` : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Button variant="ghost" onClick={() => setDraft(newDraft(selectedDay, defaultCalendarId))}>
              {t('calendar.addForDay')}
            </Button>
          </aside>
        ) : null}
      </div>

      {draft ? (
        <div
          className={styles.modalScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDraft(null);
              setSendOpen(false);
            }
          }}
        >
          <div
            className={sendOpen ? `${styles.modal} ${styles.modalWide}` : styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label={t('calendar.eventEditor')}
          >
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
            <label className={styles.field}>
              <span>{t('calendar.fieldCalendar')}</span>
              <Select
                value={draft.calendarId}
                onChange={(event) => setDraft({ ...draft, calendarId: event.target.value })}
              >
                {calendars.filter((calendar) => !(calendar.kind === 'personal' && calendar.ownerUserId !== viewerUserId)).map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>{calendarLabel(calendar)}</option>
                ))}
              </Select>
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
              <span>{t('calendar.recurrence')}</span>
              <Select
                value={draft.recurrence}
                onChange={(event) => setDraft({ ...draft, recurrence: event.target.value as Draft['recurrence'] })}
              >
                <option value="none">{t('calendar.recurrence.none')}</option>
                <option value="daily">{t('calendar.recurrence.daily')}</option>
                <option value="weekly">{t('calendar.recurrence.weekly')}</option>
                <option value="monthly">{t('calendar.recurrence.monthly')}</option>
                <option value="yearly">{t('calendar.recurrence.yearly')}</option>
              </Select>
            </label>
            <label className={styles.field}>
              <span>{t('calendar.location')}</span>
              <Input
                value={draft.location}
                onChange={(event) => setDraft({ ...draft, location: event.target.value })}
              />
            </label>
            <div className={styles.field}>
              <span>{t('calendar.guestPeople')}</span>
              <Input
                value={guestQuery}
                onChange={(event) => setGuestQuery(event.target.value)}
                placeholder={t('calendar.guestSearch')}
                aria-label={t('calendar.guestSearch')}
              />
              <div className={styles.guestChips}>
                {draft.guestUserIds.map((userId) => (
                  <button key={userId} type="button" className={styles.guestChip} onClick={() => toggleGuestUser(userId)}>
                    {memberName(userId)} ×
                  </button>
                ))}
                {draft.guestTeamIds.map((teamId) => (
                  <button key={teamId} type="button" className={styles.guestChip} onClick={() => toggleGuestTeam(teamId)}>
                    {teams.find((team) => team.id === teamId)?.name ?? teamId} ×
                  </button>
                ))}
              </div>
              <ul className={styles.guestPickList}>
                {members
                  .filter((member) => {
                    if (draft.guestUserIds.includes(member.userId)) return false;
                    const needle = guestQuery.trim().toLowerCase();
                    if (!needle) return true;
                    return `${member.displayName} ${member.username ?? ''} ${member.email ?? ''}`.toLowerCase().includes(needle);
                  })
                  .slice(0, 6)
                  .map((member) => (
                    <li key={member.id}>
                      <button type="button" className={styles.guestPick} onClick={() => toggleGuestUser(member.userId)}>
                        {member.displayName}
                      </button>
                    </li>
                  ))}
                {teams
                  .filter((team) => {
                    if (draft.guestTeamIds.includes(team.id)) return false;
                    const needle = guestQuery.trim().toLowerCase();
                    if (!needle) return true;
                    return `${team.name} ${team.slug}`.toLowerCase().includes(needle);
                  })
                  .slice(0, 4)
                  .map((team) => (
                    <li key={team.id}>
                      <button type="button" className={styles.guestPick} onClick={() => toggleGuestTeam(team.id)}>
                        {t('calendar.kind.team')}: {team.name}
                      </button>
                    </li>
                  ))}
              </ul>
              {(() => {
                const range = {
                  startsAt: fromInputValue(draft.startsAt, draft.allDay),
                  endsAt: fromInputValue(draft.endsAt, draft.allDay),
                };
                const guestUsers = new Set(draft.guestUserIds);
                for (const teamId of draft.guestTeamIds) {
                  const team = teams.find((item) => item.id === teamId);
                  for (const memberId of team?.memberIds ?? []) {
                    const member = members.find((item) => item.id === memberId);
                    if (member) guestUsers.add(member.userId);
                  }
                }
                const busy = events.filter((event) => (
                  event.id !== draft.id
                  && eventsOverlap(event, range)
                  && event.scheduleUserIds.some((userId) => guestUsers.has(userId))
                ));
                if (guestUsers.size === 0) return null;
                if (busy.length === 0) {
                  return <p className={styles.busyFree}>{t('calendar.freeAtTime')}</p>;
                }
                return (
                  <div className={styles.busyList}>
                    <p>{t('calendar.busyAtTime')}</p>
                    <ul>
                      {busy.slice(0, 6).map((event) => {
                        const who = event.scheduleUserIds.filter((userId) => guestUsers.has(userId)).map(memberName).join(', ');
                        return (
                          <li key={event.instanceId}>
                            {t('calendar.goingOn', { name: who || memberName(event.createdBy), title: event.title })}
                            {' · '}
                            {formatEventTime(event, t('calendar.allDay'))}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
            </div>
            <label className={styles.field}>
              <span>{t('calendar.otherGuests')}</span>
              <Input
                value={draft.attendees}
                onChange={(event) => setDraft({ ...draft, attendees: event.target.value })}
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
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(null);
                    setSendOpen(false);
                  }}
                >
                  {t('calendar.cancel')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={saving || !draft.title.trim() || !activeOrgId}
                  onClick={() => {
                    if (!draft.title.trim()) {
                      setError(t('calendar.send.needTitle'));
                      return;
                    }
                    setSendOpen((open) => !open);
                  }}
                  data-testid="calendar-send"
                >
                  {t('calendar.send')}
                </Button>
                {draft.id && activeOrgId ? (
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      void fetchCalendarEventInvite(activeOrgId, draft.id!).then((invite) => {
                        const blob = new Blob([invite.ics], { type: 'text/calendar;charset=utf-8' });
                        const href = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = href;
                        link.download = `${draft.title.trim() || 'invite'}.ics`;
                        link.click();
                        URL.revokeObjectURL(href);
                      }).catch((err) => setError(asError(err)));
                    }}
                  >
                    {t('calendar.inviteDownload')}
                  </Button>
                ) : null}
                <Button disabled={saving || !draft.title.trim()} onClick={() => void onSave()}>
                  {saving ? t('calendar.saving') : t('calendar.save')}
                </Button>
              </div>
            </div>
            {sendOpen && activeOrgId ? (
              <div className={styles.sendPanel} data-testid="calendar-send-panel">
                <SendToChatPicker
                  orgId={activeOrgId}
                  name={draft.title.trim()}
                  lead={t('calendar.send.lead')}
                  exceptHint={t('calendar.send.exceptHint')}
                  testIdPrefix="send-event"
                  onSkip={() => setSendOpen(false)}
                  onSent={() => setSendOpen(false)}
                  onSend={async (destinations, body, except) => {
                    const saved = await persistDraft();
                    const refs = await sendEventToChat(
                      activeOrgId,
                      { id: saved.id, title: saved.title },
                      destinations,
                      body,
                      except,
                    );
                    await reload();
                    return refs;
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {bookingOpen && activeOrgId ? (
        <BookingLinksDialog orgId={activeOrgId} onClose={() => setBookingOpen(false)} />
      ) : null}
      {importOpen ? (
        <Dialog onClose={() => setImportOpen(false)} closeOnEscape ariaLabel={t('calendar.importTitle')}>
          <DialogHeader>
            <DialogTitle>{t('calendar.importTitle')}</DialogTitle>
            <DialogDescription>{t('calendar.importBody')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className={styles.importTabs} role="tablist">
              {(['google', 'notion', 'apple'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={importTab === tab}
                  className={importTab === tab ? styles.viewSwitchActive : styles.viewSwitchBtn}
                  onClick={() => setImportTab(tab)}
                >
                  {tab === 'google' ? t('calendar.importGoogle') : tab === 'notion' ? t('calendar.importNotion') : t('calendar.importApple')}
                </button>
              ))}
            </div>
            {importTab === 'google' ? (
              <div className={styles.importPane}>
                <p>{t('calendar.googleHelp')}</p>
                <Button disabled={syncing || connecting} onClick={() => void onSyncGoogle()}>
                  {syncing ? t('calendar.syncing') : googleConnected ? t('calendar.syncGoogle') : t('calendar.connectGoogle')}
                </Button>
              </div>
            ) : importTab === 'notion' ? (
              <div className={styles.importPane}>
                <p>{t('calendar.notionHelp')}</p>
                <Button disabled={syncing || connecting} onClick={() => void onSyncNotion()}>
                  {syncing ? t('calendar.syncing') : notionConnected ? t('calendar.syncNotion') : t('calendar.connectNotion')}
                </Button>
              </div>
            ) : (
              <div className={styles.importPane}>
                <p>{t('calendar.appleHelp')}</p>
                <label className={styles.field}>
                  <span>{t('calendar.calendarName')}</span>
                  <Input value={icsName} onChange={(event) => setIcsName(event.target.value)} />
                </label>
                <label className={styles.field}>
                  <span>{t('calendar.icsFile')}</span>
                  <Input
                    type="file"
                    accept=".ics,text/calendar"
                    onChange={(event) => onIcsFile(event.target.files?.[0])}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('calendar.icsUrl')}</span>
                  <Input
                    value={icsUrl}
                    onChange={(event) => setIcsUrl(event.target.value)}
                    placeholder={t('calendar.icsUrlPlaceholder')}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('calendar.icsPaste')}</span>
                  <Textarea rows={6} value={icsText} onChange={(event) => setIcsText(event.target.value)} />
                </label>
                <Button disabled={importing || (!icsText.trim() && !icsUrl.trim())} onClick={() => void onImportApple()}>
                  {importing ? t('calendar.importing') : t('calendar.importApple')}
                </Button>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t('calendar.cancel')}</Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}
