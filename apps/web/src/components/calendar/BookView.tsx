// Public Calendly-style booking page. Guests land here from a share link
// and pick a free slot without signing in.

import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from '@open-design/components';
import type { CalendarBookingSlot, CreatedPublicBooking, PublicBookingPage } from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  createPublicBooking,
  fetchPublicBookingPage,
  fetchPublicBookingSlots,
} from '../../providers/registry';
import { navigate } from '../../router';
import {
  addDays,
  asError,
  dateKey,
  monthDays,
  monthStart,
  shiftMonth,
} from './calendar-utils';
import styles from './BookView.module.css';

function downloadIcs(ics: string, filename: string) {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function slotLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

export function BookView({ token }: { token: string }) {
  const t = useT();
  const [page, setPage] = useState<PublicBookingPage | null>(null);
  const [slots, setSlots] = useState<CalendarBookingSlot[]>([]);
  const [cursor, setCursor] = useState(() => monthStart(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => dateKey(new Date()));
  const [selectedSlot, setSelectedSlot] = useState<CalendarBookingSlot | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'booking' | 'done' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<CreatedPublicBooking | null>(null);

  const days = useMemo(() => monthDays(cursor), [cursor]);
  const todayKey = dateKey(new Date());
  const timeZone = page?.availability.timezone ?? undefined;

  const slotsByDay = useMemo(() => {
    const map = new Map<string, CalendarBookingSlot[]>();
    for (const slot of slots) {
      const key = dateKey(new Date(slot.startsAt));
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return map;
  }, [slots]);

  useEffect(() => {
    if (slotsByDay.size === 0) return;
    if (slotsByDay.has(selectedDay)) return;
    const first = [...slotsByDay.keys()].sort()[0];
    if (first) setSelectedDay(first);
  }, [selectedDay, slotsByDay]);

  const daySlots = slotsByDay.get(selectedDay) ?? [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchPublicBookingPage(token);
        if (cancelled) return;
        setPage(next);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setError(asError(err));
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    const from = dateKey(days[0]!);
    const to = dateKey(addDays(days[days.length - 1]!, 1));
    void fetchPublicBookingSlots(token, { from, to })
      .then((result) => {
        if (!cancelled) setSlots(result.slots);
      })
      .catch((err) => {
        if (!cancelled) setError(asError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [days, page, token]);

  async function onConfirm() {
    if (!selectedSlot || !name.trim() || !email.trim()) return;
    setPhase('booking');
    setError(null);
    try {
      const result = await createPublicBooking(token, {
        name: name.trim(),
        email: email.trim(),
        startsAt: selectedSlot.startsAt,
      });
      setConfirmed(result);
      setPhase('done');
    } catch (err) {
      setError(asError(err));
      setPhase('ready');
    }
  }

  return (
    <div className={styles.root} data-testid="book-view">
      <div className={styles.card}>
        {phase === 'loading' ? <p className={styles.muted}>{t('book.loading')}</p> : null}

        {phase === 'failed' ? (
          <>
            <h1 className={styles.title}>{t('book.invalid')}</h1>
            <p className={styles.body}>{error ?? t('book.invalidBody')}</p>
            <Button onClick={() => navigate({ kind: 'home', view: 'workspace' })}>{t('book.goHome')}</Button>
          </>
        ) : null}

        {phase === 'done' && confirmed ? (
          <>
            <p className={styles.eyebrow}>{t('book.confirmed')}</p>
            <h1 className={styles.title}>{confirmed.title}</h1>
            <p className={styles.body}>
              {new Date(confirmed.startsAt).toLocaleString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZone,
              })}
              {confirmed.hostName ? ` · ${t('book.with', { name: confirmed.hostName })}` : ''}
            </p>
            <div className={styles.actions}>
              <Button onClick={() => downloadIcs(confirmed.ics, `${confirmed.title}.ics`)}>
                {t('book.downloadIcs')}
              </Button>
              <Button variant="subtle" onClick={() => window.open(confirmed.googleUrl, '_blank', 'noopener')}>
                {t('book.googleCalendar')}
              </Button>
            </div>
          </>
        ) : null}

        {(phase === 'ready' || phase === 'booking') && page ? (
          <div className={styles.layout}>
            <aside className={styles.meta}>
              <p className={styles.eyebrow}>{t('book.with', { name: page.hostName })}</p>
              <h1 className={styles.title}>{page.title}</h1>
              <p className={styles.body}>{t('book.minutes', { count: String(page.durationMinutes) })}</p>
              {page.location ? <p className={styles.body}>{page.location}</p> : null}
              {page.description ? <p className={styles.body}>{page.description}</p> : null}
            </aside>
            <div className={styles.picker}>
              <div className={styles.monthNav}>
                <Button variant="ghost" aria-label={t('book.prev')} onClick={() => setCursor((c) => shiftMonth(c, -1))}>‹</Button>
                <span>{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
                <Button variant="ghost" aria-label={t('book.next')} onClick={() => setCursor((c) => shiftMonth(c, 1))}>›</Button>
              </div>
              <div className={styles.grid} role="grid" aria-label={t('book.pickDay')}>
                {days.map((day) => {
                  const key = dateKey(day);
                  const inMonth = day.getMonth() === cursor.getMonth();
                  const hasSlots = (slotsByDay.get(key) ?? []).length > 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!hasSlots}
                      className={[
                        styles.day,
                        inMonth ? '' : styles.dayOutside,
                        key === selectedDay ? styles.daySelected : '',
                        key === todayKey ? styles.dayToday : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => {
                        setSelectedDay(key);
                        setSelectedSlot(null);
                      }}
                    >
                      {day.getDate()}
                    </button>
                  );
                })}
              </div>
              <div className={styles.slots} aria-label={t('book.pickTime')}>
                {daySlots.length === 0 ? <p className={styles.muted}>{t('book.noSlots')}</p> : null}
                {daySlots.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    className={selectedSlot?.startsAt === slot.startsAt ? styles.slotActive : styles.slot}
                    onClick={() => setSelectedSlot(slot)}
                  >
                    {slotLabel(slot.startsAt, page.availability.timezone)}
                  </button>
                ))}
              </div>
              {selectedSlot ? (
                <form
                  className={styles.form}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onConfirm();
                  }}
                >
                  <label className={styles.field}>
                    <span>{t('book.name')}</span>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      aria-label={t('book.name')}
                      required
                    />
                  </label>
                  <label className={styles.field}>
                    <span>{t('book.email')}</span>
                    <Input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      aria-label={t('book.email')}
                      required
                    />
                  </label>
                  {error ? <p className={styles.error}>{error}</p> : null}
                  <Button type="submit" disabled={phase === 'booking' || !name.trim() || !email.trim()}>
                    {phase === 'booking' ? t('book.confirming') : t('book.confirm')}
                  </Button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
