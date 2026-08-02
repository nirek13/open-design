// Publish panel: the one-click path from a project file to a public web link.
//
// Two states in one surface, because they are the same mental object:
//   - not yet published → name it, choose who can see it, publish
//   - already published → the live link, republish, version history, unpublish
//
// Progress is shown rather than a spinner. A large site takes minutes to
// upload, and "Uploaded 12 of 40" is the difference between waiting and
// wondering whether it hung.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  HostedSite,
  HostedSiteVersion,
  HostingCapability,
  PublishProgress,
  SiteVisibility,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import {
  HostingRequestError,
  checkSlug,
  fetchHostingCapability,
  listSiteVersions,
  listSites,
  rollbackSite,
  startPublish,
  unpublishSite,
  watchPublish,
} from '../../providers/hosting';
import styles from './PublishPanel.module.css';

export interface PublishPanelProps {
  projectId: string;
  projectName: string;
  /** Entry HTML file being published. */
  fileName: string;
  onClose?: () => void;
}

const IDLE_PROGRESS: PublishProgress = {
  siteId: null,
  phase: 'preparing',
  uploaded: 0,
  total: 0,
  message: null,
};

export function PublishPanel({ projectId, projectName, fileName, onClose }: PublishPanelProps) {
  const { t } = useI18n();

  const [capability, setCapability] = useState<HostingCapability | null>(null);
  const [site, setSite] = useState<HostedSite | null>(null);
  const [versions, setVersions] = useState<HostedSiteVersion[]>([]);
  const [slug, setSlug] = useState('');
  const [slugState, setSlugState] = useState<{ checking: boolean; available: boolean | null; message: string | null }>({
    checking: false,
    available: null,
    message: null,
  });
  const [visibility, setVisibility] = useState<SiteVisibility>('public');
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>(IDLE_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const stopWatchRef = useRef<(() => void) | null>(null);

  // Stop following a publish if the panel unmounts mid-upload, so a closed
  // panel does not keep an EventSource open for the rest of the session.
  useEffect(() => () => stopWatchRef.current?.(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await fetchHostingCapability();
        if (!cancelled) setCapability(found);
      } catch {
        if (!cancelled) {
          setCapability({
            configured: false,
            canPublish: false,
            canPublishToOrg: false,
            sitesDomain: null,
            reason: 'not-configured',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Find an existing site for this project so a second visit shows "republish"
  // rather than offering to claim a name the project already has.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sites = await listSites();
        const existing = sites.find((candidate) => candidate.projectId === projectId) ?? null;
        if (cancelled || !existing) return;
        setSite(existing);
        setSlug(existing.slug);
        setVisibility(existing.visibility);
        setVersions(await listSiteVersions(existing.id).catch(() => []));
      } catch {
        // Not signed in, or hosting unconfigured. The capability check already
        // renders the right explanation; a failed lookup adds nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Debounced availability check. Skipped while the field still matches the
  // site's own slug — republishing to your own name is always allowed.
  useEffect(() => {
    const candidate = slug.trim().toLowerCase();
    if (!candidate || candidate === site?.slug) {
      setSlugState({ checking: false, available: null, message: null });
      return;
    }
    setSlugState({ checking: true, available: null, message: null });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await checkSlug(candidate);
          setSlugState({
            checking: false,
            available: result.available,
            message: result.available ? null : result.reason,
          });
        } catch {
          setSlugState({ checking: false, available: null, message: null });
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [slug, site?.slug]);

  const sitesDomain = capability?.sitesDomain ?? '';
  const liveUrl = site?.url ?? (site?.slug && sitesDomain ? `https://${site.slug}.${sitesDomain}` : '');

  const canPublish = Boolean(capability?.canPublish) && !publishing && slugState.available !== false;

  const handlePublish = useCallback(() => {
    setError(null);
    setPublishing(true);
    setProgress({ ...IDLE_PROGRESS, message: t('publish.progressPreparing') });

    void (async () => {
      try {
        const trimmed = slug.trim().toLowerCase();
        const started = await startPublish(projectId, {
          fileName,
          visibility,
          ...(trimmed ? { slug: trimmed } : {}),
        });
        stopWatchRef.current = watchPublish(started.publishId, (state) => {
          setProgress(state.progress);
          if (state.error) {
            setError(state.error.message);
            setPublishing(false);
            return;
          }
          if (state.progress.phase === 'live') {
            setPublishing(false);
            if (state.site) {
              setSite(state.site);
              setSlug(state.site.slug);
              void listSiteVersions(state.site.id).then(setVersions).catch(() => {});
            }
          }
        });
      } catch (err) {
        setPublishing(false);
        setError(err instanceof HostingRequestError ? err.message : String(err));
      }
    })();
  }, [fileName, projectId, slug, t, visibility]);

  const handleCopy = useCallback(() => {
    if (!liveUrl) return;
    void navigator.clipboard.writeText(liveUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [liveUrl]);

  const handleRollback = useCallback((versionId: string) => {
    if (!site) return;
    void (async () => {
      try {
        setSite(await rollbackSite(site.id, versionId));
        setVersions(await listSiteVersions(site.id));
      } catch (err) {
        setError(err instanceof HostingRequestError ? err.message : String(err));
      }
    })();
  }, [site]);

  const handleUnpublish = useCallback(() => {
    if (!site) return;
    void (async () => {
      try {
        setSite(await unpublishSite(site.id));
      } catch (err) {
        setError(err instanceof HostingRequestError ? err.message : String(err));
      }
    })();
  }, [site]);

  const percent = useMemo(() => {
    if (progress.total === 0) return progress.phase === 'live' ? 100 : 8;
    return Math.round((progress.uploaded / progress.total) * 100);
  }, [progress]);

  // --- Unavailable states --------------------------------------------------

  if (capability && !capability.configured) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>{t('publish.title')}</span>
          <span className={styles.subtitle}>{t('publish.notConfigured')}</span>
        </div>
      </div>
    );
  }

  if (capability && !capability.canPublish) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>{t('publish.title')}</span>
          <span className={styles.subtitle}>{t('publish.signInRequired')}</span>
        </div>
      </div>
    );
  }

  // --- Main ----------------------------------------------------------------

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t('publish.title')}</span>
        <span className={styles.subtitle}>{t('publish.subtitle')}</span>
      </div>

      {site && site.status === 'active' && liveUrl ? (
        <div className={styles.liveRow}>
          <a className={styles.liveUrl} href={liveUrl} target="_blank" rel="noreferrer">
            {liveUrl.replace(/^https:\/\//, '')}
          </a>
          <Button variant="subtle" onClick={handleCopy}>
            {copied ? t('publish.copied') : t('publish.copy')}
          </Button>
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="od-publish-slug">
          {t('publish.addressLabel')}
        </label>
        <div className={styles.slugRow}>
          <input
            id="od-publish-slug"
            className={styles.slugInput}
            value={slug}
            spellCheck={false}
            autoComplete="off"
            placeholder={projectName}
            onChange={(event) => setSlug(event.target.value)}
            disabled={publishing}
          />
          {sitesDomain ? <span className={styles.slugSuffix}>.{sitesDomain}</span> : null}
        </div>
        {slugState.checking ? (
          <span className={styles.hint}>{t('publish.slugChecking')}</span>
        ) : slugState.available === false ? (
          <span className={`${styles.hint} ${styles.hintError}`}>{slugState.message}</span>
        ) : slugState.available === true ? (
          <span className={`${styles.hint} ${styles.hintOk}`}>{t('publish.slugAvailable')}</span>
        ) : (
          <span className={styles.hint}>{t('publish.slugHint')}</span>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>{t('publish.visibilityLabel')}</span>
        <div className={styles.visibility}>
          <button
            type="button"
            className={`${styles.visibilityOption} ${visibility === 'public' ? styles.visibilityOptionActive : ''}`}
            onClick={() => setVisibility('public')}
            disabled={publishing}
            aria-pressed={visibility === 'public'}
          >
            <span className={styles.visibilityName}>{t('publish.visibilityPublic')}</span>
            <span className={styles.visibilityDetail}>{t('publish.visibilityPublicDetail')}</span>
          </button>
          <button
            type="button"
            className={`${styles.visibilityOption} ${visibility === 'org' ? styles.visibilityOptionActive : ''}`}
            onClick={() => setVisibility('org')}
            /* Org visibility needs a Clerk organization to check membership
               against; without one there would be nothing to enforce. */
            disabled={publishing || !capability?.canPublishToOrg}
            aria-pressed={visibility === 'org'}
            title={capability?.canPublishToOrg ? undefined : t('publish.visibilityOrgUnavailable')}
          >
            <span className={styles.visibilityName}>{t('publish.visibilityOrg')}</span>
            <span className={styles.visibilityDetail}>
              {capability?.canPublishToOrg
                ? t('publish.visibilityOrgDetail')
                : t('publish.visibilityOrgUnavailable')}
            </span>
          </button>
        </div>
      </div>

      {publishing || progress.phase === 'live' ? (
        <div className={styles.progress}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <span className={styles.progressLabel}>{progress.message ?? t('publish.progressPreparing')}</span>
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {versions.length > 1 ? (
        <div className={styles.field}>
          <span className={styles.label}>{t('publish.versionsLabel')}</span>
          <div className={styles.versions}>
            {versions.map((version) => (
              <div
                key={version.id}
                className={`${styles.versionRow} ${version.isLive ? styles.versionRowLive : ''}`}
              >
                <span>v{version.versionNumber}</span>
                <span className={styles.versionMeta}>
                  {t('publish.versionFileCount', { count: String(version.fileCount) })}
                </span>
                {version.isLive ? (
                  <span className={styles.versionMeta}>{t('publish.versionLive')}</span>
                ) : (
                  <Button variant="subtle" onClick={() => handleRollback(version.id)}>
                    {t('publish.rollback')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.actions}>
        {site && site.status === 'active' ? (
          <Button variant="subtle" onClick={handleUnpublish} disabled={publishing}>
            {t('publish.unpublish')}
          </Button>
        ) : null}
        {onClose ? (
          <Button variant="ghost" onClick={onClose} disabled={publishing}>
            {t('publish.close')}
          </Button>
        ) : null}
        <Button variant="primary" onClick={handlePublish} disabled={!canPublish}>
          {publishing
            ? t('publish.publishing')
            : site
              ? t('publish.republish')
              : t('publish.publish')}
        </Button>
      </div>
    </div>
  );
}
