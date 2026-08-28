// The hub's Ask box. Search on this page is for records you already have;
// this composer is for changing the company or starting visual work.

import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID, MIN_APPLY_CONFIDENCE } from '@open-design/contracts';
import { useT } from '../../i18n';
import { applyIntent, interpretIntent } from '../../providers/registry';
import { importUrlFromText } from '../../features/importUrl';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import styles from './WorkspaceHome.module.css';

interface Props {
  orgId: string | null;
  defaultDesignSystemId?: string | null;
  initialPrompt?: string;
  onAskProject: (payload: PluginLoopSubmit) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  onProposalCreated?: () => Promise<void> | void;
  onImportUrl?: (url: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function HubAskComposer({
  orgId,
  defaultDesignSystemId,
  initialPrompt,
  onAskProject,
  onProposalCreated,
  onImportUrl,
}: Props) {
  const t = useT();
  const [text, setText] = useState(initialPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPrompt) setText(initialPrompt);
  }, [initialPrompt]);

  async function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (orgId) {
        const importUrl = importUrlFromText(trimmed);
        if (importUrl && onImportUrl) {
          onImportUrl(importUrl);
          setText('');
          return;
        }
        const interpreted = await interpretIntent(orgId, trimmed);
        if (
          (interpreted.kind === 'schema' || interpreted.kind === 'data' || interpreted.kind === 'view')
          && interpreted.confidence >= MIN_APPLY_CONFIDENCE
          && interpreted.operations.length > 0
        ) {
          await applyIntent(orgId, trimmed, interpreted.operations, false);
          setText('');
          await onProposalCreated?.();
          return;
        }
      }
      const result = await onAskProject({
        prompt: trimmed,
        pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
        appliedPluginSnapshotId: null,
        pluginTitle: null,
        taskKind: null,
        pluginInputs: { prompt: trimmed },
        projectKind: 'other',
        projectMetadata: { kind: 'other' },
        designSystemId: defaultDesignSystemId ?? null,
        visibility: 'private',
        conversationMode: 'design',
      });
      if (result !== 'blocked' && result !== false) setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.ask} data-testid="workspace-ask">
      <label className={styles.askLabel} htmlFor="workspace-ask-input">
        {t('workspace.askHint')}
      </label>
      <div className={styles.askRow}>
        <textarea
          id="workspace-ask-input"
          className={styles.askInput}
          data-testid="workspace-ask-input"
          value={text}
          rows={2}
          placeholder={t('workspace.askPlaceholder')}
          autoFocus
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <Button
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={busy || !text.trim()}
          data-testid="workspace-ask-submit"
        >
          {busy ? t('workspace.askApplying') : t('workspace.askSubmit')}
        </Button>
      </div>
      {error ? (
        <p className={styles.askError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
