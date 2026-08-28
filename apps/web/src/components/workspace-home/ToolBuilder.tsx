// Making something that does not exist yet.
//
// Three routes to a custom tool, in increasing order of how much you already
// know about what you want:
//
//   Describe it  — say what you need; the assistant builds it as a project,
//                  and anything it changes about your data comes back as a
//                  proposal you approve.
//   Import it    — paste a public link (Google Sheet, CSV, JSON, HTML
//                  table, or any page). Tables are read directly; otherwise
//                  AI scrapes the page into rows. Check the reading, then commit.
//   Define it    — you know the shape. Name the fields yourself.
//
// The import path shows its reading before writing anything, because a wrong
// guess about a column is cheap to fix here and expensive to fix later.

import { useEffect, useRef, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type { ImportFromUrlResponse, ImportPlan, WorkspaceFieldInput, WorkspaceFieldType } from '@open-design/contracts';
import { WORKSPACE_FIELD_TYPES } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { commitImportPlan, createWorkspaceTable, planImport, planImportFromUrl } from '../../providers/registry';
import { createProject } from '../../state/projects';
import { navigate } from '../../router';
import { composePagesWikiPrompt } from '../pages/wiki-prompt';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { ImportDataPreview } from './ImportDataPreview';
import { ImportNextSteps } from './ImportNextSteps';
import styles from './ToolBuilder.module.css';

interface Props {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  /** Reload hub data without closing the builder — used after an import so next steps stay on screen. */
  onReload?: () => void | Promise<void>;
  onAskProject?: (
    payload: PluginLoopSubmit,
  ) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  initialMode?: Mode;
  /** Prefill and immediately read a public link. */
  initialUrl?: string;
}

type Mode = 'choose' | 'describe' | 'import' | 'define' | 'wiki';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EMPTY_FIELD: WorkspaceFieldInput = { name: '', type: 'text' };

export function ToolBuilder({ onClose, onCreated, onReload, onAskProject, initialMode = 'choose', initialUrl }: Props) {
  const t = useT();
  const { activeOrgId, activeOrg } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [description, setDescription] = useState('');
  const [tableName, setTableName] = useState('');
  const [fields, setFields] = useState<WorkspaceFieldInput[]>([{ ...EMPTY_FIELD }]);
  const [importContent, setImportContent] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importUrl, setImportUrl] = useState(initialUrl ?? '');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [importSource, setImportSource] = useState<ImportFromUrlResponse['source'] | null>(null);
  const [imported, setImported] = useState(false);
  const autoRead = useRef(false);

  async function handleDescribe() {
    if (!description.trim() || busy) return;
    setBusy(true);
    try {
      // A described tool is a project: the assistant builds it there, and any
      // data change it wants comes back through the approval flow.
      const created = await createProject({
        name: description.trim().slice(0, 60),
        pendingPrompt: description.trim(),
        skillId: null,
        designSystemId: activeOrg?.defaultDesignSystemId ?? null,
      });
      if (created?.project) {
        navigate({
          kind: 'project',
          projectId: created.project.id,
          conversationId: created.conversationId ?? null,
          fileName: null,
        });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleWiki() {
    if (!description.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createProject({
        name: description.trim().slice(0, 60),
        pendingPrompt: composePagesWikiPrompt({ request: description.trim() }),
        skillId: null,
        designSystemId: activeOrg?.defaultDesignSystemId ?? null,
      });
      if (created?.project) {
        navigate({
          kind: 'project',
          projectId: created.project.id,
          conversationId: created.conversationId ?? null,
          fileName: null,
        });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setImportFileName(file.name);
    const text = await file.text();
    setImportContent(text);
    if (!activeOrgId) return;
    setBusy(true);
    try {
      setPlan(await planImport(activeOrgId, text, file.name));
      setImportSource(null);
      setError(null);
    } catch (err) {
      setPlan(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function readUrl(url: string) {
    if (!activeOrgId || !url || busy) return;
    setBusy(true);
    try {
      const result = await planImportFromUrl(activeOrgId, url);
      setImportContent(result.content ?? '');
      setImportFileName(result.source.fileName);
      setImportSource(result.source);
      setPlan(result.plan);
      setError(null);
    } catch (err) {
      setPlan(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUrlImport() {
    await readUrl(importUrl.trim());
  }

  useEffect(() => {
    const url = initialUrl?.trim();
    if (!url || !activeOrgId || autoRead.current) return;
    autoRead.current = true;
    setMode('import');
    setImportUrl(url);
    void readUrl(url);
  }, [activeOrgId, initialUrl]);

  async function handleCommitImport() {
    if (!activeOrgId || !plan || busy) return;
    setBusy(true);
    try {
      await commitImportPlan(activeOrgId, plan, importContent);
      setImported(true);
      await onReload?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDefine() {
    if (!activeOrgId || !tableName.trim() || busy) return;
    setBusy(true);
    try {
      await createWorkspaceTable(activeOrgId, {
        name: tableName.trim(),
        fields: fields.filter((field) => field.name.trim()),
      });
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" data-testid="tool-builder">
      <div className={`${styles.panel}${plan ? ` ${styles.panelWide}` : ''}`}>
        <header className={styles.head}>
          <h2 className={styles.title}>{t('builder.title')}</h2>
          <Button variant="ghost" onClick={onClose} aria-label={t('builder.close')}>
            ✕
          </Button>
        </header>

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        {mode === 'choose' ? (
          <div className={styles.choices}>
            <button type="button" className={styles.choice} onClick={() => setMode('describe')} data-testid="builder-describe">
              <span className={styles.choiceName}>{t('builder.describeName')}</span>
              <span className={styles.choiceHint}>{t('builder.describeHint')}</span>
            </button>
            <button type="button" className={styles.choice} onClick={() => setMode('import')} data-testid="builder-import">
              <span className={styles.choiceName}>{t('builder.importName')}</span>
              <span className={styles.choiceHint}>{t('builder.importHint')}</span>
            </button>
            <button type="button" className={styles.choice} onClick={() => setMode('define')} data-testid="builder-define">
              <span className={styles.choiceName}>{t('builder.defineName')}</span>
              <span className={styles.choiceHint}>{t('builder.defineHint')}</span>
            </button>
            <button type="button" className={styles.choice} onClick={() => setMode('wiki')} data-testid="builder-wiki">
              <span className={styles.choiceName}>{t('builder.wikiName')}</span>
              <span className={styles.choiceHint}>{t('builder.wikiHint')}</span>
            </button>
          </div>
        ) : null}

        {mode === 'describe' ? (
          <div className={styles.body}>
            <p className={styles.hint}>{t('builder.describeBody')}</p>
            <textarea
              className={styles.textarea}
              rows={4}
              autoFocus
              value={description}
              placeholder={t('builder.describePlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="builder-description"
            />
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setMode('choose')}>
                {t('builder.back')}
              </Button>
              <Button variant="primary" onClick={handleDescribe} disabled={!description.trim() || busy}>
                {t('builder.buildIt')}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'wiki' ? (
          <div className={styles.body}>
            <p className={styles.hint}>{t('builder.wikiBody')}</p>
            <textarea
              className={styles.textarea}
              rows={4}
              autoFocus
              value={description}
              placeholder={t('builder.wikiPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="builder-wiki-description"
            />
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setMode('choose')}>
                {t('builder.back')}
              </Button>
              <Button variant="primary" onClick={handleWiki} disabled={!description.trim() || busy}>
                {t('builder.buildIt')}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'import' ? (
          <div className={styles.body}>
            <p className={styles.hint}>{t('builder.importBody')}</p>
            <div className={styles.urlRow}>
              <Input
                type="url"
                value={importUrl}
                placeholder={t('builder.importUrlPlaceholder')}
                onChange={(event) => setImportUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleUrlImport();
                  }
                }}
                data-testid="builder-import-url"
              />
              <Button
                variant="subtle"
                onClick={() => void handleUrlImport()}
                disabled={!importUrl.trim() || busy}
                data-testid="builder-import-url-go"
              >
                {t('builder.importUrlAction')}
              </Button>
            </div>
            <p className={styles.hint}>{t('builder.importUrlHint')}</p>
            <input
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              className={styles.file}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
              data-testid="builder-file"
            />
            {plan ? (
              <div className={styles.plan} data-testid="builder-plan">
                <p className={styles.planSummary}>
                  {t('builder.planSummary', {
                    table: plan.tableName,
                    rows: String(plan.rowCount),
                  })}
                  {plan.appendingToExisting ? ` — ${t('builder.appending')}` : ''}
                </p>
                <table className={styles.planTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('builder.column')}</th>
                      <th scope="col">{t('builder.readAs')}</th>
                      <th scope="col">{t('builder.why')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.columns.map((column) => (
                      <tr key={column.fieldName}>
                        <td>{column.header}</td>
                        <td>
                          {column.type}
                          {column.unique ? ` · ${t('builder.uniqueKey')}` : ''}
                        </td>
                        <td className={styles.reason}>{column.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.skipped.length > 0 ? (
                  <p className={styles.hint}>
                    {t('builder.skippedRows', { count: String(plan.skipped.length) })}
                  </p>
                ) : null}
                {importContent ? (
                  <ImportDataPreview plan={plan} content={importContent} source={importSource} />
                ) : null}
              </div>
            ) : null}
            {imported && plan ? (
              <ImportNextSteps
                plan={plan}
                sourceUrl={importSource?.url ?? plan.sourceUrl}
                onView={() => {
                  void onCreated();
                  navigate({ kind: 'home', view: 'tables', tableName: plan.tableName });
                }}
                onLeave={() => void onCreated()}
                {...(onAskProject ? { onAskProject } : {})}
              />
            ) : (
              <div className={styles.actions}>
                <Button variant="ghost" onClick={() => setMode('choose')}>
                  {t('builder.back')}
                </Button>
                <Button variant="primary" onClick={handleCommitImport} disabled={!plan || busy} data-testid="builder-commit">
                  {busy ? t('builder.importing') : t('builder.importCommit')}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {mode === 'define' ? (
          <div className={styles.body}>
            <p className={styles.hint}>{t('builder.defineBody')}</p>
            <Input
              type="text"
              autoFocus
              value={tableName}
              placeholder={t('builder.tableNamePlaceholder')}
              onChange={(event) => setTableName(event.target.value)}
              data-testid="builder-table-name"
            />
            {fields.map((field, index) => (
              <div key={index} className={styles.fieldRow}>
                <Input
                  type="text"
                  value={field.name}
                  placeholder={t('builder.fieldName')}
                  onChange={(event) => {
                    const next = [...fields];
                    next[index] = { ...field, name: event.target.value };
                    setFields(next);
                  }}
                />
                <Select
                  value={field.type}
                  aria-label={t('builder.fieldType')}
                  onChange={(event) => {
                    const next = [...fields];
                    next[index] = { ...field, type: event.target.value as WorkspaceFieldType };
                    setFields(next);
                  }}
                >
                  {WORKSPACE_FIELD_TYPES.filter((type) => type !== 'link').map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={field.required ?? false}
                    onChange={(event) => {
                      const next = [...fields];
                      next[index] = { ...field, required: event.target.checked };
                      setFields(next);
                    }}
                  />
                  {t('builder.required')}
                </label>
              </div>
            ))}
            <Button variant="ghost" onClick={() => setFields([...fields, { ...EMPTY_FIELD }])}>
              {t('builder.addField')}
            </Button>
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setMode('choose')}>
                {t('builder.back')}
              </Button>
              <Button variant="primary" onClick={handleDefine} disabled={!tableName.trim() || busy} data-testid="builder-create-table">
                {t('builder.createTable')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
