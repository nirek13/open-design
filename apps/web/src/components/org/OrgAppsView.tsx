// The organization's apps: what your coworkers actually open.
//
// A project is where someone builds; an app is the stable thing the rest of
// the team returns to. This gallery is the front door for people who never
// open a project at all.

import { useCallback, useEffect, useState } from 'react';
import { Button, Select } from '@open-design/components';
import type { AppVisibility, OrgApp } from '@open-design/contracts';
import { useT } from '../../i18n';
import { useOrg } from '../../org/OrgContext';
import {
  createAppShareLink,
  fetchOrgApps,
  recordOrgAppOpen,
  updateOrgApp,
} from '../../providers/registry';
import { navigate } from '../../router';
import styles from './OrgAppsView.module.css';

const VISIBILITIES: AppVisibility[] = ['private', 'org', 'link'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relativeTime(timestamp: number | null, t: ReturnType<typeof useT>): string {
  if (!timestamp) return t('apps.neverOpened');
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return t('apps.minutesAgo', { count: String(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('apps.hoursAgo', { count: String(hours) });
  return t('apps.daysAgo', { count: String(Math.round(hours / 24)) });
}

export function OrgAppsView({ active }: { active: boolean }) {
  const t = useT();
  const { activeOrgId } = useOrg();
  const [apps, setApps] = useState<OrgApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<{ appId: string; url: string } | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setApps(await fetchOrgApps(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  async function handleOpen(orgApp: OrgApp) {
    if (activeOrgId) {
      // Best effort — a usage counter must never block opening the app.
      void recordOrgAppOpen(activeOrgId, orgApp.id).catch(() => {});
    }
    navigate({
      kind: 'project',
      projectId: orgApp.projectId,
      conversationId: null,
      fileName: orgApp.filePath,
    });
  }

  async function handleVisibility(orgApp: OrgApp, visibility: AppVisibility) {
    if (!activeOrgId) return;
    try {
      await updateOrgApp(activeOrgId, orgApp.id, { visibility });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleShare(orgApp: OrgApp) {
    if (!activeOrgId) return;
    try {
      const created = await createAppShareLink(activeOrgId, orgApp.id);
      setShareLink({ appId: orgApp.id, url: created.url });
      try {
        await navigator.clipboard.writeText(created.url);
      } catch {
        // Clipboard access is optional; the link stays visible.
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleArchive(orgApp: OrgApp) {
    if (!activeOrgId) return;
    try {
      await updateOrgApp(activeOrgId, orgApp.id, { status: 'archived' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="entry-section" data-testid="org-apps-view">
      <header className="entry-section__head">
        <h1 className="entry-section__title">{t('apps.title')}</h1>
        <p className="entry-section__subtitle">{t('apps.subtitle')}</p>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {apps.length === 0 ? (
        <p className={styles.empty}>{t('apps.empty')}</p>
      ) : (
        <div className={styles.grid}>
          {apps.map((orgApp) => (
            <article key={orgApp.id} className={styles.card} data-testid="org-app-card">
              <button type="button" className={styles.cardMain} onClick={() => handleOpen(orgApp)}>
                <span className={styles.cardName}>{orgApp.name}</span>
                {orgApp.description ? (
                  <span className={styles.cardDescription}>{orgApp.description}</span>
                ) : null}
                <span className={styles.cardMeta}>
                  {orgApp.createdByName
                    ? t('apps.byline', { name: orgApp.createdByName })
                    : t('apps.bylineUnknown')}
                  {' · '}
                  {relativeTime(orgApp.lastOpenedAt, t)}
                </span>
              </button>

              <div className={styles.cardActions}>
                <Select
                  value={orgApp.visibility}
                  aria-label={t('apps.visibility')}
                  onChange={(event) => handleVisibility(orgApp, event.target.value as AppVisibility)}
                >
                  {VISIBILITIES.map((visibility) => (
                    <option key={visibility} value={visibility}>
                      {t(`apps.visibility.${visibility}` as never)}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" onClick={() => handleShare(orgApp)}>
                  {t('apps.share')}
                </Button>
                <Button variant="ghost" onClick={() => handleArchive(orgApp)}>
                  {t('apps.archive')}
                </Button>
              </div>

              {shareLink?.appId === orgApp.id ? (
                <div className={styles.shareBox} data-testid="org-app-share-link">
                  <code className={styles.shareUrl}>{shareLink.url}</code>
                  <p className={styles.shareWarning}>{t('apps.shareWarning')}</p>
                  <Button variant="ghost" onClick={() => setShareLink(null)}>
                    {t('apps.dismiss')}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
