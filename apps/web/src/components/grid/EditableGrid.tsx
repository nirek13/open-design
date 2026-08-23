// A grid you can type into.
//
// The Notion property this copies is not the look — it is that editing is the
// default state. You click a cell and you are editing it; there is no edit
// mode, no dialog, no save button. The row is written when you leave the cell.
//
// Three details that make that feel right rather than fragile:
//
//   - Escape restores what was there. Committing on blur is only safe if
//     abandoning is equally easy, otherwise a mis-click becomes an edit.
//   - Enter moves down, Tab moves right, and both commit. A grid you cannot
//     leave without reaching for the mouse is not faster than a form.
//   - A failed save puts the old value back and says why, rather than leaving
//     the screen showing something the database does not contain.
//
// Computed fields render but never open: a formula's value belongs to the
// formula, and letting someone type over it would silently do nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@open-design/components';
import type { WorkspaceField, WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { formatMoney } from '../workspace/format';
import styles from './EditableGrid.module.css';

interface Props {
  table: WorkspaceTable;
  records: WorkspaceRecord[];
  /** Field names to show, in order. Omit for every field. */
  visibleFields?: string[] | null;
  /** Commit one cell. Rejecting rolls the cell back and surfaces the reason. */
  onCommit: (recordId: string, field: string, value: unknown) => Promise<void>;
  onAddRow?: () => void;
  onAddColumn?: () => void;
  onOpenRecord?: (recordId: string) => void;
  busy?: boolean;
}

interface Editing {
  recordId: string;
  field: string;
  /** What was there before, so Escape and a failed save can put it back. */
  original: string;
  draft: string;
}

/** Money is stored in integer minor units and edited in decimals — the one
 * conversion boundary, mirroring what the record editor does. */
function toEditable(value: unknown, field: WorkspaceField): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'money' && typeof value === 'number') return (value / 100).toFixed(2);
  if (field.type === 'json') return JSON.stringify(value);
  return String(value);
}

function fromEditable(raw: string, field: WorkspaceField): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'money': {
      const parsed = Number.parseFloat(trimmed.replace(/[$£€,\s]/g, ''));
      // Rounded because minor units are integers; 10.005 is not a real price.
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
    case 'boolean':
      return /^(yes|true|1|y)$/i.test(trimmed);
    case 'datetime': {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }
    case 'json':
      try {
        return JSON.parse(trimmed);
      } catch {
        // Keeping the text lets the daemon reject it with a real message
        // rather than this component inventing one.
        return trimmed;
      }
    default:
      return trimmed;
  }
}

function isComputed(field: WorkspaceField): boolean {
  const config = field.config as { formula?: string; rollup?: unknown } | null;
  return typeof config?.formula === 'string' || config?.rollup !== undefined;
}

function renderValue(value: unknown, field: WorkspaceField): React.ReactNode {
  if (value === null || value === undefined || value === '') return <span className={styles.blank}>—</span>;
  if (field.type === 'money' && typeof value === 'number') return formatMoney(value);
  if (field.type === 'boolean') return value ? '✓' : '';
  if (field.type === 'select') return <Badge tone="neutral">{String(value)}</Badge>;
  if (field.type === 'json') return <code className={styles.code}>{JSON.stringify(value)}</code>;
  return String(value);
}

export function EditableGrid({
  table,
  records,
  visibleFields,
  onCommit,
  onAddRow,
  onAddColumn,
  onOpenRecord,
  busy,
}: Props) {
  const t = useT();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fields = visibleFields
    ? (visibleFields
        .map((name) => table.fields.find((field) => field.name === name))
        .filter(Boolean) as WorkspaceField[])
    : table.fields;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const open = useCallback(
    (record: WorkspaceRecord, field: WorkspaceField) => {
      // A formula's value belongs to the formula; typing over it would look
      // like it worked and change nothing.
      if (isComputed(field)) return;
      const original = toEditable(record.data[field.name], field);
      setEditing({ recordId: record.id, field: field.name, original, draft: original });
    },
    [],
  );

  const commit = useCallback(
    async (moveTo?: { rowDelta?: number; colDelta?: number }) => {
      if (!editing) return;
      const field = table.fields.find((candidate) => candidate.name === editing.field);
      if (!field) return setEditing(null);

      const unchanged = editing.draft === editing.original;
      const current = editing;
      setEditing(null);

      if (!unchanged) {
        try {
          await onCommit(current.recordId, current.field, fromEditable(current.draft, field));
          setError(null);
        } catch (err) {
          // Put the old value back rather than leaving the screen showing
          // something the database does not contain.
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }

      if (!moveTo) return;
      const rowIndex = records.findIndex((record) => record.id === current.recordId);
      const colIndex = fields.findIndex((candidate) => candidate.name === current.field);
      const nextRow = records[rowIndex + (moveTo.rowDelta ?? 0)];
      const nextCol = fields[colIndex + (moveTo.colDelta ?? 0)];
      if (moveTo.rowDelta && nextRow) open(nextRow, fields[colIndex]!);
      else if (moveTo.colDelta && nextCol && records[rowIndex]) open(records[rowIndex]!, nextCol);
    },
    [editing, fields, onCommit, open, records, table.fields],
  );

  return (
    <div className={styles.root} data-testid="editable-grid">
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {fields.map((field) => (
                <th key={field.id} scope="col" className={styles.th}>
                  <span className={styles.thLabel}>
                    {field.displayName}
                    {isComputed(field) ? (
                      <span className={styles.computedMark} title={t('grid.computed')}>
                        ƒ
                      </span>
                    ) : null}
                  </span>
                </th>
              ))}
              <th scope="col" className={styles.thAdd}>
                {onAddColumn ? (
                  <button
                    type="button"
                    className={styles.addColumn}
                    onClick={onAddColumn}
                    title={t('grid.addColumn')}
                    data-testid="grid-add-column"
                  >
                    +
                  </button>
                ) : null}
              </th>
            </tr>
          </thead>

          <tbody>
            {records.map((record) => (
              <tr key={record.id} className={styles.tr}>
                {fields.map((field) => {
                  const isEditing =
                    editing?.recordId === record.id && editing.field === field.name;
                  const computed = isComputed(field);
                  return (
                    <td
                      key={field.id}
                      className={`${styles.td}${computed ? ` ${styles.tdComputed}` : ''}`}
                      onDoubleClick={() => open(record, field)}
                      data-testid={`cell-${record.id}-${field.name}`}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className={styles.cellInput}
                          value={editing.draft}
                          onChange={(event) =>
                            setEditing({ ...editing, draft: event.target.value })
                          }
                          onBlur={() => void commit()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              // Abandoning must be as easy as committing, or a
                              // mis-click becomes an edit.
                              event.preventDefault();
                              setEditing(null);
                            } else if (event.key === 'Enter') {
                              event.preventDefault();
                              void commit({ rowDelta: 1 });
                            } else if (event.key === 'Tab') {
                              event.preventDefault();
                              void commit({ colDelta: event.shiftKey ? -1 : 1 });
                            }
                          }}
                          aria-label={`${field.displayName} ${record.id}`}
                          data-testid={`cell-input-${record.id}-${field.name}`}
                        />
                      ) : (
                        <button
                          type="button"
                          className={styles.cellButton}
                          onClick={() => open(record, field)}
                          disabled={computed}
                          tabIndex={computed ? -1 : 0}
                        >
                          {renderValue(record.data[field.name], field)}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className={styles.tdAction}>
                  {onOpenRecord ? (
                    <button
                      type="button"
                      className={styles.openRow}
                      onClick={() => onOpenRecord(record.id)}
                      title={t('grid.openRecord')}
                    >
                      ⤢
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}

            {onAddRow ? (
              <tr>
                <td colSpan={fields.length + 1} className={styles.addRowCell}>
                  <button
                    type="button"
                    className={styles.addRow}
                    onClick={onAddRow}
                    disabled={busy}
                    data-testid="grid-add-row"
                  >
                    + {t('grid.addRow')}
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {records.length === 0 ? <p className={styles.empty}>{t('grid.empty')}</p> : null}
    </div>
  );
}
