// Stock.
//
// On hand is summed from movements every time it is asked for — there is no
// stored count anywhere. The screen leads with what is short, because the only
// reason anyone opens a stock screen unprompted is to find out what to buy.
//
// Rows open the record panel, so this is a place to work rather than a report
// to read: click a product, edit its reorder point, see its movements.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type { StockLevel, StockSummary } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { fetchErpTemplates, fetchStock, installErpTemplate } from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { DataTable, type Column } from '../workspace/DataTable';
import { StatCard } from '../workspace/StatCard';
import { RecordPanel } from '../record/RecordPanel';
import { formatMoney } from '../workspace/format';
import styles from './InventoryView.module.css';

interface Props {
  active: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function InventoryView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [stock, setStock] = useState<StockSummary | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const templates = await fetchErpTemplates(activeOrgId);
      const pack = templates.find((template) => template.templateId === 'inventory');
      setInstalled(Boolean(pack?.installed));
      if (!pack?.installed) {
        setStock(null);
        setError(null);
        return;
      }
      setStock(await fetchStock(activeOrgId));
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
      await installErpTemplate(activeOrgId, 'inventory');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, load]);

  const columns: Column<StockLevel>[] = [
    { key: 'sku', header: t('inventory.sku'), cell: (row) => row.sku },
    { key: 'name', header: t('inventory.product'), cell: (row) => row.name },
    {
      key: 'onHand',
      header: t('inventory.onHand'),
      align: 'end',
      cell: (row) => (
        <span className={row.belowReorderPoint ? styles.short : undefined}>{row.onHand}</span>
      ),
    },
    {
      key: 'reorder',
      header: t('inventory.reorderAt'),
      align: 'end',
      secondary: true,
      cell: (row) => (row.reorderPoint === null ? '—' : row.reorderPoint),
    },
    {
      key: 'unitCost',
      header: t('inventory.unitCost'),
      align: 'end',
      secondary: true,
      cell: (row) => formatMoney(row.unitCost),
    },
    {
      key: 'value',
      header: t('inventory.value'),
      align: 'end',
      cell: (row) => <strong>{formatMoney(row.stockValue)}</strong>,
    },
    {
      key: 'flag',
      header: t('inventory.status'),
      cell: (row) =>
        row.belowReorderPoint ? (
          <Badge tone="warning">{t('inventory.reorder')}</Badge>
        ) : (
          <span className={styles.muted}>{t('inventory.ok')}</span>
        ),
    },
  ];

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('inventory.title')} testId="inventory-view">
        <EmptyState title={t('inventory.noOrg')} />
      </WorkspacePage>
    );
  }

  if (installed === false) {
    return (
      <WorkspacePage title={t('inventory.title')} lead={t('inventory.lead')} testId="inventory-view">
        <WorkspaceSection>
          <EmptyState
            title={t('inventory.setUpTitle')}
            description={t('inventory.setUpBody')}
            action={
              can('admin') ? (
                <Button onClick={install} disabled={busy} data-testid="inventory-install">
                  {busy ? t('inventory.installing') : t('inventory.setUpAction')}
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
      <WorkspacePage title={t('inventory.title')} testId="inventory-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      title={t('inventory.title')}
      lead={t('inventory.lead')}
      testId="inventory-view"
      actions={
        <Button variant="ghost" onClick={() => void load()} disabled={busy}>
          {t('inventory.refresh')}
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
            label={t('inventory.totalValue')}
            value={formatMoney(stock?.totalValue ?? 0)}
            detail={t('inventory.acrossProducts', { count: String(stock?.levels.length ?? 0) })}
            testId="inventory-value"
          />
          <StatCard
            label={t('inventory.needsReorder')}
            value={String(stock?.needsReorder ?? 0)}
            tone={stock?.needsReorder ? 'warning' : 'default'}
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection title={t('inventory.levels')}>
        {stock && stock.levels.length > 0 ? (
          <DataTable
            columns={columns}
            rows={stock.levels}
            rowKey={(row) => row.productId}
            onRowClick={(row) => setOpenRecordId(row.productId)}
            testId="inventory-table"
          />
        ) : (
          <EmptyState title={t('inventory.noProducts')} description={t('inventory.noProductsBody')} />
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
