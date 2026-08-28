// Skippable onboarding step: turn a spreadsheet, public page, or CSV into
// organization tables before the person lands on an empty workspace. Same
// plan/commit APIs as ToolBuilder — this is only the setup-shaped surface.

import { useRef, useState } from 'react';
import type { ImportFromUrlResponse, ImportPlan } from '@open-design/contracts';
import { Button, Input } from '@open-design/components';
import { useT } from '../../i18n';
import { commitImportPlan, planImport, planImportFromUrl } from '../../providers/registry';
import { ImportDataPreview } from '../workspace-home/ImportDataPreview';
import { ImportNextSteps } from '../workspace-home/ImportNextSteps';
import styles from './WorkspaceSetupView.module.css';

interface Props {
  orgId: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onImported: (tableName: string) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onConnect: () => void | Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SetupDataImport({ orgId, busy, onBusy, onImported, onSkip, onConnect }: Props) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [content, setContent] = useState('');
  const [source, setSource] = useState<ImportFromUrlResponse['source'] | null>(null);
  const [imported, setImported] = useState(false);

  async function readUrl() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    onBusy(true);
    setError(null);
    try {
      const result = await planImportFromUrl(orgId, trimmed);
      setContent(result.content ?? '');
      setSource(result.source);
      setPlan(result.plan);
    } catch (err) {
      setPlan(null);
      setContent('');
      setSource(null);
      setError(errorMessage(err));
    } finally {
      onBusy(false);
    }
  }

  async function readFile(file: File) {
    onBusy(true);
    setError(null);
    try {
      const text = await file.text();
      setContent(text);
      setSource(null);
      setPlan(await planImport(orgId, text, file.name));
    } catch (err) {
      setPlan(null);
      setContent('');
      setError(errorMessage(err));
    } finally {
      onBusy(false);
    }
  }

  async function handleCommit() {
    if (!plan || busy) return;
    onBusy(true);
    setError(null);
    try {
      await commitImportPlan(orgId, plan, content);
      setImported(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      onBusy(false);
    }
  }

  return (
    <>
      <p className={styles.eyebrow}>{t('setup.eyebrow')}</p>
      <h1 className={styles.title}>{t('setup.importTitle')}</h1>
      <p className={styles.body}>{t('setup.importHint')}</p>
      <div className={styles.urlRow}>
        <Input
          type="url"
          value={url}
          placeholder={t('setup.importPlaceholder')}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void readUrl();
            }
          }}
          data-testid="setup-import-url"
        />
        <Button
          variant="subtle"
          onClick={() => void readUrl()}
          disabled={!url.trim() || busy}
          data-testid="setup-import-url-go"
        >
          {busy && !plan ? t('setup.importWorking') : t('setup.importUrlAction')}
        </Button>
      </div>
      {!imported ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
            className={styles.fileHidden}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
              event.target.value = '';
            }}
            data-testid="setup-import-file"
          />
          <Button
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="setup-import-file-btn"
          >
            {t('setup.importFile')}
          </Button>
        </>
      ) : null}
      {plan ? (
        <div className={styles.plan} data-testid="setup-import-plan">
          <p className={styles.planSummary}>
            {t('builder.planSummary', {
              table: plan.tableName,
              rows: String(plan.rowCount),
            })}
          </p>
          {content ? <ImportDataPreview plan={plan} content={content} source={source} /> : null}
          {imported ? (
            <ImportNextSteps
              plan={plan}
              sourceUrl={source?.url ?? plan.sourceUrl}
              onView={() => void onImported(plan.tableName)}
            />
          ) : null}
        </div>
      ) : null}
      {!imported ? (
        <button
          type="button"
          className={styles.choice}
          onClick={() => {
            if (!busy) void onConnect();
          }}
          disabled={busy}
          data-testid="setup-import-connect"
        >
          <span className={styles.choiceName}>{t('setup.importConnect')}</span>
          <span className={styles.choiceHint}>{t('setup.importConnectHint')}</span>
        </button>
      ) : null}
      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => void onSkip()} disabled={busy} data-testid="setup-import-skip">
          {t('setup.importSkip')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            if (imported && plan) void onImported(plan.tableName);
            else void handleCommit();
          }}
          disabled={!plan || busy}
          data-testid="setup-import-submit"
        >
          {imported
            ? t('setup.importContinue')
            : busy && plan
              ? t('builder.importing')
              : t('setup.importSubmit')}
        </Button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
