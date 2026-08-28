// Organization search: one box, natural language, reporting-chain scope.
//
// Finding something you already have is the common case, so the field takes
// focus on load. Results name themselves — a title, a source, a person — and
// open the same place the rest of the app would. Cmd+Space / Cmd+1
// (Ctrl+Space / Ctrl+1 on Windows/Linux) pull the same search up as a
// palette from anywhere. Places, every org app, and uploaded assets are
// always in this list — not only items the org-find API already knew about.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { LibraryAsset, OrgAppWithOrgName, OrgSearchHit, OrgSearchKind } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchAllOrgApps,
  fetchLibraryAssets,
  fetchOrgApp,
  searchOrg,
} from '../../providers/registry';
import { navigate, type EntryHomeView } from '../../router';
import { importUrlFromText } from '../../features/importUrl';
import { useOptionalRunningApp } from '../apps/RunningAppContext';
import { Icon, type IconName } from '../Icon';
import { assetTitle } from '../LibraryAssetMeta';
import { LibraryUploadModal } from '../LibraryUploadModal';
import { RecordEditor } from '../workspace-home/RecordEditor';
import { ToolBuilder } from '../workspace-home/ToolBuilder';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { relativeTime } from '../workspace/format';
import { matchesSpotlightQuery, SPOTLIGHT_DESTINATIONS } from './spotlight-catalog';
import styles from './SearchView.module.css';

interface Props {
  active: boolean;
}

interface PaletteProps {
  open: boolean;
  onClose: () => void;
}

type SpotlightKind = OrgSearchKind | 'destination' | 'asset' | 'import';

interface SpotlightHit {
  kind: SpotlightKind;
  id: string;
  title: string;
  snippet: string | null;
  ownerName: string | null;
  updatedAt: number;
  projectId?: string;
  fileName?: string;
  pageId?: string;
  appId?: string;
  channelId?: string;
  tableName?: string;
  recordId?: string;
  view?: EntryHomeView;
  assetId?: string;
  importUrl?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function kindIcon(kind: SpotlightKind): IconName {
  switch (kind) {
    case 'project':
      return 'folder';
    case 'file':
      return 'file-text';
    case 'page':
      return 'file-text';
    case 'app':
      return 'blocks';
    case 'chat':
      return 'message-circle';
    case 'calendar':
      return 'history';
    case 'record':
      return 'layout';
    case 'destination':
      return 'grid';
    case 'asset':
      return 'image';
    case 'import':
      return 'upload';
  }
}

function kindLabel(kind: SpotlightKind, t: ReturnType<typeof useT>): string {
  if (kind === 'destination') return t('search.kind.destination');
  if (kind === 'asset') return t('search.kind.asset');
  if (kind === 'import') return t('search.kind.import');
  return t(`search.kind.${kind}` as never);
}

export function SearchView({ active }: Props) {
  return <SearchSession active={active} variant="page" />;
}

export function SearchPalette({ open, onClose }: PaletteProps) {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <SearchSession active onDismiss={onClose} variant="palette" />,
    document.body,
  );
}

function SearchSession({
  active,
  variant,
  onDismiss,
}: {
  active: boolean;
  variant: 'page' | 'palette';
  onDismiss?: () => void;
}) {
  const t = useT();
  const { activeOrgId, activeOrg } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const runningApp = useOptionalRunningApp();
  const [query, setQuery] = useState('');
  const [orgHits, setOrgHits] = useState<OrgSearchHit[]>([]);
  const [apps, setApps] = useState<OrgAppWithOrgName[]>([]);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ tableRef: string; recordId: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [importingUrl, setImportingUrl] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const palette = variant === 'palette';

  useEffect(() => {
    if (active) searchRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchAllOrgApps()
      .then((next) => {
        if (!cancelled) setApps(next);
      })
      .catch(() => {
        if (!cancelled) setApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const trimmed = query.trim();
    let cancelled = false;
    void fetchLibraryAssets(trimmed ? { q: trimmed } : {})
      .then((next) => {
        if (!cancelled) setAssets(next);
      })
      .catch(() => {
        if (!cancelled) setAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, query]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setOrgHits([]);
      setSearching(false);
      setHighlight(0);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await searchOrg(activeOrgId, trimmed);
        setOrgHits(next);
        setHighlight(0);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [active, activeOrgId, query]);

  useEffect(() => {
    if (!palette) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss?.();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [palette, onDismiss]);

  const destinationHits = useMemo((): SpotlightHit[] => {
    return SPOTLIGHT_DESTINATIONS
      .filter((dest) => {
        const label = t(dest.labelKey);
        return matchesSpotlightQuery(`${label} ${dest.aliases.join(' ')}`, query);
      })
      .map((dest) => ({
        kind: 'destination' as const,
        id: `destination:${dest.id}`,
        title: t(dest.labelKey),
        snippet: null,
        ownerName: null,
        updatedAt: 0,
        view: dest.view,
      }));
  }, [query, t]);

  const appHits = useMemo((): SpotlightHit[] => {
    const seen = new Set(orgHits.filter((hit) => hit.kind === 'app' && hit.appId).map((hit) => hit.appId));
    return apps
      .filter((app) => matchesSpotlightQuery(`${app.name} ${app.description ?? ''}`, query))
      .filter((app) => !seen.has(app.id))
      .map((app) => ({
        kind: 'app' as const,
        id: `app:${app.id}`,
        title: app.name,
        snippet: app.description ?? app.orgName,
        ownerName: app.createdByName,
        updatedAt: app.updatedAt,
        appId: app.id,
      }));
  }, [apps, orgHits, query]);

  const assetHits = useMemo((): SpotlightHit[] => {
    const needle = query.trim().toLowerCase();
    return assets
      .filter((asset) => {
        if (!needle) return true;
        const hay = `${assetTitle(asset)} ${asset.caption ?? ''} ${asset.tags.join(' ')}`;
        return hay.toLowerCase().includes(needle);
      })
      .slice(0, needle ? 12 : 6)
      .map((asset) => ({
        kind: 'asset' as const,
        id: `asset:${asset.id}`,
        title: assetTitle(asset),
        snippet: asset.kind,
        ownerName: null,
        updatedAt: asset.updatedAt,
        assetId: asset.id,
      }));
  }, [assets, query]);

  const orgSpotlightHits = useMemo((): SpotlightHit[] => orgHits.map((hit) => ({
    kind: hit.kind,
    id: `${hit.kind}:${hit.id}`,
    title: hit.title,
    snippet: hit.snippet,
    ownerName: hit.ownerName,
    updatedAt: hit.updatedAt,
    projectId: hit.projectId,
    fileName: hit.fileName,
    pageId: hit.pageId,
    appId: hit.appId,
    channelId: hit.channelId,
    tableName: hit.tableName,
    recordId: hit.recordId,
  })), [orgHits]);

  const importHits = useMemo((): SpotlightHit[] => {
    const url = importUrlFromText(query);
    if (!url) return [];
    return [{
      kind: 'import',
      id: `import:${url}`,
      title: t('search.importLink'),
      snippet: url,
      ownerName: null,
      updatedAt: 0,
      importUrl: url,
    }];
  }, [query, t]);

  const hits = useMemo(
    () => [...importHits, ...destinationHits, ...appHits, ...assetHits, ...orgSpotlightHits],
    [appHits, assetHits, destinationHits, importHits, orgSpotlightHits],
  );

  async function openHit(hit: SpotlightHit) {
    if (hit.kind === 'destination' && hit.view) {
      onDismiss?.();
      navigate({ kind: 'home', view: hit.view });
      return;
    }
    if (hit.kind === 'import' && hit.importUrl) {
      setImportingUrl(hit.importUrl);
      return;
    }
    if (hit.kind === 'asset') {
      onDismiss?.();
      navigate({ kind: 'home', view: 'library' });
      return;
    }
    if (hit.kind === 'record' && hit.tableName && hit.recordId) {
      setEditing({ tableRef: hit.tableName, recordId: hit.recordId });
      return;
    }
    if (hit.kind === 'app' && hit.appId && runningApp) {
      const local = apps.find((app) => app.id === hit.appId);
      try {
        const app = local ?? (activeOrgId ? await fetchOrgApp(activeOrgId, hit.appId) : null);
        if (!app) {
          onDismiss?.();
          navigate({ kind: 'home', view: 'apps' });
          return;
        }
        const orgId = 'orgId' in app ? app.orgId : activeOrgId;
        if (!orgId) return;
        await runningApp.openApp(orgId, app);
        onDismiss?.();
      } catch (err) {
        setError(errorMessage(err));
      }
      return;
    }
    if (hit.kind === 'project' && hit.projectId) {
      onDismiss?.();
      navigate({ kind: 'project', projectId: hit.projectId, conversationId: null, fileName: null });
      return;
    }
    if (hit.kind === 'file' && hit.projectId && hit.fileName) {
      onDismiss?.();
      navigate({
        kind: 'project',
        projectId: hit.projectId,
        conversationId: null,
        fileName: hit.fileName,
      });
      return;
    }
    if (hit.kind === 'page' && hit.pageId) {
      onDismiss?.();
      navigate({ kind: 'home', view: 'pages', pageId: hit.pageId });
      return;
    }
    if (hit.kind === 'chat' && hit.channelId) {
      onDismiss?.();
      navigate({ kind: 'home', view: 'team', channelId: hit.channelId });
      return;
    }
    if (hit.kind === 'calendar') {
      onDismiss?.();
      navigate({ kind: 'home', view: 'calendar' });
      return;
    }
    if (hit.kind === 'app') {
      onDismiss?.();
      navigate({ kind: 'home', view: 'apps' });
    }
  }

  function onFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (hits.length === 0) return;
      setHighlight((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length === 0) return;
      setHighlight((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === 'Enter') {
      const hit = hits[highlight] ?? hits[0];
      if (!hit) return;
      event.preventDefault();
      void openHit(hit);
    }
  }

  const listId = palette ? 'org-search-palette-hit-list' : 'org-search-hit-list';
  const hitId = (index: number) => `${palette ? 'org-search-palette-hit' : 'org-search-hit'}-${index}`;
  const showingSearch = query.trim().length > 0;
  const hasResults = hits.length > 0;

  const searchField = (
    <div className={styles.searchWrap}>
      <span className={styles.searchIcon} aria-hidden="true">
        <Icon name="search" size={16} />
      </span>
      <Input
        ref={searchRef}
        type="search"
        className={styles.search}
        value={query}
        placeholder={t('search.placeholder')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onFieldKeyDown}
        aria-label={t('search.placeholder')}
        aria-controls={hasResults ? listId : undefined}
        aria-activedescendant={hasResults ? hitId(highlight) : undefined}
        data-testid={palette ? 'org-search-palette-input' : 'org-search-input'}
      />
      {query ? (
        <button
          type="button"
          className={styles.searchClear}
          onClick={() => {
            setQuery('');
            searchRef.current?.focus();
          }}
          aria-label={t('search.clear')}
        >
          ✕
        </button>
      ) : null}
    </div>
  );

  const results = (
    <>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <Button
          variant="ghost"
          onClick={() => setUploading(true)}
          data-testid="org-search-upload"
        >
          {t('search.uploadAssets')}
        </Button>
      </div>

      {showingSearch && searching && !hasResults ? (
        <div data-testid="org-search-results" className={styles.results}>
          <div className={styles.skeletonList}>
            <Skeleton height={54} shape="block" />
            <Skeleton height={54} shape="block" />
            <Skeleton height={54} shape="block" />
          </div>
        </div>
      ) : null}

      {showingSearch && !searching && !hasResults ? (
        <div data-testid="org-search-results" className={styles.results}>
          <EmptyState
            title={t('search.noResults', { query: query.trim() })}
            description={t('search.noResultsHint')}
          />
        </div>
      ) : null}

      {hasResults ? (
        <div data-testid="org-search-results" className={styles.results}>
          <ul id={listId} className={styles.resultList} role="listbox">
            {hits.map((hit, index) => (
              <li key={hit.id} id={hitId(index)}>
                <button
                  type="button"
                  className={`${styles.result}${index === highlight ? ` ${styles.resultActive}` : ''}`}
                  onClick={() => void openHit(hit)}
                  onMouseEnter={() => setHighlight(index)}
                  data-testid={`org-search-hit-${hit.kind}`}
                  role="option"
                  aria-selected={index === highlight}
                >
                  <span className={styles.resultIcon} aria-hidden="true">
                    <Icon name={kindIcon(hit.kind)} size={16} />
                  </span>
                  <span className={styles.resultMain}>
                    <span className={styles.resultLabel}>{hit.title}</span>
                    <span className={styles.resultSecondary}>
                      {kindLabel(hit.kind, t)}
                      {hit.ownerName ? ` · ${hit.ownerName}` : ''}
                      {hit.snippet ? ` · ${hit.snippet}` : ''}
                    </span>
                  </span>
                  {hit.updatedAt > 0 ? (
                    <span className={styles.resultMeta}>{relativeTime(hit.updatedAt, t)}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editing ? (
        <RecordEditor
          tableRef={editing.tableRef}
          recordId={editing.recordId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onDismiss?.();
          }}
        />
      ) : null}

      {uploading ? (
        <LibraryUploadModal
          seedFiles={null}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            onDismiss?.();
            navigate({ kind: 'home', view: 'library' });
          }}
        />
      ) : null}

      {importingUrl ? (
        <ToolBuilder
          initialMode="import"
          initialUrl={importingUrl}
          onClose={() => setImportingUrl(null)}
          onCreated={() => {
            setImportingUrl(null);
            onDismiss?.();
          }}
        />
      ) : null}
    </>
  );

  if (palette) {
    return (
      <div
        className={styles.paletteBackdrop}
        onClick={onDismiss}
        data-testid="org-search-palette"
      >
        <div
          className={styles.palette}
          role="dialog"
          aria-modal="true"
          aria-label={t('search.title')}
          onClick={(event) => event.stopPropagation()}
        >
          {searchField}
          {!activeOrgId ? (
            <EmptyState title={t('search.needOrg')} description={t('search.needOrgBody')} />
          ) : (
            results
          )}
        </div>
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <WorkspacePage testId="org-search" title={t('search.title')} lead={t('search.needOrgBody')}>
        <EmptyState title={t('search.needOrg')} description={t('search.needOrgBody')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      testId="org-search"
      eyebrow={activeOrg?.name}
      title={t('search.title')}
      lead={t('search.subtitle')}
      banner={searchField}
    >
      {results}
    </WorkspacePage>
  );
}
