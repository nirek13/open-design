import { useState } from 'react';
import { Button } from '@open-design/components';
import {
  composeImportAppPrompt,
  composeImportRefreshPrompt,
  DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
} from '@open-design/contracts';
import type { ImportPlan, RoutineSchedule } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { createProject } from '../../state/projects';
import { navigate } from '../../router';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import styles from './ImportNextSteps.module.css';

interface Props {
  plan: ImportPlan;
  sourceUrl?: string | null;
  onView: () => void;
  onLeave?: () => void;
  /** Same hub Ask path: creates the project and auto-sends the brief. */
  onAskProject?: (
    payload: PluginLoopSubmit,
  ) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
}

type RefreshKind = 'hourly' | 'daily' | 'weekdays';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refreshSchedule(kind: RefreshKind): RoutineSchedule {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (kind === 'hourly') return { kind: 'hourly', minute: 0 };
  return { kind, time: '06:00', timezone };
}

function markAutoSend(projectId: string): void {
  try {
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
  } catch {
    /* private mode / SSR */
  }
}

export function ImportNextSteps({ plan, sourceUrl, onView, onLeave, onAskProject }: Props) {
  const t = useT();
  const { activeOrg } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [busy, setBusy] = useState<'app' | RefreshKind | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [request, setRequest] = useState('');
  const [error, setError] = useState<string | null>(null);
  const url = sourceUrl || plan.sourceUrl;

  function appPrompt(userRequest: string): string {
    const composed = composeImportAppPrompt({
      tableName: plan.tableName,
      displayName: plan.displayName,
      columns: plan.columns.map((column) => ({
        header: column.header,
        fieldName: column.fieldName,
        type: column.type,
      })),
      ...(url ? { sourceUrl: url } : {}),
    });
    const trimmed = userRequest.trim();
    if (!trimmed) return composed;
    return `${trimmed}\n\n${composed}`;
  }

  async function handleBuild() {
    const prompt = appPrompt(request);
    if (busy) return;
    setBusy('app');
    setError(null);
    try {
      if (onAskProject) {
        const result = await onAskProject({
          prompt,
          pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
          appliedPluginSnapshotId: null,
          pluginTitle: null,
          taskKind: null,
          pluginInputs: { prompt },
          projectKind: 'other',
          projectMetadata: { kind: 'other' },
          designSystemId: activeOrg?.defaultDesignSystemId ?? null,
          visibility: 'private',
          conversationMode: 'design',
        });
        if (result !== 'blocked' && result !== false) onLeave?.();
        return;
      }
      const created = await createProject({
        name: (request.trim() || `${plan.displayName} app`).slice(0, 60),
        pendingPrompt: prompt,
        skillId: null,
        designSystemId: activeOrg?.defaultDesignSystemId ?? null,
      });
      if (created?.project) {
        markAutoSend(created.project.id);
        onLeave?.();
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
      setBusy(null);
    }
  }

  async function handleRefresh(kind: RefreshKind) {
    if (!url || busy || refreshDone) return;
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch('/api/routines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `Refresh ${plan.displayName}`,
          prompt: composeImportRefreshPrompt({ url, tableName: plan.tableName }),
          schedule: refreshSchedule(kind),
          target: { mode: 'create_each_run' },
          enabled: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `could not schedule refresh (${res.status})`);
      }
      setRefreshDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.wrap} data-testid="import-next-steps">
      <p className={styles.title}>{t('builder.nextTitle', { table: plan.tableName })}</p>
      <p className={styles.hint}>{t('builder.nextHint')}</p>
      {drafting ? (
        <div className={styles.draft} data-testid="import-next-build-draft">
          <p className={styles.choiceName}>{t('builder.nextBuildPrompt')}</p>
          <textarea
            className={styles.textarea}
            rows={4}
            autoFocus
            value={request}
            placeholder={t('builder.nextBuildPlaceholder')}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleBuild();
              }
            }}
            data-testid="import-next-build-prompt"
          />
          <div className={styles.draftActions}>
            <Button variant="ghost" onClick={() => setDrafting(false)} disabled={busy !== null}>
              {t('builder.back')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleBuild()}
              disabled={busy !== null}
              data-testid="import-next-build-submit"
            >
              {busy === 'app' ? t('builder.buildingApp') : t('builder.nextBuildSubmit')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.choices}>
          <button type="button" className={styles.choice} onClick={onView} data-testid="import-next-view">
            <span className={styles.choiceName}>{t('builder.nextView')}</span>
          </button>
          <button
            type="button"
            className={styles.choice}
            onClick={() => setDrafting(true)}
            disabled={busy !== null}
            data-testid="import-next-build"
          >
            <span className={styles.choiceName}>{t('builder.nextBuild')}</span>
            <span className={styles.choiceHint}>{t('builder.nextBuildHint')}</span>
          </button>
          {url ? (
            <div className={styles.refresh} data-testid="import-next-refresh">
              <span className={styles.choiceName}>{t('builder.nextRefresh')}</span>
              <span className={styles.choiceHint}>{t('builder.nextRefreshHint')}</span>
              {refreshDone ? (
                <p className={styles.done}>{t('builder.refreshScheduled')}</p>
              ) : (
                <div className={styles.refreshRow}>
                  {(['hourly', 'daily', 'weekdays'] as const).map((kind) => (
                    <Button
                      key={kind}
                      variant="subtle"
                      onClick={() => void handleRefresh(kind)}
                      disabled={busy !== null}
                      data-testid={`import-refresh-${kind}`}
                    >
                      {busy === kind
                        ? t('builder.refreshing')
                        : t(
                            kind === 'hourly'
                              ? 'builder.refreshHourly'
                              : kind === 'daily'
                                ? 'builder.refreshDaily'
                                : 'builder.refreshWeekdays',
                          )}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
