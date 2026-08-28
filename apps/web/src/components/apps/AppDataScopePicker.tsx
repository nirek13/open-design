'use client';

// Tables this app is allowed to read or change.
//
// Scopes are declared here and enforced by the host (`scopeAllows`) — the
// picker is how a person authorizes a generated site, not how the site
// reaches the database on its own.

import { useEffect, useState } from 'react';
import { APP_GMAIL_SCOPE_TABLE, type AppDataScope, type WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { fetchWorkspaceTables } from '../../providers/registry';
import styles from './AppDataScopePicker.module.css';

export type TableAccessMode = 'off' | 'read' | 'write';

export function tableAccessMode(scopes: readonly AppDataScope[], table: string): TableAccessMode {
  if (scopes.some((scope) => scope.table === table && scope.mode === 'write')) return 'write';
  if (scopes.some((scope) => scope.table === table && scope.mode === 'read')) return 'read';
  return 'off';
}

export function setTableAccessMode(
  scopes: readonly AppDataScope[],
  table: string,
  mode: TableAccessMode,
): AppDataScope[] {
  const without = scopes.filter((scope) => scope.table !== table);
  if (mode === 'off') return without;
  return [...without, { table, mode }];
}

export function splitGmailScope(scopes: readonly AppDataScope[]): {
  tables: AppDataScope[];
  allowGmail: boolean;
} {
  return {
    tables: scopes.filter((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE),
    allowGmail: scopes.some((scope) => scope.table === APP_GMAIL_SCOPE_TABLE && scope.mode === 'write'),
  };
}

export function withGmailScope(scopes: readonly AppDataScope[], allowGmail: boolean): AppDataScope[] {
  const tables = scopes.filter((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE);
  return allowGmail ? [...tables, { table: APP_GMAIL_SCOPE_TABLE, mode: 'write' }] : tables;
}

/** Checking the org-write box grants inferred write tables. Unchecking
 * turns every workspace-table write into a read — Gmail stays its own control. */
export function applyOrgDataWriteConsent(
  scopes: readonly AppDataScope[],
  inferred: readonly AppDataScope[],
  allowWrites: boolean,
): AppDataScope[] {
  const tables = scopes.filter((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE);
  const gmail = scopes.filter((scope) => scope.table === APP_GMAIL_SCOPE_TABLE);
  if (allowWrites) {
    let next = tables;
    for (const scope of inferred) {
      if (scope.table === APP_GMAIL_SCOPE_TABLE || scope.mode !== 'write') continue;
      next = setTableAccessMode(next, scope.table, 'write');
    }
    return [...next, ...gmail];
  }
  return [
    ...tables.map((scope) => (scope.mode === 'write' ? { table: scope.table, mode: 'read' as const } : scope)),
    ...gmail,
  ];
}

interface Props {
  orgId: string;
  value: readonly AppDataScope[];
  onChange: (scopes: AppDataScope[]) => void;
  allowGmail?: boolean;
  onAllowGmailChange?: (allow: boolean) => void;
  /** Tables the HTML already calls — shown as "needed" so a person can match the grant. */
  suggested?: readonly AppDataScope[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AppDataScopePicker({
  orgId,
  value,
  onChange,
  allowGmail,
  onAllowGmailChange,
  suggested,
}: Props) {
  const t = useT();
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchWorkspaceTables(orgId);
        if (cancelled) return;
        setTables(next.filter((table) => table.status === 'active'));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const tableScopes = value.filter((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE);

  return (
    <fieldset className={styles.fieldset} data-testid="app-data-scope-picker">
      <legend>{t('apps.create.dataAccess')}</legend>
      <p className={styles.hint}>{t('apps.create.dataAccessHint')}</p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {tables.length === 0 && !error ? (
        <p className={styles.hint}>{t('apps.create.dataAccessEmpty')}</p>
      ) : (
        <div className={styles.rows}>
          {tables.map((table) => {
            const mode = tableAccessMode(tableScopes, table.name);
            const needed = suggested?.some((scope) => scope.table === table.name);
            return (
              <div key={table.id} className={styles.row}>
                <span className={styles.name} title={table.name}>
                  {table.displayName || table.name}
                </span>
                {needed ? (
                  <span className={styles.publicMark}>{t('apps.create.dataAccessNeeded')}</span>
                ) : null}
                {table.publicWrite ? (
                  <span className={styles.publicMark}>{t('apps.create.publicForm')}</span>
                ) : null}
                <div className={styles.modes}>
                  {(['off', 'read', 'write'] as const).map((next) => (
                    <button
                      key={next}
                      type="button"
                      className={mode === next ? styles.modeActive : styles.mode}
                      aria-pressed={mode === next}
                      data-testid={`app-scope-${table.name}-${next}`}
                      onClick={() => onChange(setTableAccessMode(tableScopes, table.name, next))}
                    >
                      {t(
                        next === 'off'
                          ? 'apps.create.dataModeOff'
                          : next === 'read'
                            ? 'apps.create.dataModeRead'
                            : 'apps.create.dataModeWrite',
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {onAllowGmailChange ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={allowGmail === true}
            onChange={(event) => onAllowGmailChange(event.target.checked)}
          />
          <span>{t('apps.create.gmailSend')}</span>
        </label>
      ) : null}
      {onAllowGmailChange && allowGmail ? <p className={styles.hint}>{t('apps.create.gmailSendHint')}</p> : null}
    </fieldset>
  );
}
