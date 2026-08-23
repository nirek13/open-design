// One record, open.
//
// The record page an ERP lives in: the row's own fields on the left, what
// hangs off it on the right, and the document actions that are valid right
// now at the top. Every module opens into this same panel, so a bill, a deal,
// and a ticket are worked the same way — the thing that makes a big system
// learnable is that the second module costs nothing to learn.
//
// Editing is inline and per-field. Each field commits on blur and rolls back
// with a reason if the daemon refuses, so there is no form-wide save that can
// half-succeed and no dialog stacked on a dialog.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Skeleton } from '@open-design/components';
import type { RecordDetail, RecordVersionEntry, WorkspaceField } from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  convertDocument,
  ensurePageForRecord,
  fetchRecordDetail,
  fetchRecordHistory,
  postDocumentToLedger,
  restoreRecordVersion,
  updateWorkspaceRecord,
} from '../../providers/registry';
import { navigate } from '../../router';
import { formatDateTime, formatMoney } from '../workspace/format';
import { FieldInput } from './FieldInput';
import styles from './RecordPanel.module.css';

interface Props {
  orgId: string;
  recordId: string | null;
  onClose: () => void;
  /** Called after anything changes, so the surface behind can reload. */
  onChanged?: () => void;
  /** Open another record — related lists and links are clickable. */
  onOpenRecord?: (recordId: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isComputed(field: WorkspaceField): boolean {
  const config = field.config as { formula?: string; rollup?: unknown } | null;
  return typeof config?.formula === 'string' || config?.rollup !== undefined;
}

export function RecordPanel({ orgId, recordId, onClose, onChanged, onOpenRecord }: Props) {
  const t = useT();
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Loaded on demand: most people open a record to read it, not to audit it,
  // and a full history on every open would be a wasted round trip.
  const [history, setHistory] = useState<RecordVersionEntry[] | null>(null);

  const load = useCallback(async () => {
    if (!recordId) return;
    try {
      setDetail(await fetchRecordDetail(orgId, recordId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [orgId, recordId]);

  useEffect(() => {
    setDetail(null);
    setNotice(null);
    setHistory(null);
    void load();
  }, [load]);

  const loadHistory = useCallback(async () => {
    if (!recordId) return;
    try {
      setHistory(await fetchRecordHistory(orgId, recordId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [orgId, recordId]);

  /** Go back to an earlier version. This writes a new version rather than
   * rewinding, so the step back is itself in the history and can be undone. */
  const restore = useCallback(
    async (revision: number) => {
      if (!recordId) return;
      setBusy(true);
      try {
        await restoreRecordVersion(orgId, recordId, revision);
        await load();
        await loadHistory();
        setNotice(t('record.restored', { revision: String(revision) }));
        onChanged?.();
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [load, loadHistory, onChanged, orgId, recordId, t],
  );

  // Escape closes. A panel you cannot dismiss from the keyboard is a trap.
  useEffect(() => {
    if (!recordId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, recordId]);

  const commitField = useCallback(
    async (field: string, value: unknown) => {
      if (!detail) return;
      await updateWorkspaceRecord(orgId, detail.record.id, {
        data: { [field]: value } as never,
        expectedRevision: detail.record.revision,
      });
      await load();
      onChanged?.();
    },
    [detail, load, onChanged, orgId],
  );

  const post = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await postDocumentToLedger(orgId, detail.table.name, detail.record.id);
      setNotice(
        result.entry
          ? t('record.posted', { number: String(result.entry.number ?? result.entry.id) })
          : t('record.postSkipped', { reason: result.skipped ?? '' }),
      );
      await load();
      onChanged?.();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [detail, load, onChanged, orgId, t]);

  const convert = useCallback(
    async (to: string) => {
      if (!detail) return;
      setBusy(true);
      try {
        const draft = await convertDocument(orgId, detail.table.name, to, detail.record.id);
        // Drafted, not created — the same rule the CLI and the hub follow:
        // seeing the next document and choosing it are separate steps.
        setNotice(t('record.converted', { table: draft.table }));
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [detail, orgId, t],
  );

  const openNotes = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const page = await ensurePageForRecord(orgId, {
        recordId: detail.record.id,
        tableId: detail.table.id,
        tableName: detail.table.name,
        title: detail.title || detail.table.displayName,
      });
      navigate({ kind: 'home', view: 'pages', pageId: page.id });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [detail, orgId]);

  if (!recordId) return null;

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <aside
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={detail?.title ?? t('record.loading')}
        data-testid="record-panel"
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <p className={styles.eyebrow}>{detail?.table.displayName ?? ''}</p>
            <h2 className={styles.title}>{detail?.title ?? t('record.loading')}</h2>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t('record.close')}
            data-testid="record-close"
          >
            ✕
          </button>
        </header>

        {detail?.actions.length || detail ? (
          <div className={styles.actions}>
            {detail?.actions.includes('post') ? (
              <Button onClick={() => void post()} disabled={busy} data-testid="record-post">
                {t('record.post')}
              </Button>
            ) : null}
            {detail?.actions
              .filter((action) => action.startsWith('convert:'))
              .map((action) => {
                const to = action.slice('convert:'.length);
                return (
                  <Button
                    key={action}
                    variant="ghost"
                    onClick={() => void convert(to)}
                    disabled={busy}
                    data-testid={`record-convert-${to}`}
                  >
                    {t('record.convertTo', { table: to })}
                  </Button>
                );
              })}
            {detail ? (
              <Button
                variant="ghost"
                onClick={() => void openNotes()}
                disabled={busy}
                data-testid="record-notes"
              >
                {t('record.notes')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}

        {!detail ? (
          <Skeleton />
        ) : (
          <div className={styles.body}>
            <section className={styles.fields} aria-label={t('record.fields')}>
              {detail.table.fields.map((field) => (
                <div key={field.id} className={styles.fieldRow}>
                  <label className={styles.fieldLabel} htmlFor={`rp-${field.id}`}>
                    {field.displayName}
                    {field.required ? <span className={styles.required}>*</span> : null}
                    {isComputed(field) ? (
                      <span className={styles.computed} title={t('grid.computed')}>
                        ƒ
                      </span>
                    ) : null}
                  </label>
                  <FieldInput
                    id={`rp-${field.id}`}
                    field={field}
                    value={detail.record.data[field.name]}
                    readOnly={isComputed(field)}
                    onCommit={(value) => commitField(field.name, value)}
                  />
                </div>
              ))}
            </section>

            <div className={styles.side}>
              {detail.links.length > 0 ? (
                <section className={styles.block} aria-label={t('record.linked')}>
                  <h3 className={styles.blockTitle}>{t('record.linked')}</h3>
                  <ul className={styles.linkList}>
                    {detail.links.map((link) => (
                      <li key={link.field}>
                        <span className={styles.linkLabel}>{link.fieldLabel}</span>
                        <button
                          type="button"
                          className={styles.linkValue}
                          onClick={() => onOpenRecord?.(link.recordId)}
                          disabled={!onOpenRecord}
                        >
                          {link.label}
                        </button>
                        {link.deleted ? <Badge tone="warning">{t('record.deleted')}</Badge> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className={styles.block} aria-label={t('record.history')}>
                <h3 className={styles.blockTitle}>
                  {t('record.history')}
                  {history ? <Badge tone="neutral">{history.length}</Badge> : null}
                </h3>

                {!history ? (
                  <button
                    type="button"
                    className={styles.loadHistory}
                    onClick={() => void loadHistory()}
                    data-testid="record-load-history"
                  >
                    {t('record.showHistory')}
                  </button>
                ) : (
                  <ol className={styles.history}>
                    {history.map((entry) => (
                      <li key={entry.revision} className={styles.historyEntry}>
                        <div className={styles.historyHead}>
                          <span className={styles.historyWhen}>
                            {t(`record.op.${entry.op}` as never)} · {formatDateTime(entry.createdAt)}
                          </span>
                          {entry.isCurrent ? (
                            <Badge tone="positive">{t('record.current')}</Badge>
                          ) : (
                            <button
                              type="button"
                              className={styles.restore}
                              onClick={() => void restore(entry.revision)}
                              disabled={busy}
                              data-testid={`record-restore-${entry.revision}`}
                            >
                              {t('record.restore')}
                            </button>
                          )}
                        </div>
                        {entry.changes.length > 0 ? (
                          <ul className={styles.changes}>
                            {entry.changes.map((change) => (
                              <li key={change.field}>
                                <span className={styles.changeField}>{change.label}</span>
                                <span className={styles.changeFrom}>
                                  {change.from === null || change.from === '' ? '—' : String(change.from)}
                                </span>
                                {' → '}
                                <span className={styles.changeTo}>
                                  {change.to === null || change.to === '' ? '—' : String(change.to)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {detail.related.map((list) => (
                <section
                  key={`${list.tableId}-${list.viaField}`}
                  className={styles.block}
                  aria-label={list.tableDisplayName}
                  data-testid={`related-${list.tableName}`}
                >
                  <h3 className={styles.blockTitle}>
                    {list.tableDisplayName}
                    <Badge tone="neutral">{list.total}</Badge>
                  </h3>

                  {list.rollups.length > 0 ? (
                    <p className={styles.rollups}>
                      {list.rollups.map((rollup) => (
                        <span key={rollup.field} className={styles.rollup}>
                          {rollup.label}: <strong>{formatMoney(rollup.value)}</strong>
                        </span>
                      ))}
                    </p>
                  ) : null}

                  <ul className={styles.relatedList}>
                    {list.records.map((row) => (
                      <li key={row.recordId}>
                        <button
                          type="button"
                          className={styles.relatedRow}
                          onClick={() => onOpenRecord?.(row.recordId)}
                          disabled={!onOpenRecord}
                        >
                          <span className={styles.relatedLabel}>{row.label}</span>
                          <span className={styles.relatedMeta}>{formatDateTime(row.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>

                  {list.truncated ? (
                    <p className={styles.truncated}>
                      {t('record.andMore', { count: String(list.total - list.records.length) })}
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
