// Workspace Database surface: the permanent, structured company data that
// every generated tool is a view over. Tables are rigid (typed fields,
// required/unique constraints, links); records soft-delete and keep full
// revision history; every mutation lands in an append-only audit trail.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type {
  JsonValue,
  WorkspaceAuditEvent,
  WorkspaceFieldInput,
  WorkspaceFieldType,
  WorkspaceRecord,
  WorkspaceRecordRevision,
  WorkspaceTable,
} from '@open-design/contracts';
import { WORKSPACE_FIELD_TYPES } from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  createWorkspaceRecord,
  createWorkspaceTable,
  fetchWorkspaceAuditEvents,
  fetchWorkspaceRecordRevisions,
  fetchWorkspaceTables,
  queryWorkspaceRecords,
  restoreWorkspaceRecord,
  softDeleteWorkspaceRecord,
} from '../../providers/registry';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import styles from './DatabaseView.module.css';

interface Props {
  active: boolean;
}

const EMPTY_FIELD: WorkspaceFieldInput = { name: '', type: 'text' };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function DatabaseView({ active }: Props) {
  const t = useT();
  // The database belongs to the active organization — there is no separate
  // workspace to choose. Switching organizations swaps the whole database.
  const { activeOrgId: workspaceId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [revisions, setRevisions] = useState<WorkspaceRecordRevision[]>([]);
  const [auditEvents, setAuditEvents] = useState<WorkspaceAuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showTableForm, setShowTableForm] = useState(false);
  const [tableName, setTableName] = useState('');
  const [fields, setFields] = useState<WorkspaceFieldInput[]>([{ ...EMPTY_FIELD }]);

  const [showRecordForm, setShowRecordForm] = useState(false);
  const [recordDraft, setRecordDraft] = useState<Record<string, string>>({});

  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? null,
    [tables, selectedTableId],
  );

  const loadTables = useCallback(
    async (wsId: string) => {
      try {
        const list = await fetchWorkspaceTables(wsId);
        setTables(list);
        setSelectedTableId((current) =>
          current && list.some((table) => table.id === current) ? current : (list[0]?.id ?? null),
        );
      } catch (err) {
        setError(`${t('database.loadError')} ${errorMessage(err)}`);
      }
    },
    [t],
  );

  const loadRecords = useCallback(
    async (wsId: string, tableId: string) => {
      try {
        const page = await queryWorkspaceRecords(wsId, tableId, { includeDeleted, limit: 100 });
        setRecords(page.records);
        const audit = await fetchWorkspaceAuditEvents(wsId, { tableId, limit: 20 });
        setAuditEvents(audit.events);
        setError(null);
      } catch (err) {
        setError(`${t('database.loadError')} ${errorMessage(err)}`);
      }
    },
    [includeDeleted, t],
  );

  useEffect(() => {
    if (!active || !workspaceId) return;
    void loadTables(workspaceId);
  }, [active, workspaceId, loadTables]);

  useEffect(() => {
    if (!active || !workspaceId || !selectedTableId) {
      setRecords([]);
      return;
    }
    void loadRecords(workspaceId, selectedTableId);
  }, [active, workspaceId, selectedTableId, loadRecords]);

  // Live refresh: any write anywhere in the workspace (UI, CLI, agent tool,
  // public form) publishes on the daemon's data event stream.
  useEffect(() => {
    if (!active || !workspaceId) return;
    const source = new EventSource('/api/data/events');
    const onChange = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { workspaceId: string; tableId: string };
        if (payload.workspaceId === workspaceId && payload.tableId === selectedTableId) {
          void loadRecords(workspaceId, payload.tableId);
        }
      } catch {
        // ignore malformed frames
      }
    };
    source.addEventListener('record-change', onChange as EventListener);
    return () => {
      source.removeEventListener('record-change', onChange as EventListener);
      source.close();
    };
  }, [active, workspaceId, selectedTableId, loadRecords]);

  async function handleCreateTable() {
    if (!workspaceId) return;
    try {
      const table = await createWorkspaceTable(workspaceId, {
        name: tableName.trim(),
        fields: fields.filter((field) => field.name.trim()),
      });
      setShowTableForm(false);
      setTableName('');
      setFields([{ ...EMPTY_FIELD }]);
      await loadTables(workspaceId);
      setSelectedTableId(table.id);
    } catch (err) {
      setError(`${t('database.saveError')}: ${errorMessage(err)}`);
    }
  }

  async function handleCreateRecord() {
    if (!workspaceId || !selectedTable) return;
    // Text inputs are coerced per the field's declared type; the daemon
    // re-validates and rejects anything that does not match the schema.
    const data: Record<string, JsonValue> = {};
    for (const field of selectedTable.fields) {
      const raw = recordDraft[field.name];
      if (raw === undefined || raw === '') continue;
      if (field.type === 'boolean') data[field.name] = raw === 'true';
      else if (field.type === 'number' || field.type === 'integer' || field.type === 'money' || field.type === 'datetime') {
        data[field.name] = Number(raw);
      } else if (field.type === 'json') {
        try {
          data[field.name] = JSON.parse(raw);
        } catch {
          setError(`${t('database.saveError')}: ${field.name} must be valid JSON`);
          return;
        }
      } else data[field.name] = raw;
    }
    try {
      await createWorkspaceRecord(workspaceId, selectedTable.id, { data });
      setRecordDraft({});
      setShowRecordForm(false);
      await loadRecords(workspaceId, selectedTable.id);
    } catch (err) {
      setError(`${t('database.saveError')}: ${errorMessage(err)}`);
    }
  }

  async function handleToggleDelete(record: WorkspaceRecord) {
    if (!workspaceId || !selectedTableId) return;
    try {
      if (record.deletedAt === null) await softDeleteWorkspaceRecord(workspaceId, record.id);
      else await restoreWorkspaceRecord(workspaceId, record.id);
      await loadRecords(workspaceId, selectedTableId);
    } catch (err) {
      setError(`${t('database.saveError')}: ${errorMessage(err)}`);
    }
  }

  async function handleShowHistory(record: WorkspaceRecord) {
    if (!workspaceId) return;
    try {
      setRevisions(await fetchWorkspaceRecordRevisions(workspaceId, record.id));
    } catch (err) {
      setError(`${t('database.loadError')} ${errorMessage(err)}`);
    }
  }

  return (
    <div className="entry-section" data-testid="database-view">
      <header className="entry-section__head">
        <h1 className="entry-section__title">{t('database.title')}</h1>
        <p className="entry-section__subtitle">{t('database.subtitle')}</p>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>{t('database.tables')}</span>
            <Button variant="ghost" onClick={() => setShowTableForm((open) => !open)} data-testid="database-new-table">
              {t('database.newTable')}
            </Button>
          </div>
          {tables.length === 0 ? (
            <p className={styles.empty}>{t('database.noTables')}</p>
          ) : (
            <ul className={styles.tableList}>
              {tables.map((table) => (
                <li key={table.id}>
                  <button
                    type="button"
                    className={`${styles.tableBtn}${table.id === selectedTableId ? ` ${styles.tableBtnActive}` : ''}`}
                    onClick={() => setSelectedTableId(table.id)}
                  >
                    <span className={styles.tableBtnName}>{table.displayName || table.name}</span>
                    <span className={styles.tableBtnMeta}>
                      {table.fields.length} · v{table.schemaVersion}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {showTableForm ? (
            <div className={styles.form}>
              <Input
                type="text"
                value={tableName}
                placeholder={t('database.tableName')}
                onChange={(event) => setTableName(event.target.value)}
                data-testid="database-table-name"
              />
              {fields.map((field, index) => (
                <div key={index} className={styles.formRow}>
                  <Input
                    type="text"
                    value={field.name}
                    placeholder={t('database.fieldName')}
                    onChange={(event) => {
                      const next = [...fields];
                      next[index] = { ...field, name: event.target.value };
                      setFields(next);
                    }}
                  />
                  <Select
                    value={field.type}
                    aria-label={t('database.fieldType')}
                    onChange={(event) => {
                      const next = [...fields];
                      next[index] = { ...field, type: event.target.value as WorkspaceFieldType };
                      setFields(next);
                    }}
                  >
                    {WORKSPACE_FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>
                  <label>
                    <input
                      type="checkbox"
                      checked={field.required ?? false}
                      onChange={(event) => {
                        const next = [...fields];
                        next[index] = { ...field, required: event.target.checked };
                        setFields(next);
                      }}
                    />
                    {t('database.required')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={field.unique ?? false}
                      onChange={(event) => {
                        const next = [...fields];
                        next[index] = { ...field, unique: event.target.checked };
                        setFields(next);
                      }}
                    />
                    {t('database.unique')}
                  </label>
                </div>
              ))}
              <div className={styles.formRow}>
                <Button variant="ghost" onClick={() => setFields([...fields, { ...EMPTY_FIELD }])}>
                  {t('database.addField')}
                </Button>
                <Button variant="primary" onClick={handleCreateTable} disabled={!tableName.trim()}>
                  {t('database.createTable')}
                </Button>
              </div>
            </div>
          ) : null}
        </aside>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>
              {selectedTable ? selectedTable.displayName || selectedTable.name : t('database.records')}
            </h2>
            <div className={styles.panelActions}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(event) => setIncludeDeleted(event.target.checked)}
                />
                {t('database.showDeleted')}
              </label>
              <Button
                onClick={() => setShowRecordForm((open) => !open)}
                disabled={!selectedTable}
                data-testid="database-add-record"
              >
                {t('database.addRecord')}
              </Button>
            </div>
          </div>

          {showRecordForm && selectedTable ? (
            <div className={styles.form}>
              {selectedTable.fields.map((field) => (
                <div key={field.id} className={styles.formRow}>
                  <label htmlFor={`od-db-field-${field.id}`}>
                    {field.displayName || field.name}
                    {field.required ? ' *' : ''}
                  </label>
                  {field.type === 'select' ? (
                    <Select
                      id={`od-db-field-${field.id}`}
                      value={recordDraft[field.name] ?? ''}
                      onChange={(event) =>
                        setRecordDraft({ ...recordDraft, [field.name]: event.target.value })
                      }
                    >
                      <option value="">—</option>
                      {(field.config?.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  ) : field.type === 'boolean' ? (
                    <Select
                      id={`od-db-field-${field.id}`}
                      value={recordDraft[field.name] ?? ''}
                      onChange={(event) =>
                        setRecordDraft({ ...recordDraft, [field.name]: event.target.value })
                      }
                    >
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      id={`od-db-field-${field.id}`}
                      type="text"
                      value={recordDraft[field.name] ?? ''}
                      onChange={(event) =>
                        setRecordDraft({ ...recordDraft, [field.name]: event.target.value })
                      }
                    />
                  )}
                </div>
              ))}
              <div className={styles.formRow}>
                <Button variant="primary" onClick={handleCreateRecord}>
                  {t('database.create')}
                </Button>
              </div>
            </div>
          ) : null}

          {selectedTable && records.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.grid}>
                <thead>
                  <tr>
                    {selectedTable.fields.map((field) => (
                      <th key={field.id} scope="col">
                        {field.displayName || field.name}
                      </th>
                    ))}
                    <th scope="col">{t('database.revision')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className={record.deletedAt ? styles.rowDeleted : undefined}>
                      {selectedTable.fields.map((field) => (
                        <td key={field.id}>{formatCell(record.data[field.name])}</td>
                      ))}
                      <td>
                        {record.revision}
                        {record.deletedAt ? <span className={styles.badge}>{t('database.deleted')}</span> : null}
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          <Button variant="ghost" onClick={() => handleShowHistory(record)}>
                            {t('database.history')}
                          </Button>
                          <Button variant="ghost" onClick={() => handleToggleDelete(record)}>
                            {record.deletedAt ? t('database.restore') : t('database.delete')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty}>{selectedTable ? t('database.noRecords') : t('database.noTables')}</p>
          )}

          {revisions.length > 0 ? (
            <div className={styles.drawer}>
              <span className={styles.drawerTitle}>{t('database.history')}</span>
              <ul className={styles.timeline}>
                {revisions.map((revision) => (
                  <li key={revision.id} className={styles.timelineItem}>
                    <span className={styles.timelineOp}>
                      {t('database.revision')} {revision.revision} · {revision.op}
                    </span>
                    <span className={styles.timelineMeta}>
                      {new Date(revision.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {auditEvents.length > 0 ? (
            <div className={styles.drawer}>
              <span className={styles.drawerTitle}>{t('database.audit')}</span>
              <ul className={styles.timeline}>
                {auditEvents.map((event) => (
                  <li key={event.id} className={styles.timelineItem}>
                    <span className={styles.timelineOp}>{event.op}</span>
                    <span className={styles.timelineMeta}>
                      {event.actorKind}
                      {event.runId ? ` · ${event.runId}` : ''} ·{' '}
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
