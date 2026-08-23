// The template gallery.
//
// This is what makes the ERP "templated" rather than a fixed set of screens:
// every pack in the registry lists itself here, so adding a pack in contracts
// gives it a UI surface without anyone writing one. The CLI gets the same
// deal through `od erp template install`.
//
// Installing is presented as safe because it is: a table that already exists
// is left exactly as the organization has customized it, which is why there is
// no confirmation dialog and why "Add" stays available on an installed pack —
// re-running it is how you pick up a table a pack has gained since.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type { ErpTemplateId, TemplateStatus } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { fetchErpTemplates, installErpTemplate } from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import styles from './TemplatesView.module.css';

interface Props {
  active: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TemplatesView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [templates, setTemplates] = useState<TemplateStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installing, setInstalling] = useState<ErpTemplateId | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setTemplates(await fetchErpTemplates(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const install = useCallback(
    async (templateId: ErpTemplateId) => {
      if (!activeOrgId) return;
      setInstalling(templateId);
      try {
        const results = await installErpTemplate(activeOrgId, templateId);
        const created = results.flatMap((result) => result.created);
        setNotice(
          created.length
            ? t('templates.installedTables', { tables: created.join(', ') })
            : t('templates.nothingNew'),
        );
        await load();
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setInstalling(null);
      }
    },
    [activeOrgId, load, t],
  );

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('templates.title')} testId="templates-view">
        <EmptyState title={t('templates.noOrg')} />
      </WorkspacePage>
    );
  }

  if (!templates) {
    return (
      <WorkspacePage title={t('templates.title')} testId="templates-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      title={t('templates.title')}
      lead={t('templates.lead')}
      testId="templates-view"
      actions={
        <Button variant="ghost" onClick={() => void load()}>
          {t('templates.refresh')}
        </Button>
      }
    >
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

      <WorkspaceSection>
        <ul className={styles.grid} data-testid="templates-grid">
          {templates.map((template) => {
            const missing = template.tables.filter((table) => !table.present);
            const busy = installing === template.templateId;
            return (
              <li
                key={template.templateId}
                className={styles.card}
                data-testid={`template-${template.templateId}`}
              >
                <header className={styles.cardHead}>
                  <h3 className={styles.cardTitle}>{template.displayName}</h3>
                  {template.installed ? (
                    <Badge tone="positive">{t('templates.installed')}</Badge>
                  ) : missing.length < template.tables.length ? (
                    // Partly there: usually a pack that gained a table after
                    // this organization installed it.
                    <Badge tone="warning">
                      {t('templates.partial', { count: String(missing.length) })}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{t('templates.notInstalled')}</Badge>
                  )}
                </header>

                <p className={styles.cardBody}>{template.description}</p>

                <ul className={styles.tableList}>
                  {template.tables.map((table) => (
                    <li
                      key={table.name}
                      className={table.present ? styles.tablePresent : styles.tableMissing}
                    >
                      {table.displayName}
                      {table.present && table.recordCount > 0 ? (
                        <span className={styles.recordCount}> · {table.recordCount}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {template.requires.length > 0 ? (
                  <p className={styles.requires}>
                    {t('templates.requires', { packs: template.requires.join(', ') })}
                  </p>
                ) : null}

                <div className={styles.cardActions}>
                  {can('admin') ? (
                    <Button
                      onClick={() => void install(template.templateId)}
                      disabled={busy || template.installed}
                      data-testid={`template-install-${template.templateId}`}
                    >
                      {busy
                        ? t('templates.installing')
                        : template.installed
                          ? t('templates.alreadyAdded')
                          : t('templates.add')}
                    </Button>
                  ) : (
                    <span className={styles.adminOnly}>{t('templates.adminOnly')}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </WorkspaceSection>

      <WorkspaceSection>
        <p className={styles.footnote}>{t('templates.safetyNote')}</p>
      </WorkspaceSection>
    </WorkspacePage>
  );
}
