// One field, editable.
//
// Each field type gets the control it deserves — a select for a select, a
// checkbox for a boolean, a date picker for a date — rather than a text box
// for everything. This is most of what "intuitive" means in practice: a status
// field that offers its options cannot be typed wrong.
//
// Commit happens on blur (or immediately for controls where a click *is* the
// decision, like a checkbox). A failed commit puts the previous value back and
// shows why, so the field never displays something the database rejected.

import { useEffect, useState } from 'react';
import type { WorkspaceField } from '@open-design/contracts';
import styles from './FieldInput.module.css';

interface Props {
  id: string;
  field: WorkspaceField;
  value: unknown;
  readOnly?: boolean;
  onCommit: (value: unknown) => Promise<void>;
}

/** Money is stored as integer minor units and edited as decimals — the same
 * single conversion boundary the grid uses. */
function toText(value: unknown, field: WorkspaceField): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'money' && typeof value === 'number') return (value / 100).toFixed(2);
  if (field.type === 'datetime' && typeof value === 'number') {
    // datetime is epoch-ms in this system; the control needs a local string.
    return new Date(value).toISOString().slice(0, 16);
  }
  if (field.type === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

function fromText(raw: string, field: WorkspaceField): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'money': {
      const parsed = Number.parseFloat(trimmed.replace(/[$£€,\s]/g, ''));
      return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
    }
    case 'integer': {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'number': {
      const parsed = Number.parseFloat(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'datetime': {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }
    case 'json':
      try {
        return JSON.parse(trimmed);
      } catch {
        // Send the text and let the daemon give the real message rather than
        // inventing one here.
        return trimmed;
      }
    default:
      return trimmed;
  }
}

export function FieldInput({ id, field, value, readOnly, onCommit }: Props) {
  const [draft, setDraft] = useState(() => toText(value, field));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-sync when the record reloads under us — after a commit elsewhere, or
  // when a formula recomputes.
  useEffect(() => {
    setDraft(toText(value, field));
  }, [field, value]);

  const commit = async (next: unknown, display: string) => {
    setSaving(true);
    try {
      await onCommit(next);
      setError(null);
    } catch (err) {
      // Put back what the database actually holds.
      setDraft(toText(value, field));
      setError(err instanceof Error ? err.message : String(err));
      void display;
    } finally {
      setSaving(false);
    }
  };

  const options = (field.config as { options?: string[] } | null)?.options;
  const className = `${styles.control}${saving ? ` ${styles.saving}` : ''}`;

  let control: React.ReactNode;

  if (readOnly) {
    control = (
      <output id={id} className={styles.readOnly}>
        {toText(value, field) || '—'}
      </output>
    );
  } else if (field.type === 'boolean') {
    control = (
      <input
        id={id}
        type="checkbox"
        className={styles.checkbox}
        checked={value === true}
        disabled={saving}
        // A click on a checkbox *is* the decision; waiting for blur would
        // leave it looking changed while nothing was saved.
        onChange={(event) => void commit(event.target.checked, '')}
      />
    );
  } else if (field.type === 'select' && Array.isArray(options)) {
    control = (
      <select
        id={id}
        className={className}
        value={typeof value === 'string' ? value : ''}
        disabled={saving}
        onChange={(event) => void commit(event.target.value || null, event.target.value)}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'date') {
    control = (
      <input
        id={id}
        type="date"
        className={className}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== toText(value, field)) void commit(draft || null, draft);
        }}
      />
    );
  } else if (field.type === 'json' || (field.type === 'text' && field.name.includes('note'))) {
    control = (
      <textarea
        id={id}
        className={`${className} ${styles.textarea}`}
        value={draft}
        disabled={saving}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== toText(value, field)) void commit(fromText(draft, field), draft);
        }}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type={field.type === 'money' || field.type === 'number' || field.type === 'integer' ? 'text' : 'text'}
        inputMode={field.type === 'money' || field.type === 'number' ? 'decimal' : undefined}
        className={className}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== toText(value, field)) void commit(fromText(draft, field), draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setDraft(toText(value, field));
        }}
      />
    );
  }

  return (
    <div className={styles.root}>
      {control}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
