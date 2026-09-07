import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
} from '@open-design/components';
import type { CalendarBookingType } from '@open-design/contracts';
import { BOOKING_DURATIONS } from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  createOrgBookingType,
  fetchOrgBookingTypes,
  revokeOrgBookingType,
} from '../../providers/registry';
import { asError } from './calendar-utils';
import styles from './CalendarView.module.css';

const WEEKDAYS = [
  { id: 0, label: 'S' },
  { id: 1, label: 'M' },
  { id: 2, label: 'T' },
  { id: 3, label: 'W' },
  { id: 4, label: 'T' },
  { id: 5, label: 'F' },
  { id: 6, label: 'S' },
];

interface Props {
  orgId: string;
  onClose: () => void;
}

export function BookingLinksDialog({ orgId, onClose }: Props) {
  const t = useT();
  const [types, setTypes] = useState<CalendarBookingType[]>([]);
  const [title, setTitle] = useState('30 min meeting');
  const [duration, setDuration] = useState(30);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const result = await fetchOrgBookingTypes(orgId);
    setTypes(result.bookingTypes);
  }

  useEffect(() => {
    void reload().catch((err) => setError(asError(err)));
  }, [orgId]);

  async function onCreate() {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createOrgBookingType(orgId, {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        durationMinutes: duration,
        startTime,
        endTime,
        weekdays,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await navigator.clipboard.writeText(created.bookingType.url).catch(() => {});
      setCopiedId(created.bookingType.id);
      await reload();
    } catch (err) {
      setError(asError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onCopy(type: CalendarBookingType) {
    await navigator.clipboard.writeText(type.url);
    setCopiedId(type.id);
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokeOrgBookingType(orgId, id);
      await reload();
    } catch (err) {
      setError(asError(err));
    }
  }

  function toggleDay(id: number) {
    setWeekdays((current) => (
      current.includes(id) ? current.filter((day) => day !== id) : [...current, id].sort()
    ));
  }

  return (
    <Dialog onClose={onClose} closeOnEscape ariaLabel={t('calendar.booking.title')}>
      <DialogHeader>
        <DialogTitle>{t('calendar.booking.title')}</DialogTitle>
        <DialogDescription>{t('calendar.booking.body')}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={styles.bookingList}>
          {types.length === 0 ? <p className={styles.muted}>{t('calendar.booking.empty')}</p> : null}
          {types.map((type) => (
            <div key={type.id} className={styles.bookingRow}>
              <div>
                <strong>{type.title}</strong>
                <p className={styles.eventMeta}>
                  {t('book.minutes', { count: String(type.durationMinutes) })} · {type.url}
                </p>
              </div>
              <div className={styles.bookingRowActions}>
                <Button variant="ghost" onClick={() => void onCopy(type)}>
                  {copiedId === type.id ? t('calendar.booking.copied') : t('calendar.booking.copy')}
                </Button>
                <Button variant="ghost" onClick={() => void onRevoke(type.id)}>
                  {t('calendar.booking.revoke')}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <label className={styles.field}>
          <span>{t('calendar.fieldTitle')}</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t('calendar.booking.duration')}</span>
          <Select value={String(duration)} onChange={(event) => setDuration(Number(event.target.value))}>
            {BOOKING_DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('book.minutes', { count: String(minutes) })}
              </option>
            ))}
          </Select>
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>{t('calendar.booking.hoursStart')}</span>
            <Input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('calendar.booking.hoursEnd')}</span>
            <Input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
          </label>
        </div>
        <div className={styles.field}>
          <span>{t('calendar.booking.weekdays')}</span>
          <div className={styles.weekdayRow}>
            {WEEKDAYS.map((day) => (
              <button
                key={day.id}
                type="button"
                className={weekdays.includes(day.id) ? styles.weekdayActive : styles.weekday}
                onClick={() => toggleDay(day.id)}
              >
                {day.label}
              </button>
            ))}
          </div>
        </div>
        <label className={styles.field}>
          <span>{t('calendar.location')}</span>
          <Input value={location} onChange={(event) => setLocation(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t('calendar.description')}</span>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('calendar.cancel')}</Button>
        <Button disabled={saving || !title.trim() || weekdays.length === 0} onClick={() => void onCreate()}>
          {saving ? t('calendar.booking.creating') : t('calendar.booking.create')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
