// The deal pipeline.
//
// A board rather than a table, because the question people bring to a CRM is
// "where is everything" and a stage column answers that at a glance. Each card
// can be moved with the keyboard as well as dragged: a select is the accessible
// control, and dragging is the shortcut layered on top of it — not the only way.
//
// Totals come from the daemon already summed. The forecast is deliberately
// shown next to the raw total rather than instead of it, because a weighted
// number without its input invites arguments nobody can settle.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import {
  DEAL_STAGES,
  type DealStage,
  type PayablesRow,
  type PipelineSummary,
  type ReceivablesSummary,
  type WorkspaceRecord,
  type WorkspaceTable,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createWorkspaceRecord,
  dealToQuote,
  fetchErpTemplates,
  fetchPipeline,
  fetchReceivables,
  fetchWorkspaceTables,
  installErpTemplate,
  moveDealStage,
  queryWorkspaceRecords,
  updateWorkspaceRecord,
} from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { EditableGrid } from '../grid/EditableGrid';
import { CommandBar } from '../grid/CommandBar';
import { DataTable, type Column } from '../workspace/DataTable';
import { StatCard } from '../workspace/StatCard';
import { RecordPanel } from '../record/RecordPanel';
import { formatDate, formatMoney } from '../workspace/format';
import styles from './CrmView.module.css';

interface Props {
  active: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The CRM's own tabs. `pipeline` is the board; `receivables` is aged AR;
 * the rest are the tables you work in directly. */
type CrmTab = 'pipeline' | 'deals' | 'contacts' | 'activities' | 'customers' | 'receivables';

/** Which table each tab edits. `pipeline` / `receivables` are read-side views. */
const TAB_TABLE: Partial<Record<CrmTab, string>> = {
  pipeline: 'deals',
  deals: 'deals',
  contacts: 'contacts',
  activities: 'activities',
  customers: 'customers',
};

/** Sensible starting values so "New deal" produces a row that saves, rather
 * than one that fails validation before it has been typed into. */
const NEW_ROW_DEFAULTS: Record<string, Record<string, unknown>> = {
  deals: { title: 'New deal', stage: 'new' },
  contacts: { name: 'New contact' },
  activities: { subject: 'New activity', activity_type: 'note' },
  customers: { name: 'New customer' },
};

/** Won and lost read differently from the stages still in play. */
const STAGE_TONE: Partial<Record<DealStage, 'positive' | 'danger'>> = {
  won: 'positive',
  lost: 'danger',
};

export function CrmView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [pipeline, setPipeline] = useState<PipelineSummary | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DealStage | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  // The CRM is a place to work, not a report: each tab is a live table you can
  // add to and edit without leaving for the generic Tables screen.
  const [tab, setTab] = useState<CrmTab>('pipeline');
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [rows, setRows] = useState<WorkspaceRecord[]>([]);
  const [receivables, setReceivables] = useState<ReceivablesSummary | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const templates = await fetchErpTemplates(activeOrgId);
      const crm = templates.find((template) => template.templateId === 'crm');
      setInstalled(Boolean(crm?.installed));
      // Asking for the pipeline before the tables exist would 404; the install
      // card is the honest thing to show instead.
      if (!crm?.installed) {
        setPipeline(null);
        setError(null);
        return;
      }
      setPipeline(await fetchPipeline(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const currentTableName = TAB_TABLE[tab];
  const currentTable = useMemo(
    () =>
      currentTableName
        ? (tables.find((candidate) => candidate.name === currentTableName) ?? null)
        : null,
    [currentTableName, tables],
  );

  const loadTables = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setTables(await fetchWorkspaceTables(activeOrgId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  const loadRows = useCallback(async () => {
    if (!activeOrgId || !currentTable) return;
    try {
      const result = await queryWorkspaceRecords(activeOrgId, currentTable.id, { limit: 200 });
      setRows(result.records);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId, currentTable]);

  const loadReceivables = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setReceivables(await fetchReceivables(activeOrgId));
      setError(null);
    } catch (err) {
      setReceivables(null);
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (active && installed) void loadTables();
  }, [active, installed, loadTables]);

  useEffect(() => {
    if (active && installed && tab !== 'pipeline' && tab !== 'receivables') void loadRows();
  }, [active, installed, loadRows, tab]);

  useEffect(() => {
    if (active && installed && tab === 'receivables') void loadReceivables();
  }, [active, installed, loadReceivables, tab]);

  /** Add a row to whichever table the tab is showing, then open it so the
   * details can be filled in. Create-then-open rather than a modal form: the
   * record page is where every field lives anyway. */
  const addRow = useCallback(async () => {
    if (!activeOrgId || !currentTable) return;
    setBusy(true);
    try {
      const created = await createWorkspaceRecord(activeOrgId, currentTable.id, {
        data: (NEW_ROW_DEFAULTS[currentTable.name] ?? {}) as never,
      });
      await loadRows();
      await load();
      setOpenRecordId(created.id);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, currentTable, load, loadRows]);

  const commitCell = useCallback(
    async (recordId: string, field: string, value: unknown) => {
      if (!activeOrgId) return;
      const row = rows.find((candidate) => candidate.id === recordId);
      await updateWorkspaceRecord(activeOrgId, recordId, {
        data: { [field]: value } as never,
        ...(row?.revision !== undefined ? { expectedRevision: row.revision } : {}),
      });
      await loadRows();
      await load();
    },
    [activeOrgId, load, loadRows, rows],
  );

  const install = useCallback(async () => {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await installErpTemplate(activeOrgId, 'crm');
      await load();
      setNotice(t('crm.installed'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, load, t]);

  const move = useCallback(
    async (recordId: string, stage: DealStage) => {
      if (!activeOrgId) return;
      setBusy(true);
      try {
        await moveDealStage(activeOrgId, recordId, stage);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
        setDragging(null);
        setDropTarget(null);
      }
    },
    [activeOrgId, load],
  );

  const toQuote = useCallback(
    async (recordId: string) => {
      if (!activeOrgId) return;
      setBusy(true);
      try {
        const draft = await dealToQuote(activeOrgId, recordId);
        const number = draft.data.quote_number;
        setNotice(t('crm.quoteDrafted', { number: typeof number === 'string' ? number : '' }));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [activeOrgId, t],
  );

  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline]);

  const receivableColumns: Column<PayablesRow>[] = [
    { key: 'billNumber', header: t('crm.invoice'), cell: (row) => row.billNumber },
    { key: 'customer', header: t('crm.customerCol'), cell: (row) => row.vendorName ?? '—' },
    {
      key: 'issued',
      header: t('crm.issued'),
      secondary: true,
      cell: (row) => formatDate(row.issueDate),
    },
    { key: 'due', header: t('crm.due'), cell: (row) => formatDate(row.dueDate) },
    {
      key: 'total',
      header: t('crm.total'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.total),
    },
    {
      key: 'paid',
      header: t('crm.paid'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.paid),
    },
    {
      key: 'outstanding',
      header: t('crm.outstanding'),
      align: 'end',
      cell: (row) => <strong>{formatMoney(row.outstanding)}</strong>,
    },
    {
      key: 'age',
      header: t('crm.age'),
      cell: (row) =>
        row.daysOverdue > 0 ? (
          <Badge tone="danger">{t('crm.overdueDays', { days: String(row.daysOverdue) })}</Badge>
        ) : (
          <span className={styles.muted}>{t('crm.notDue')}</span>
        ),
    },
  ];

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('crm.title')} testId="crm-view">
        <EmptyState title={t('crm.noOrg')} />
      </WorkspacePage>
    );
  }

  if (installed === false) {
    return (
      <WorkspacePage title={t('crm.title')} lead={t('crm.lead')} testId="crm-view">
        <WorkspaceSection>
          <EmptyState
            title={t('crm.setUpTitle')}
            description={t('crm.setUpBody')}
            action={
              can('admin') ? (
                <Button onClick={install} disabled={busy} data-testid="crm-install">
                  {busy ? t('crm.installing') : t('crm.setUpAction')}
                </Button>
              ) : undefined
            }
          />
        </WorkspaceSection>
      </WorkspacePage>
    );
  }

  if (installed === null) {
    return (
      <WorkspacePage title={t('crm.title')} testId="crm-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  const TABS: CrmTab[] = ['pipeline', 'deals', 'contacts', 'activities', 'customers', 'receivables'];

  return (
    <WorkspacePage
      title={t('crm.title')}
      lead={t('crm.lead')}
      testId="crm-view"
      tabs={TABS.map((id) => ({ id, label: t(`crm.tab.${id}` as never) }))}
      activeTab={tab}
      onTabChange={(next) => setTab(next as CrmTab)}
      actions={
        <>
          {tab !== 'pipeline' && tab !== 'receivables' ? (
            <Button onClick={() => void addRow()} disabled={busy || !currentTable} data-testid="crm-add-row">
              {t('crm.newOf', { name: t(`crm.singular.${tab}` as never) })}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              if (tab === 'receivables') void loadReceivables();
              else void load();
            }}
            disabled={busy}
          >
            {t('crm.refresh')}
          </Button>
        </>
      }
    >
      {/* The same command bar as the Tables screen, scoped to whichever CRM
          table is on show — so "add a lead score column" works here without
          naming the table or leaving for another page. */}
      {tab !== 'receivables' ? (
        <WorkspaceSection>
          <CommandBar
            orgId={activeOrgId}
            {...(currentTable ? { tableRef: currentTable.id } : {})}
            onApplied={() => {
              void loadTables();
              void loadRows();
              void load();
            }}
          />
        </WorkspaceSection>
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

      {tab !== 'pipeline' && tab !== 'receivables' ? (
        <WorkspaceSection>
          {currentTable ? (
            <EditableGrid
              table={currentTable}
              records={rows}
              onCommit={commitCell}
              onAddRow={() => void addRow()}
              onOpenRecord={setOpenRecordId}
              busy={busy}
            />
          ) : null}
        </WorkspaceSection>
      ) : null}

      {tab === 'receivables' ? (
        <WorkspaceSection title={t('crm.receivables')}>
          <div className={styles.stats}>
            <StatCard
              label={t('crm.totalOutstanding')}
              value={formatMoney(receivables?.totalOutstanding ?? 0)}
              detail={t('crm.acrossInvoices', {
                count: String(receivables?.rows.length ?? 0),
              })}
            />
            <StatCard
              label={t('crm.totalOverdue')}
              value={formatMoney(receivables?.totalOverdue ?? 0)}
              tone="danger"
            />
          </div>
          {receivables && receivables.rows.length > 0 ? (
            <DataTable
              columns={receivableColumns}
              rows={receivables.rows}
              rowKey={(row) => row.recordId}
              onRowClick={(row) => setOpenRecordId(row.recordId)}
            />
          ) : (
            <EmptyState
              title={t('crm.nothingOwed')}
              description={t('crm.nothingOwedBody')}
            />
          )}
        </WorkspaceSection>
      ) : null}

      {tab === 'pipeline' ? (
        <>
      <WorkspaceSection>
        <div className={styles.stats}>
          <StatCard
            label={t('crm.openValue')}
            value={formatMoney(pipeline?.openValue ?? 0)}
            detail={t('crm.openValueDetail')}
            testId="crm-open-value"
          />
          <StatCard
            label={t('crm.weightedValue')}
            value={formatMoney(pipeline?.weightedValue ?? 0)}
            detail={t('crm.weightedValueDetail')}
          />
          <StatCard
            label={t('crm.wonValue')}
            value={formatMoney(pipeline?.wonValue ?? 0)}
            tone="positive"
          />
          <StatCard
            label={t('crm.lostValue')}
            value={formatMoney(pipeline?.lostValue ?? 0)}
            tone="danger"
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection title={t('crm.board')}>
        <div className={styles.board} data-testid="crm-board">
          {stages.map((column) => (
            <div
              key={column.stage}
              className={`${styles.column}${dropTarget === column.stage ? ` ${styles.columnOver}` : ''}`}
              data-testid={`crm-column-${column.stage}`}
              onDragOver={(event) => {
                // Only preventDefault when we can actually accept the drop,
                // so the cursor tells the truth.
                if (!dragging) return;
                event.preventDefault();
                setDropTarget(column.stage);
              }}
              onDragLeave={() => setDropTarget((prev) => (prev === column.stage ? null : prev))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) void move(dragging, column.stage);
              }}
            >
              <header className={styles.columnHead}>
                <span className={styles.columnName}>{t(`crm.stage.${column.stage}` as never)}</span>
                <Badge tone={STAGE_TONE[column.stage]}>{column.dealCount}</Badge>
              </header>
              <p className={styles.columnTotal}>
                {formatMoney(column.totalValue)}
                {column.weightedValue !== column.totalValue ? (
                  <span className={styles.columnWeighted}>
                    {t('crm.weightedShort', { value: formatMoney(column.weightedValue) })}
                  </span>
                ) : null}
              </p>

              <ul className={styles.cards}>
                {column.deals.map((deal) => (
                  <li
                    key={deal.recordId}
                    className={styles.card}
                    draggable
                    onDragStart={() => setDragging(deal.recordId)}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    data-testid={`crm-deal-${deal.recordId}`}
                  >
                    <button
                      type="button"
                      className={styles.cardTitleButton}
                      onClick={() => setOpenRecordId(deal.recordId)}
                      data-testid={`crm-open-${deal.recordId}`}
                    >
                      {deal.title}
                    </button>
                    {deal.customerName ? (
                      <p className={styles.cardCompany}>{deal.customerName}</p>
                    ) : null}
                    <p className={styles.cardValue}>
                      {formatMoney(deal.value)}
                      {typeof deal.probability === 'number' ? (
                        <span className={styles.cardProbability}>{deal.probability}%</span>
                      ) : null}
                    </p>
                    {deal.expectedClose ? (
                      <p className={styles.cardMeta}>{formatDate(deal.expectedClose)}</p>
                    ) : null}
                    {deal.owner ? <p className={styles.cardMeta}>{deal.owner}</p> : null}

                    <div className={styles.cardActions}>
                      {/* The select is the real control; dragging is a
                          shortcut over it, so the board stays usable with a
                          keyboard and a screen reader. */}
                      <label className={styles.moveLabel}>
                        <span className={styles.srOnly}>
                          {t('crm.moveLabel', { deal: deal.title })}
                        </span>
                        <select
                          className={styles.moveSelect}
                          value={column.stage}
                          disabled={busy}
                          onChange={(event) =>
                            void move(deal.recordId, event.target.value as DealStage)
                          }
                          data-testid={`crm-move-${deal.recordId}`}
                        >
                          {DEAL_STAGES.map((stage) => (
                            <option key={stage} value={stage}>
                              {t(`crm.stage.${stage}` as never)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {column.stage === 'won' ? (
                        <Button
                          variant="ghost"
                          onClick={() => void toQuote(deal.recordId)}
                          disabled={busy}
                          data-testid={`crm-to-quote-${deal.recordId}`}
                        >
                          {t('crm.toQuote')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
                {column.deals.length === 0 ? (
                  <li className={styles.empty}>{t('crm.emptyStage')}</li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      </WorkspaceSection>
        </>
      ) : null}

      <RecordPanel
        orgId={activeOrgId}
        recordId={openRecordId}
        onClose={() => setOpenRecordId(null)}
        onChanged={() => void load()}
        onOpenRecord={setOpenRecordId}
      />
    </WorkspacePage>
  );
}
