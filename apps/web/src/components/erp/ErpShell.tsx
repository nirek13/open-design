// One ERP surface in the product: every former top-level business module
// (hub, books, CRM, …) lives here as an internal tab, plus NetSuite.

import { useMemo } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import { navigate } from '../../router';
import { Icon, type IconName } from '../Icon';
import { ApprovalsView } from '../approvals/ApprovalsView';
import { BooksView } from '../books/BooksView';
import { TablesView } from '../grid/TablesView';
import { CrmView } from '../crm/CrmView';
import { PurchasingView } from '../purchasing/PurchasingView';
import { InventoryView } from '../inventory/InventoryView';
import { ProjectsView } from '../projects/ProjectsView';
import { TemplatesView } from '../templates/TemplatesView';
import styles from './ErpShell.module.css';

export type ErpModule =
  | 'hub'
  | 'approvals'
  | 'books'
  | 'tables'
  | 'crm'
  | 'purchasing'
  | 'inventory'
  | 'jobs'
  | 'templates'
  | 'connections'
  | 'netsuite';

/** Entry-shell views that belong inside the ERP shell. */
export const ERP_ENTRY_VIEWS = [
  'approvals',
  'books',
  'tables',
  'crm',
  'purchasing',
  'inventory',
  'jobs',
  'templates',
  'erp',
] as const;

export type ErpEntryView = (typeof ERP_ENTRY_VIEWS)[number];

export function isErpEntryView(view: string): view is ErpEntryView {
  return (ERP_ENTRY_VIEWS as readonly string[]).includes(view);
}

export function erpModuleFromView(view: string): ErpModule {
  switch (view) {
    case 'approvals':
      return 'approvals';
    case 'books':
      return 'books';
    case 'tables':
      return 'tables';
    case 'crm':
      return 'crm';
    case 'purchasing':
      return 'purchasing';
    case 'inventory':
      return 'inventory';
    case 'jobs':
      return 'jobs';
    case 'templates':
      return 'templates';
    case 'connections':
      return 'connections';
    case 'erp':
    default:
      return 'netsuite';
  }
}

export function viewFromErpModule(module: ErpModule): ErpEntryView {
  switch (module) {
    case 'hub':
      return 'books';
    case 'netsuite':
      return 'erp';
    case 'connections':
      return 'erp';
    default:
      return module;
  }
}

const MODULES: Array<{ id: ErpModule; icon: IconName; labelKey: keyof import('../../i18n/types').Dict }> = [
  { id: 'approvals', icon: 'check', labelKey: 'erp.module.approvals' },
  { id: 'books', icon: 'file-text', labelKey: 'erp.module.books' },
  { id: 'crm', icon: 'handshake', labelKey: 'erp.module.crm' },
  { id: 'purchasing', icon: 'truck', labelKey: 'erp.module.purchasing' },
  { id: 'inventory', icon: 'layers-filled', labelKey: 'erp.module.inventory' },
  { id: 'jobs', icon: 'kanban', labelKey: 'erp.module.jobs' },
  { id: 'tables', icon: 'layout', labelKey: 'erp.module.tables' },
  { id: 'templates', icon: 'blocks', labelKey: 'erp.module.templates' },
  { id: 'netsuite', icon: 'orbit', labelKey: 'erp.module.netsuite' },
];

interface Props {
  module: ErpModule;
  active: boolean;
  onModuleChange?: (module: ErpModule) => void;
  initialTableName?: string;
}

function NetSuitePanel({ active }: { active: boolean }) {
  const t = useT();
  if (!active) return null;
  return (
    <div className={styles.netsuite} data-testid="erp-netsuite">
      <div className={styles.netsuiteCard}>
        <Icon name="orbit" size={28} />
        <h2>{t('erp.netsuite.title')}</h2>
        <p>{t('erp.netsuite.body')}</p>
        <div className={styles.netsuiteActions}>
          <Button
            onClick={() => navigate({ kind: 'home', view: 'integrations' })}
          >
            {t('erp.netsuite.connect')}
          </Button>
        </div>
        <ul className={styles.netsuiteList}>
          <li>{t('erp.netsuite.bullet1')}</li>
          <li>{t('erp.netsuite.bullet2')}</li>
          <li>{t('erp.netsuite.bullet3')}</li>
        </ul>
      </div>
    </div>
  );
}

export function ErpShell({ module, active, onModuleChange, initialTableName }: Props) {
  const t = useT();
  const modules = useMemo(
    () =>
      MODULES.map((item) => ({
        ...item,
        label: t(item.labelKey),
      })),
    [t],
  );

  const select = (next: ErpModule) => {
    onModuleChange?.(next);
    navigate({ kind: 'home', view: viewFromErpModule(next) });
  };

  return (
    <div className={styles.shell} data-testid="erp-shell" data-active={active ? 'true' : 'false'}>
      <aside className={styles.nav} aria-label={t('entry.navErp')}>
        <div className={styles.navHead}>
          <span className={styles.navTitle}>{t('entry.navErp')}</span>
          <span className={styles.navSub}>{t('erp.shell.subtitle')}</span>
        </div>
        <div className={styles.navList} role="tablist" aria-orientation="vertical">
          {modules.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={module === item.id}
              className={`${styles.navItem}${module === item.id ? ` ${styles.navItemActive}` : ''}`}
              onClick={() => select(item.id)}
              data-testid={`erp-module-${item.id}`}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className={styles.main}>
        {module === 'approvals' ? <ApprovalsView active={active && module === 'approvals'} /> : null}
        {module === 'books' ? <BooksView active={active && module === 'books'} /> : null}
        {module === 'tables' ? (
          <TablesView
            active={active && module === 'tables'}
            {...(initialTableName ? { initialTableName } : {})}
          />
        ) : null}
        {module === 'crm' ? <CrmView active={active && module === 'crm'} /> : null}
        {module === 'purchasing' ? <PurchasingView active={active && module === 'purchasing'} /> : null}
        {module === 'inventory' ? <InventoryView active={active && module === 'inventory'} /> : null}
        {module === 'jobs' ? <ProjectsView active={active && module === 'jobs'} /> : null}
        {module === 'templates' ? <TemplatesView active={active && module === 'templates'} /> : null}
        {module === 'netsuite' ? <NetSuitePanel active={active && module === 'netsuite'} /> : null}
      </div>
    </div>
  );
}
