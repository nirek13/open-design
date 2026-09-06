// The hub's one box. Typing searches records you already have; Enter / Ask
// changes the company or starts visual work. A pasted public link still
// becomes an import — that path is a URL, not a second field.

import { useLayoutEffect, useRef, useState } from 'react';
import { Button, VisuallyHidden } from '@open-design/components';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID, MIN_APPLY_CONFIDENCE } from '@open-design/contracts';
import { useT } from '../../i18n';
import { applyIntent, interpretIntent } from '../../providers/registry';
import { importUrlFromText } from '../../features/importUrl';
import { Icon } from '../Icon';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import styles from './WorkspaceHome.module.css';

interface Props {
  orgId: string | null;
  value: string;
  onChange: (value: string) => void;
  greetingName?: string | null;
  defaultDesignSystemId?: string | null;
  onAskProject?: (payload: PluginLoopSubmit) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  onProposalCreated?: () => Promise<void> | void;
  onImportUrl?: (url: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function greetingPeriodKey(hour: number): 'workspace.greetingMorning' | 'workspace.greetingAfternoon' | 'workspace.greetingEvening' {
  if (hour < 12) return 'workspace.greetingMorning';
  if (hour < 18) return 'workspace.greetingAfternoon';
  return 'workspace.greetingEvening';
}

export function HubAskComposer({
  orgId,
  value,
  onChange,
  greetingName,
  defaultDesignSystemId,
  onAskProject,
  onProposalCreated,
  onImportUrl,
}: Props) {
  const t = useT();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const canSubmit = Boolean(value.trim()) && !busy;
  const period = t(greetingPeriodKey(new Date().getHours()));
  const name = greetingName?.trim() ?? '';
  const greeting = name ? t('workspace.greetingNamed', { greeting: period, name }) : period;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), 168)}px`;
  }, [value]);

  async function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (orgId) {
        const importUrl = importUrlFromText(trimmed);
        if (importUrl && onImportUrl) {
          onImportUrl(importUrl);
          onChange('');
          return;
        }
        const interpreted = await interpretIntent(orgId, trimmed);
        if (
          (interpreted.kind === 'schema' || interpreted.kind === 'data' || interpreted.kind === 'view')
          && interpreted.confidence >= MIN_APPLY_CONFIDENCE
          && interpreted.operations.length > 0
        ) {
          await applyIntent(orgId, trimmed, interpreted.operations, false);
          onChange('');
          await onProposalCreated?.();
          return;
        }
      }
      if (!onAskProject) return;
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
      if (result !== 'blocked' && result !== false) onChange('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.ask} data-testid="workspace-ask">
      <p
        className={`${styles.greeting}${focused ? ` ${styles.greetingActive}` : ''}`}
        data-testid="workspace-greeting"
        aria-hidden={!focused}
      >
        <span className={styles.greetingInner}>
          <span className={styles.greetingText}>{greeting}</span>
        </span>
      </p>
      <div className={`${styles.askBox}${focused ? ` ${styles.askBoxFocused}` : ''}`} data-testid="workspace-search">
        <div className={styles.askMain}>
          <span className={styles.askIcon} aria-hidden="true">
            <Icon name="search" size={20} />
          </span>
          <textarea
            ref={inputRef}
            id="workspace-ask-input"
            className={styles.askInput}
            data-testid="workspace-ask-input"
            value={value}
            rows={1}
            placeholder={t('workspace.askPlaceholder')}
            disabled={busy}
            aria-label={t('workspace.askPlaceholder')}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          {value ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => {
                onChange('');
                inputRef.current?.focus();
              }}
              aria-label={t('workspace.clearSearch')}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
          <Button
            variant="primary"
            size="icon"
            className={styles.askSubmit}
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            data-testid="workspace-ask-submit"
          >
            {busy ? <Icon name="spinner" size={16} /> : <Icon name="arrow-up" size={18} />}
            <VisuallyHidden>
              {busy ? t('workspace.askApplying') : t('workspace.askSubmit')}
            </VisuallyHidden>
          </Button>
        </div>
      </div>
      {error ? (
        <p className={styles.askError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
