'use client';

// Live embed of an org workspace table inside a Substrate page.
// Reads via the same query API as Tables / CRM — not a static snapshot.

import { useEffect, useState } from 'react';
import type { WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import {
  fetchWorkspaceTables,
  queryWorkspaceRecords,
} from '../../providers/registry';
import { navigate } from '../../router';
import styles from './Embeds.module.css';

interface DatabaseEmbedProps {
  orgId: string;
  tableId: string;
  onOpenRecord?: (recordId: string) => void;
}

interface RecordEmbedProps {
  orgId: string;
  recordId: string;
  tableId?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function DatabaseEmbed({ orgId, tableId, onOpenRecord }: DatabaseEmbedProps) {
  const [table, setTable] = useState<WorkspaceTable | null>(null);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tables = await fetchWorkspaceTables(orgId);
        const match =
          tables.find((row) => row.id === tableId || row.name === tableId) ?? null;
        if (!match) throw new Error(`No table '${tableId}'`);
        const queried = await queryWorkspaceRecords(orgId, match.name, { limit: 25 });
        if (cancelled) return;
        setTable(match);
        setRecords(queried.records);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, tableId]);

  if (error) {
    return (
      <div className={styles.embedError} role="alert">
        {error}
      </div>
    );
  }
  if (!table) {
    return <div className={styles.embedLoading}>Loading table…</div>;
  }

  const fields = table.fields.slice(0, 5);

  return (
    <div className={styles.embed}>
      <div className={styles.embedHead}>
        <strong>{table.displayName}</strong>
        <button
          type="button"
          className={styles.embedLink}
          onClick={() => navigate({ kind: 'home', view: 'tables' })}
        >
          Open in Tables →
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {fields.map((field) => (
                <th key={field.id}>{field.displayName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={Math.max(fields.length, 1)} className={styles.empty}>
                  No rows yet
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr
                  key={record.id}
                  className={styles.row}
                  onClick={() => onOpenRecord?.(record.id)}
                >
                  {fields.map((field) => (
                    <td key={field.id}>{formatCell(record.data[field.name])}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RecordEmbed({ orgId, recordId }: RecordEmbedProps) {
  const [title, setTitle] = useState<string | null>(null);
  const [tableName, setTableName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { fetchRecordDetail } = await import('../../providers/registry');
        const detail = await fetchRecordDetail(orgId, recordId);
        if (cancelled) return;
        setTitle(detail.title);
        setTableName(detail.table.displayName);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, recordId]);

  if (error) {
    return (
      <div className={styles.embedError} role="alert">
        {error}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.recordCard}
      onClick={() => navigate({ kind: 'home', view: 'workspace' })}
    >
      <span className={styles.recordEyebrow}>{tableName ?? 'Record'}</span>
      <span className={styles.recordTitle}>{title ?? 'Loading…'}</span>
      <span className={styles.recordHint}>Open in Workspace →</span>
    </button>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
