// Purchasing: what we owe, and to whom.
//
// The payables table leads with what is overdue, because that is the only
// reason anyone opens this screen unprompted. Outstanding is billed minus
// paid, computed by the daemon from the payments themselves rather than read
// off a stored balance — so a payment recorded anywhere shows up here.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type { PayablesRow, PayablesSummary } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { fetchErpTemplates, fetchPayables, installErpTemplate } from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { DataTable, type Column } from '../workspace/DataTable';
import { StatCard } from '../workspace/StatCard';
import { RecordPanel } from '../record/RecordPanel';
import { formatDate, formatMoney } from '../workspace/format';
import styles from './PurchasingView.module.css';

interface Props {
  active: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PurchasingView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [payables, setPayables] = useState<PayablesSummary | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const templates = await fetchErpTemplates(activeOrgId);
      const pack = templates.find((template) => template.templateId === 'purchasing');
      setInstalled(Boolean(pack?.installed));
      if (!pack?.installed) {
        setPayables(null);
        setError(null);
        return;
      }
      setPayables(await fetchPayables(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const install = useCallback(async () => {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await installErpTemplate(activeOrgId, 'purchasing');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, load]);

  const columns: Column<PayablesRow>[] = [
    { key: 'billNumber', header: t('purchasing.bill'), cell: (row) => row.billNumber },
    { key: 'vendor', header: t('purchasing.vendor'), cell: (row) => row.vendorName ?? '—' },
    {
      key: 'issued',
      header: t('purchasing.issued'),
      secondary: true,
      cell: (row) => formatDate(row.issueDate),
    },
    { key: 'due', header: t('purchasing.due'), cell: (row) => formatDate(row.dueDate) },
    {
      key: 'total',
      header: t('purchasing.total'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.total),
    },
    {
      key: 'paid',
      header: t('purchasing.paid'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.paid),
    },
    {
      key: 'outstanding',
      header: t('purchasing.outstanding'),
      align: 'end',
      cell: (row) => <strong>{formatMoney(row.outstanding)}</strong>,
    },
    {
      key: 'age',
      header: t('purchasing.age'),
      cell: (row) =>
        row.daysOverdue > 0 ? (
          <Badge tone="danger">{t('purchasing.overdueDays', { days: String(row.daysOverdue) })}</Badge>
        ) : (
          <span className={styles.muted}>{t('purchasing.notDue')}</span>
        ),
    },
  ];

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('purchasing.title')} testId="purchasing-view">
        <EmptyState title={t('purchasing.noOrg')} />
      </WorkspacePage>
    );
  }

  if (installed === false) {
    return (
      <WorkspacePage
        title={t('purchasing.title')}
        lead={t('purchasing.lead')}
        testId="purchasing-view"
      >
        <WorkspaceSection>
          <EmptyState
            title={t('purchasing.setUpTitle')}
            description={t('purchasing.setUpBody')}
            action={
              can('admin') ? (
                <Button onClick={install} disabled={busy} data-testid="purchasing-install">
                  {busy ? t('purchasing.installing') : t('purchasing.setUpAction')}
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
      <WorkspacePage title={t('purchasing.title')} testId="purchasing-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      title={t('purchasing.title')}
      lead={t('purchasing.lead')}
      testId="purchasing-view"
      actions={
        <Button variant="ghost" onClick={() => void load()} disabled={busy}>
          {t('purchasing.refresh')}
        </Button>
      }
    >
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <WorkspaceSection>
        <div className={styles.stats}>
          <StatCard
            label={t('purchasing.totalOutstanding')}
            value={formatMoney(payables?.totalOutstanding ?? 0)}
            detail={t('purchasing.acrossBills', {
              count: String(payables?.rows.length ?? 0),
            })}
            testId="purchasing-outstanding"
          />
          <StatCard
            label={t('purchasing.totalOverdue')}
            value={formatMoney(payables?.totalOverdue ?? 0)}
            tone={payables?.totalOverdue ? 'danger' : 'default'}
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection title={t('purchasing.payables')}>
        {payables && payables.rows.length > 0 ? (
          <DataTable
            columns={columns}
            rows={payables.rows}
            rowKey={(row) => row.recordId}
            onRowClick={(row) => setOpenRecordId(row.recordId)}
            testId="purchasing-payables-table"
          />
        ) : (
          <EmptyState
            title={t('purchasing.nothingOwed')}
            description={t('purchasing.nothingOwedBody')}
          />
        )}
      </WorkspaceSection>

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
