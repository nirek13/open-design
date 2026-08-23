// Projects.
//
// Over-budget first, because that is the row someone has to do something
// about today. Billable value is priced per time entry at that entry's own
// rate, never from an average — two people on one project bill differently,
// and an average is a number that looks precise and is wrong.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type { ErpProjectSummaryRow, ErpProjectsSummary } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchErpTemplates,
  fetchProjectsSummary,
  installErpTemplate,
} from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { DataTable, type Column } from '../workspace/DataTable';
import { StatCard } from '../workspace/StatCard';
import { RecordPanel } from '../record/RecordPanel';
import { formatMoney } from '../workspace/format';
import styles from './ProjectsView.module.css';

interface Props {
  active: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ProjectsView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [summary, setSummary] = useState<ErpProjectsSummary | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const templates = await fetchErpTemplates(activeOrgId);
      const pack = templates.find((template) => template.templateId === 'projects');
      setInstalled(Boolean(pack?.installed));
      if (!pack?.installed) {
        setSummary(null);
        setError(null);
        return;
      }
      setSummary(await fetchProjectsSummary(activeOrgId));
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
      await installErpTemplate(activeOrgId, 'projects');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, load]);

  const columns: Column<ErpProjectSummaryRow>[] = [
    { key: 'name', header: t('projects.project'), cell: (row) => row.name },
    {
      key: 'customer',
      header: t('projects.customer'),
      secondary: true,
      cell: (row) => row.customerName ?? '—',
    },
    { key: 'status', header: t('projects.status'), cell: (row) => <Badge tone="neutral">{row.status}</Badge> },
    {
      key: 'tasks',
      header: t('projects.tasks'),
      align: 'end',
      secondary: true,
      cell: (row) => `${row.taskCount - row.openTaskCount}/${row.taskCount}`,
    },
    { key: 'hours', header: t('projects.hours'), align: 'end', cell: (row) => row.hours },
    {
      key: 'billable',
      header: t('projects.billable'),
      align: 'end',
      cell: (row) => formatMoney(row.billableValue),
    },
    {
      key: 'budget',
      header: t('projects.budget'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.budget),
    },
    {
      key: 'remaining',
      header: t('projects.remaining'),
      align: 'end',
      cell: (row) =>
        row.budgetRemaining < 0 ? (
          <Badge tone="danger">{formatMoney(row.budgetRemaining)}</Badge>
        ) : (
          <strong>{formatMoney(row.budgetRemaining)}</strong>
        ),
    },
  ];

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('projects.title')} testId="projects-view">
        <EmptyState title={t('projects.noOrg')} />
      </WorkspacePage>
    );
  }

  if (installed === false) {
    return (
      <WorkspacePage title={t('projects.title')} lead={t('projects.lead')} testId="projects-view">
        <WorkspaceSection>
          <EmptyState
            title={t('projects.setUpTitle')}
            description={t('projects.setUpBody')}
            action={
              can('admin') ? (
                <Button onClick={install} disabled={busy} data-testid="projects-install">
                  {busy ? t('projects.installing') : t('projects.setUpAction')}
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
      <WorkspacePage title={t('projects.title')} testId="projects-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      title={t('projects.title')}
      lead={t('projects.lead')}
      testId="projects-view"
      actions={
        <Button variant="ghost" onClick={() => void load()} disabled={busy}>
          {t('projects.refresh')}
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
            label={t('projects.totalHours')}
            value={String(summary?.totalHours ?? 0)}
            detail={t('projects.acrossProjects', { count: String(summary?.projects.length ?? 0) })}
            testId="projects-hours"
          />
          <StatCard
            label={t('projects.totalBillable')}
            value={formatMoney(summary?.totalBillableValue ?? 0)}
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection title={t('projects.all')}>
        {summary && summary.projects.length > 0 ? (
          <DataTable
            columns={columns}
            rows={summary.projects}
            rowKey={(row) => row.projectId}
            onRowClick={(row) => setOpenRecordId(row.projectId)}
            testId="projects-table"
          />
        ) : (
          <EmptyState title={t('projects.none')} description={t('projects.noneBody')} />
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
