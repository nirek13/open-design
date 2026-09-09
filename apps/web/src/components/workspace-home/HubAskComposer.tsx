// The hub's one box. Enter / Ask changes the company or starts visual work.
// Finding records lives on Search. A pasted public link still becomes an
// import — that path is a URL, not a second field.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, VisuallyHidden } from '@open-design/components';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID, MIN_APPLY_CONFIDENCE } from '@open-design/contracts';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { applyIntent, interpretIntent } from '../../providers/registry';
import { importUrlFromText } from '../../features/importUrl';
import { Icon, type IconName } from '../Icon';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import styles from './WorkspaceHome.module.css';

interface Props {
  orgId: string | null;
  value: string;
  onChange: (value: string) => void;
  greetingName?: string | null;
  defaultDesignSystemId?: string | null;
  /** Empty-stage greeting stays up so the first visit reads as a welcome. */
  hero?: boolean;
  launching?: boolean;
  onAskProject?: (payload: PluginLoopSubmit) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  onProposalCreated?: () => Promise<void> | void;
  onImportUrl?: (url: string) => void;
  onStudioLaunch?: () => void;
}

/** A starting point offered under the empty composer. */
interface Starter {
  id: string;
  icon: IconName;
  labelKey: keyof Dict;
  /** The text dropped into the box. Deliberately a full brief, not a stub —
      a starter that still needs finishing is a worse blank page. */
  promptKey: keyof Dict;
}

/* Four, and only four. The point of this row is to show the range of the
   box in one glance — a landing page, a deck, a table, a document — not to
   catalogue what the product can do. A fifth turns a decision into a menu.
   They cover both halves of what Ask routes to: the first two open visual
   work as a project, the last two are read by the workspace intent layer. */
const STARTERS: readonly Starter[] = [
  {
    id: 'site',
    icon: 'layout',
    labelKey: 'workspace.starterSiteLabel',
    promptKey: 'workspace.starterSitePrompt',
  },
  {
    id: 'deck',
    icon: 'slides',
    labelKey: 'workspace.starterDeckLabel',
    promptKey: 'workspace.starterDeckPrompt',
  },
  {
    id: 'table',
    icon: 'grid',
    labelKey: 'workspace.starterTableLabel',
    promptKey: 'workspace.starterTablePrompt',
  },
  {
    id: 'doc',
    icon: 'file-text',
    labelKey: 'workspace.starterDocLabel',
    promptKey: 'workspace.starterDocPrompt',
  },
];

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
  hero = false,
  launching = false,
  onAskProject,
  onProposalCreated,
  onImportUrl,
  onStudioLaunch,
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
  const greetingOpen = hero || focused || launching;
  // Starting points are for an empty box. The moment there is a brief in it —
  // typed or filled from a starter — they are noise competing with Send.
  const startersHidden = Boolean(value.trim()) || busy || launching;

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
      onStudioLaunch?.();
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
      // Keep the typed brief visible through the studio morph; the hub unmounts
      // on success. Clearing here would empty the box mid-transition.
      if (result !== 'blocked' && result !== false) return;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.ask}${launching ? ` ${styles.askLaunching}` : ''}`} data-testid="workspace-ask">
      <p
        className={`${styles.greeting}${greetingOpen ? ` ${styles.greetingActive}` : ''}${hero ? ` ${styles.greetingHero}` : ''}`}
        data-testid="workspace-greeting"
        aria-hidden={!greetingOpen}
      >
        <span className={styles.greetingInner}>
          <span className={styles.greetingText}>{greeting}</span>
          {/* Inside the collapsing wrapper on purpose: the lead is part of
              the welcome, so it must fold away with the greeting rather than
              linger over a composer the user has already started using. */}
          <span className={styles.heroLead}>{t('workspace.heroLead')}</span>
        </span>
      </p>
      <div
        className={`${styles.askBox}${focused ? ` ${styles.askBoxFocused}` : ''}${launching ? ` ${styles.askBoxLaunching}` : ''}`}
        data-testid="workspace-search"
      >
        <div className={styles.askMain}>
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
            aria-busy={busy || launching}
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
              className={styles.askClear}
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

      {/* Kept mounted and hidden by class rather than unmounted, so the row
          has an exit transition to play when the box stops being empty
          (see the animation philosophy in AGENTS.md). */}
      <div
        className={`${styles.starters}${startersHidden ? ` ${styles.startersHidden}` : ''}`}
        data-testid="workspace-starters"
        role="group"
        aria-label={t('workspace.startersLabel')}
        aria-hidden={startersHidden}
      >
        {STARTERS.map((starter, index) => (
          <button
            key={starter.id}
            type="button"
            className={styles.starter}
            style={{ '--starter-index': index } as CSSProperties}
            data-testid={`workspace-starter-${starter.id}`}
            // The row is only faded out, not unmounted, so it has to be
            // taken out of the tab order by hand or Tab lands on invisible
            // buttons between the composer and everything after it.
            tabIndex={startersHidden ? -1 : 0}
            onClick={() => {
              // Fill, never send. The first thing a new user does here should
              // still be their own sentence, edited and confirmed.
              onChange(t(starter.promptKey));
              inputRef.current?.focus();
            }}
          >
            <Icon name={starter.icon} size={15} className={styles.starterIcon} aria-hidden />
            <span>{t(starter.labelKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
