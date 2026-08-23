// Work-day systems the ERP can connect through Composio (Gmail, Notion, Slack, …).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, EmptyState } from '@open-design/components';
import type { ConnectorDetail } from '@open-design/contracts';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { connectConnector } from '../../providers/registry';
import { fetchConnectorCatalogSnapshot } from '../connectors-state';
import { navigate } from '../../router';
import styles from './ErpShell.module.css';

type WorkGroup = 'mail' | 'calendar' | 'docs' | 'chat' | 'crm' | 'finance' | 'work';

const WORKDAY_GROUPS: Array<{ id: WorkGroup; connectorIds: string[] }> = [
  { id: 'mail', connectorIds: ['gmail', 'outlook', 'zohomail'] },
  { id: 'calendar', connectorIds: ['googlecalendar', 'calendly', 'cal', 'zoom'] },
  { id: 'docs', connectorIds: ['notion', 'googledocs', 'googlesheets', 'google_drive', 'dropbox', 'confluence'] },
  { id: 'chat', connectorIds: ['slack', 'microsoftteams', 'googlechat', 'discord'] },
  { id: 'crm', connectorIds: ['hubspot', 'salesforce', 'pipedrive', 'intercom', 'zendesk'] },
  { id: 'finance', connectorIds: ['stripe', 'quickbooks', 'xero', 'square', 'netsuite'] },
  { id: 'work', connectorIds: ['linear', 'jira', 'asana', 'todoist', 'clickup', 'monday', 'github'] },
];

const WORKDAY_IDS = new Set(WORKDAY_GROUPS.flatMap((group) => group.connectorIds));

const GROUP_KEYS: Record<WorkGroup, keyof Dict> = {
  mail: 'erp.connections.group.mail',
  calendar: 'erp.connections.group.calendar',
  docs: 'erp.connections.group.docs',
  chat: 'erp.connections.group.chat',
  crm: 'erp.connections.group.crm',
  finance: 'erp.connections.group.finance',
  work: 'erp.connections.group.work',
};

interface Props {
  active: boolean;
}

export function ErpConnections({ active }: Props) {
  const t = useT();
  const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchConnectorCatalogSnapshot({ refreshDiscovery: true });
      setConnectors(rows.filter((row) => WORKDAY_IDS.has(row.id)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void reload();
  }, [active, reload]);

  const byId = useMemo(() => {
    const map = new Map<string, ConnectorDetail>();
    for (const row of connectors) map.set(row.id, row);
    return map;
  }, [connectors]);

  async function onConnect(connectorId: string) {
    setBusyId(connectorId);
    setError(null);
    try {
      const result = await connectConnector(connectorId);
      if (result.error) {
        setError(result.error);
        return;
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!active) return null;

  const connectedCount = connectors.filter((row) => row.status === 'connected').length;

  return (
    <div className={styles.connections} data-testid="erp-connections">
      <header className={styles.connectionsHero}>
        <div>
          <h1>{t('erp.connections.title')}</h1>
          <p>{t('erp.connections.body')}</p>
        </div>
        <Button variant="ghost" onClick={() => navigate({ kind: 'home', view: 'integrations' })}>
          {t('erp.connections.browseAll')}
        </Button>
      </header>
      {error ? <p className={styles.connectionsError} role="alert">{error}</p> : null}
      {loading && connectors.length === 0 ? (
        <EmptyState title={t('erp.connections.loading')} />
      ) : null}
      {WORKDAY_GROUPS.map((group) => {
        const rows = group.connectorIds
          .map((id) => byId.get(id))
          .filter((row): row is ConnectorDetail => Boolean(row));
        if (rows.length === 0) return null;
        return (
          <section key={group.id} className={styles.connectionGroup}>
            <h2>{t(GROUP_KEYS[group.id])}</h2>
            <ul className={styles.connectionList}>
              {rows.map((row) => {
                const connected = row.status === 'connected';
                const busy = busyId === row.id;
                return (
                  <li key={row.id} className={styles.connectionCard}>
                    <div>
                      <strong>{row.name}</strong>
                      <p>{row.description}</p>
                    </div>
                    {connected ? (
                      <span className={styles.connectionOk}>{t('erp.connections.connected')}</span>
                    ) : (
                      <Button
                        variant="subtle"
                        disabled={busy}
                        onClick={() => void onConnect(row.id)}
                      >
                        {busy ? t('erp.connections.connecting') : t('erp.connections.connect')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className={styles.connectionsMeta}>
        {t('erp.connections.connectedCount', { count: String(connectedCount) })}
      </p>
    </div>
  );
}
