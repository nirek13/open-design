// Working in a table.
//
// The layout people already know: tables down the side, saved views across the
// top, an editable grid in the middle, and one box you can talk to. Everything
// on this screen is the same table seen through a different lens — switching a
// view never changes data, which is what makes them safe to click.
//
// The command bar is placed above the grid rather than in a modal on purpose:
// asking for a column and seeing the column appear in the same eyeline is the
// whole point. A dialog would break that.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type {
  WorkspaceRecord,
  WorkspaceTable,
  WorkspaceView,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createView,
  createWorkspaceRecord,
  fetchViewRecords,
  fetchViews,
  fetchWorkspaceTables,
  patchWorkspaceTable,
  updateView,
  updateWorkspaceRecord,
} from '../../providers/registry';
import { RecordGallery } from '../workspace/RecordGallery';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { CommandBar } from './CommandBar';
import { EditableGrid } from './EditableGrid';
import { RecordPanel } from '../record/RecordPanel';
import styles from './TablesView.module.css';

interface Props {
  active: boolean;
  initialTableName?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TablesView({ active, initialTableName }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [layout, setLayout] = useState<'table' | 'cards'>('cards');
  const [views, setViews] = useState<WorkspaceView[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof fetchViewRecords>>['groups']>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);

  const table = useMemo(
    () => tables.find((candidate) => candidate.id === tableId) ?? null,
    [tables, tableId],
  );
  const view = useMemo(() => views.find((candidate) => candidate.id === viewId) ?? null, [views, viewId]);

  const loadTables = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const next = await fetchWorkspaceTables(activeOrgId);
      setTables(next);
      setTableId((prev) => {
        const wanted = initialTableName
          ? next.find((candidate) => candidate.name === initialTableName || candidate.id === initialTableName)
          : null;
        if (wanted) return wanted.id;
        return prev ?? next[0]?.id ?? null;
      });
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setLoaded(true);
    }
  }, [activeOrgId, initialTableName]);

  const loadViews = useCallback(async () => {
    if (!activeOrgId || !tableId) return;
    try {
      const next = await fetchViews(activeOrgId, tableId);
      setViews(next);
      // Land on the table's default rather than whichever view sorts first.
      setViewId(next.find((candidate) => candidate.isDefault)?.id ?? next[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId, tableId]);

  const loadRecords = useCallback(async () => {
    if (!activeOrgId || !viewId) return;
    try {
      const result = await fetchViewRecords(activeOrgId, viewId);
      setRecords(result.records as unknown as WorkspaceRecord[]);
      setGroups(result.groups);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId, viewId]);

  useEffect(() => {
    if (active) void loadTables();
  }, [active, loadTables]);

  useEffect(() => {
    if (active) void loadViews();
  }, [active, loadViews]);

  useEffect(() => {
    if (active) void loadRecords();
  }, [active, loadRecords]);

  /** Commit one cell. Throwing is meaningful: the grid rolls the cell back and
   * shows the reason, so the screen never disagrees with the database. */
  const commitCell = useCallback(
    async (recordId: string, field: string, value: unknown) => {
      if (!activeOrgId) return;
      const record = records.find((candidate) => candidate.id === recordId);
      await updateWorkspaceRecord(activeOrgId, recordId, {
        data: { [field]: value } as never,
        ...(record?.revision !== undefined ? { expectedRevision: record.revision } : {}),
      });
      await loadRecords();
    },
    [activeOrgId, loadRecords, records],
  );

  const addRow = useCallback(async () => {
    if (!activeOrgId || !table) return;
    setBusy(true);
    try {
      // A blank row, the way a spreadsheet does it. Required fields are filled
      // in by typing, and the daemon rejects a save that still misses one —
      // which is a better moment to be told than before you have started.
      await createWorkspaceRecord(activeOrgId, table.id, { data: {} });
      await loadRecords();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, loadRecords, table]);

  const addView = useCallback(async () => {
    if (!activeOrgId || !table) return;
    setBusy(true);
    try {
      const created = await createView(activeOrgId, table.id, {
        name: t('views.newName', { count: String(views.length + 1) }),
      });
      await loadViews();
      setViewId(created.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, loadViews, t, table, views.length]);

  /** Turn the current view into a board grouped by a field, or back again. */
  const toggleBoard = useCallback(
    async (field: string | null) => {
      if (!activeOrgId || !view) return;
      setBusy(true);
      try {
        await updateView(activeOrgId, view.id, {
          kind: field ? 'board' : 'table',
          groupBy: field,
        });
        await loadViews();
        await loadRecords();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [activeOrgId, loadRecords, loadViews, view],
  );

  const togglePublicWrite = useCallback(
    async (publicWrite: boolean) => {
      if (!activeOrgId || !table) return;
      setBusy(true);
      try {
        const next = await patchWorkspaceTable(activeOrgId, table.id, { publicWrite });
        setTables((prev) => prev.map((candidate) => (candidate.id === next.id ? next : candidate)));
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [activeOrgId, table],
  );

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('tables.title')} testId="tables-view">
        <EmptyState title={t('tables.noOrg')} />
      </WorkspacePage>
    );
  }

  if (!loaded) {
    return (
      <WorkspacePage title={t('tables.title')} testId="tables-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  if (tables.length === 0) {
    return (
      <WorkspacePage title={t('tables.title')} lead={t('tables.lead')} testId="tables-view">
        <EmptyState title={t('tables.noTables')} description={t('tables.noTablesBody')} />
      </WorkspacePage>
    );
  }

  const groupableFields = (table?.fields ?? []).filter(
    (field) => field.type === 'select' || field.type === 'boolean',
  );

  return (
    <WorkspacePage title={t('tables.title')} lead={t('tables.lead')} testId="tables-view">
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label={t('tables.tables')}>
          <h2 className={styles.sidebarTitle}>{t('tables.tables')}</h2>
          <ul className={styles.tableList}>
            {tables.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  className={`${styles.tableButton}${candidate.id === tableId ? ` ${styles.tableActive}` : ''}`}
                  onClick={() => setTableId(candidate.id)}
                  aria-current={candidate.id === tableId ? 'true' : undefined}
                  data-testid={`tables-pick-${candidate.name}`}
                >
                  {candidate.displayName}
                  {candidate.publicWrite ? (
                    <span className={styles.publicMark}>{t('tables.publicWrite')}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className={styles.main}>
          <CommandBar
            orgId={activeOrgId}
            {...(table ? { tableRef: table.id } : {})}
            onApplied={() => {
              // A prompted change can add a column, so the schema is reloaded
              // alongside the rows.
              void loadTables();
              void loadRecords();
            }}
          />

          <div className={styles.viewBar}>
            <div className={styles.viewTabs} role="tablist" aria-label={t('views.label')}>
              {views.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={candidate.id === viewId}
                  className={`${styles.viewTab}${candidate.id === viewId ? ` ${styles.viewTabActive}` : ''}`}
                  onClick={() => setViewId(candidate.id)}
                  data-testid={`view-tab-${candidate.id}`}
                >
                  {candidate.name}
                  {candidate.kind !== 'table' ? (
                    <Badge tone="neutral">{t(`views.kind.${candidate.kind}` as never)}</Badge>
                  ) : null}
                </button>
              ))}
              <button
                type="button"
                className={styles.viewAdd}
                onClick={() => void addView()}
                disabled={busy}
                data-testid="view-add"
              >
                +
              </button>
            </div>

            {groupableFields.length > 0 ? (
              <label className={styles.groupControl}>
                <span className={styles.groupLabel}>{t('views.groupBy')}</span>
                <select
                  className={styles.groupSelect}
                  value={view?.groupBy ?? ''}
                  disabled={busy || !view}
                  onChange={(event) => void toggleBoard(event.target.value || null)}
                  data-testid="view-group-by"
                >
                  <option value="">{t('views.noGrouping')}</option>
                  {groupableFields.map((field) => (
                    <option key={field.id} value={field.name}>
                      {field.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className={styles.layoutToggle} role="group" aria-label={t('tables.display')}>
              <button
                type="button"
                className={layout === 'cards' ? styles.layoutActive : undefined}
                onClick={() => setLayout('cards')}
                data-testid="tables-layout-cards"
              >
                {t('tables.displayCards')}
              </button>
              <button
                type="button"
                className={layout === 'table' ? styles.layoutActive : undefined}
                onClick={() => setLayout('table')}
                data-testid="tables-layout-table"
              >
                {t('tables.displayTable')}
              </button>
            </div>
            {table && can('admin') ? (
              <label className={styles.publicWrite} title={t('tables.publicWriteHint')}>
                <input
                  type="checkbox"
                  checked={table.publicWrite === true}
                  disabled={busy}
                  onChange={(event) => void togglePublicWrite(event.target.checked)}
                  data-testid="tables-public-write"
                />
                <span>{t('tables.publicWrite')}</span>
              </label>
            ) : null}
          </div>

          {table ? (
            groups && view?.kind === 'board' ? (
              <div className={styles.board}>
                {groups.map((group) => (
                  <div key={group.key ?? '__none__'} className={styles.boardColumn}>
                    <header className={styles.boardHead}>
                      <span>{group.label}</span>
                      <Badge tone="neutral">{group.count}</Badge>
                    </header>
                    {layout === 'cards' ? (
                      <RecordGallery
                        fields={table.fields}
                        records={records.filter((record) => group.recordIds.includes(record.id))}
                        onOpen={setOpenRecordId}
                      />
                    ) : (
                      <EditableGrid
                        table={table}
                        records={records.filter((record) => group.recordIds.includes(record.id))}
                        visibleFields={view?.visibleFields ?? null}
                        onCommit={commitCell}
                        busy={busy}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : layout === 'cards' ? (
              <RecordGallery
                fields={table.fields}
                records={records}
                onOpen={setOpenRecordId}
              />
            ) : (
              <EditableGrid
                table={table}
                records={records}
                visibleFields={view?.visibleFields ?? null}
                onCommit={commitCell}
                onAddRow={() => void addRow()}
                onOpenRecord={setOpenRecordId}
                busy={busy}
              />
            )
          ) : null}
        </section>
      </div>

      <RecordPanel
        orgId={activeOrgId}
        recordId={openRecordId}
        onClose={() => setOpenRecordId(null)}
        onChanged={() => {
          void loadTables();
          void loadRecords();
        }}
        onOpenRecord={setOpenRecordId}
      />
    </WorkspacePage>
  );
}
