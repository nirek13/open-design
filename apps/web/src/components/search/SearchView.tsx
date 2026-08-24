// Organization search: one box, natural language, reporting-chain scope.
//
// Finding something you already have is the common case, so the field takes
// focus on load. Results name themselves — a title, a source, a person — and
// open the same place the rest of the app would. Cmd+Space / Cmd+1
// (Ctrl+Space / Ctrl+1 on Windows/Linux) pull the same search up as a
// palette from anywhere.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState, Input, Skeleton } from '@open-design/components';
import type { OrgSearchHit, OrgSearchKind } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { fetchOrgApp, searchOrg } from '../../providers/registry';
import { navigate } from '../../router';
import { useOptionalRunningApp } from '../apps/RunningAppContext';
import { Icon } from '../Icon';
import { RecordEditor } from '../workspace-home/RecordEditor';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { relativeTime } from '../workspace/format';
import styles from './SearchView.module.css';

interface Props {
  active: boolean;
}

interface PaletteProps {
  open: boolean;
  onClose: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function kindIcon(kind: OrgSearchKind): 'folder' | 'file-text' | 'blocks' | 'message-circle' | 'history' | 'layout' {
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
  }
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
  const [hits, setHits] = useState<OrgSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ tableRef: string; recordId: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const palette = variant === 'palette';

  useEffect(() => {
    if (active) searchRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setSearching(false);
      setHighlight(0);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await searchOrg(activeOrgId, trimmed);
        setHits(next);
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

  async function openHit(hit: OrgSearchHit) {
    if (hit.kind === 'record' && hit.tableName && hit.recordId) {
      setEditing({ tableRef: hit.tableName, recordId: hit.recordId });
      return;
    }
    if (hit.kind === 'app' && hit.appId && activeOrgId && runningApp) {
      try {
        const app = await fetchOrgApp(activeOrgId, hit.appId);
        await runningApp.openApp(activeOrgId, app);
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

      {showingSearch ? (
        <div data-testid="org-search-results" className={styles.results}>
          {searching && !hasResults ? (
            <div className={styles.skeletonList}>
              <Skeleton height={54} shape="block" />
              <Skeleton height={54} shape="block" />
              <Skeleton height={54} shape="block" />
            </div>
          ) : null}
          {!searching && !hasResults ? (
            <EmptyState
              title={t('search.noResults', { query: query.trim() })}
              description={t('search.noResultsHint')}
            />
          ) : null}
          {hasResults ? (
            <ul id={listId} className={styles.resultList} role="listbox">
              {hits.map((hit, index) => (
                <li key={`${hit.kind}:${hit.id}`} id={hitId(index)}>
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
                        {t(`search.kind.${hit.kind}` as never)}
                        {hit.ownerName ? ` · ${hit.ownerName}` : ''}
                        {hit.snippet ? ` · ${hit.snippet}` : ''}
                      </span>
                    </span>
                    <span className={styles.resultMeta}>{relativeTime(hit.updatedAt, t)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <EmptyState title={t('search.emptyTitle')} description={t('search.scopeHint')} />
      )}

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
