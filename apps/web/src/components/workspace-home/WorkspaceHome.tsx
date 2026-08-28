// The company hub: Ask, Needs you, Data sources, Recent.
//
// Ask is the way work starts. Approvals that nobody looks at are the same as
// no approvals, so they come next. Recent work is the trail back. Search stays
// as a field on this page — not a second hero, not a dock destination.
// Create (new invoice, build a table) lives behind one control.
//
// Everything here is org-scoped. With no organization resolved the page shows
// its empty shape rather than failing, because the shell mounts this view
// whether or not the org layer answered yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { HubStatus, Proposal, WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  decideProposal,
  fetchHubStatus,
  fetchProposals,
  fetchRecentRecords,
  fetchWorkspaceTables,
  queryWorkspaceRecords,
  searchWorkspace,
  setUpHub,
  type SearchHit,
  type SearchResultGroup,
} from '../../providers/registry';
import { navigate } from '../../router';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { RecommendedStartRegion } from '../RecommendedStartRegion';
import type { Recommendation } from '../../onboarding/recommendation';
import type { OnboardingEntry } from '../../onboarding/onboarding-entry';
import type { ProjectMetadata } from '../../types';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { RecordGallery } from '../workspace/RecordGallery';
import { relativeTime, singularize } from '../workspace/format';
import { HubAskComposer } from './HubAskComposer';
import { RecordEditor } from './RecordEditor';
import { ToolBuilder } from './ToolBuilder';
import { LibraryUploadModal } from '../LibraryUploadModal';
import styles from './WorkspaceHome.module.css';

interface Props {
  active: boolean;
  defaultDesignSystemId?: string | null;
  initialPrompt?: string;
  onAskProject?: (
    payload: PluginLoopSubmit,
  ) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  recommendation?: Recommendation | null;
  onRecommendationStart?: (input: {
    name: string;
    prompt: string;
    metadata: ProjectMetadata;
    onboardingEntry: OnboardingEntry;
  }) => boolean | void | Promise<boolean | void>;
  onRecommendationDismiss?: () => void;
}

/** The documents a business runs on, in the order work flows through them. */
const DOCUMENT_TABLES = ['quotes', 'orders', 'invoices', 'payments'];
const HUB_TABLES = [...DOCUMENT_TABLES, 'customers'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function WorkspaceHome({
  active,
  defaultDesignSystemId,
  initialPrompt,
  onAskProject,
  recommendation,
  onRecommendationStart,
  onRecommendationDismiss,
}: Props) {
  const t = useT();
  // The entry shell mounts this view, so it must survive rendering without a
  // provider above it — every load path below already treats a null org as
  // "nothing to show yet", which is the right thing to fall back to.
  const { activeOrgId, activeOrg } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchResultGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [editing, setEditing] = useState<{ tableRef: string; recordId?: string } | null>(null);
  const [buildingTool, setBuildingTool] = useState(false);
  const [builderMode, setBuilderMode] = useState<'choose' | 'import'>('choose');
  const [importSeedUrl, setImportSeedUrl] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sourcePreviews, setSourcePreviews] = useState<Array<{ table: WorkspaceTable; records: WorkspaceRecord[] }>>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [nextTables, nextHub, nextRecent, nextProposals] = await Promise.all([
        fetchWorkspaceTables(activeOrgId),
        fetchHubStatus(activeOrgId),
        fetchRecentRecords(activeOrgId),
        fetchProposals(activeOrgId, 'pending'),
      ]);
      setTables(nextTables);
      setHub(nextHub);
      setRecent(nextRecent);
      setProposals(nextProposals);
      const custom = nextTables.filter((table) => !HUB_TABLES.includes(table.name)).slice(0, 4);
      const previews = await Promise.all(
        custom.map(async (table) => {
          try {
            const queried = await queryWorkspaceRecords(activeOrgId, table.name, { limit: 6 });
            return { table, records: queried.records };
          } catch {
            return { table, records: [] };
          }
        }),
      );
      setSourcePreviews(previews.filter((item) => item.records.length > 0));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  // Search as you type, but not on every keystroke — a short pause keeps the
  // request count sane without ever feeling like a submit button.
  useEffect(() => {
    if (!active || !activeOrgId) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setGroups([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        setGroups(await searchWorkspace(activeOrgId, trimmed));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [active, activeOrgId, query]);

  useEffect(() => {
    if (!createOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (createMenuRef.current && target && createMenuRef.current.contains(target)) return;
      setCreateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreateOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [createOpen]);

  const documentTables = useMemo(
    () => DOCUMENT_TABLES.map((name) => tables.find((table) => table.name === name)).filter(Boolean) as WorkspaceTable[],
    [tables],
  );
  const customTables = useMemo(
    () => tables.filter((table) => !HUB_TABLES.includes(table.name)),
    [tables],
  );

  async function handleSetUpHub() {
    if (!activeOrgId || busy) return;
    setBusy(true);
    try {
      await setUpHub(activeOrgId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecide(proposal: Proposal, decision: 'approve' | 'reject') {
    if (!activeOrgId) return;
    try {
      await decideProposal(activeOrgId, proposal.id, decision);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const hasResults = groups.length > 0;
  const showingSearch = query.trim().length > 0;
  const showSkeletons = !loaded && !error;

  function openCreate(action: () => void) {
    setCreateOpen(false);
    action();
  }

  const createItems = [
    ...documentTables.map((table) => ({
      key: table.id,
      testId: `workspace-new-${table.name}`,
      label: t('workspace.newOf', { name: singularize(table.displayName || table.name) }),
      onClick: () => openCreate(() => setEditing({ tableRef: table.name })),
    })),
    ...customTables.map((table) => ({
      key: table.id,
      testId: `workspace-new-${table.name}`,
      label: t('workspace.newOf', { name: singularize(table.displayName || table.name) }),
      onClick: () => openCreate(() => setEditing({ tableRef: table.name })),
    })),
    {
      key: 'build',
      testId: 'workspace-build-tool',
      label: t('workspace.buildTool'),
      onClick: () => openCreate(() => {
        setImportSeedUrl(null);
        setBuilderMode('choose');
        setBuildingTool(true);
      }),
    },
    {
      key: 'import',
      testId: 'workspace-magic-import',
      label: t('workspace.magicImport'),
      onClick: () => openCreate(() => {
        setImportSeedUrl(null);
        setBuilderMode('import');
        setBuildingTool(true);
      }),
    },
    {
      key: 'upload',
      testId: 'workspace-upload-assets',
      label: t('workspace.uploadAssets'),
      onClick: () => openCreate(() => setUploading(true)),
    },
  ];

  return (
    <WorkspacePage
      testId="workspace-home"
      eyebrow={activeOrg?.name}
      title={t('workspace.title')}
      lead={t('workspace.subtitle')}
      actions={
        <div className={styles.createMenuWrap} ref={createMenuRef}>
          <Button
            variant="ghost"
            onClick={() => setCreateOpen((open) => !open)}
            aria-expanded={createOpen}
            aria-haspopup="menu"
            data-testid="workspace-create"
          >
            {t('workspace.createTitle')}
          </Button>
          {createOpen ? (
            <div className={styles.createMenu} role="menu" data-testid="workspace-create-menu">
              {createItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={styles.createMenuItem}
                  role="menuitem"
                  data-testid={item.testId}
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      }
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.intro}>
        {onAskProject ? (
          <HubAskComposer
            orgId={activeOrgId}
            defaultDesignSystemId={defaultDesignSystemId}
            initialPrompt={initialPrompt}
            onAskProject={onAskProject}
            onProposalCreated={load}
            onImportUrl={(url) => {
              setImportSeedUrl(url);
              setBuilderMode('import');
              setBuildingTool(true);
            }}
          />
        ) : null}

        <div className={styles.searchWrap}>
        <span className={styles.searchIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <Input
          ref={searchRef}
          type="search"
          className={styles.search}
          value={query}
          placeholder={t('workspace.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('workspace.searchPlaceholder')}
          data-testid="workspace-search"
        />
        {query ? (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            aria-label={t('workspace.clearSearch')}
          >
            ✕
          </button>
        ) : null}
        </div>
      </div>

      {recommendation && onRecommendationStart && onRecommendationDismiss ? (
        <RecommendedStartRegion
          recommendation={recommendation}
          onStart={onRecommendationStart}
          onDismiss={onRecommendationDismiss}
        />
      ) : null}

      {showingSearch ? (
        <div data-testid="workspace-search-results" className={styles.searchResults}>
          {searching && !hasResults ? (
            <div className={styles.skeletonList}>
              <Skeleton height={54} shape="block" />
              <Skeleton height={54} shape="block" />
            </div>
          ) : null}
          {!searching && !hasResults ? (
            <EmptyState
              title={t('workspace.noResults', { query: query.trim() })}
              description={t('workspace.noResultsHint')}
            />
          ) : null}
          {groups.map((group) => (
            <WorkspaceSection
              key={group.tableId}
              title={group.tableDisplayName}
              action={<span className={styles.countChip}>{group.total}</span>}
            >
              <ul className={styles.resultList}>
                {group.hits.map((hit) => (
                  <li key={hit.recordId}>
                    <button
                      type="button"
                      className={styles.result}
                      onClick={() => setEditing({ tableRef: hit.tableName, recordId: hit.recordId })}
                    >
                      <span className={styles.resultMain}>
                        <span className={styles.resultLabel}>{hit.label}</span>
                        {hit.secondary ? (
                          <span className={styles.resultSecondary}>{hit.secondary}</span>
                        ) : null}
                      </span>
                      <span className={styles.resultMeta}>{relativeTime(hit.updatedAt, t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </WorkspaceSection>
          ))}
        </div>
      ) : (
        <>
          {hub && !hub.ready ? (
            <section className={styles.setupCard} data-testid="workspace-hub-setup">
              <div className={styles.setupText}>
                <h2 className={styles.setupTitle}>{t('workspace.setUpTitle')}</h2>
                <p className={styles.setupBody}>{t('workspace.setUpBody')}</p>
              </div>
              <Button variant="primary" onClick={handleSetUpHub} disabled={busy}>
                {busy ? t('workspace.settingUp') : t('workspace.setUpAction')}
              </Button>
            </section>
          ) : null}

          {proposals.length > 0 ? (
            <WorkspaceSection
              title={t('workspace.needsYou')}
              action={<Badge tone="warning">{proposals.length}</Badge>}
              testId="workspace-proposals"
            >
              <ul className={styles.proposalList}>
                {proposals.map((proposal) => (
                  <li key={proposal.id} className={styles.proposal}>
                    <div className={styles.proposalBody}>
                      <span className={styles.proposalIntent}>{proposal.intent}</span>
                      {/* The preview is the point: approving is a decision about a
                          described outcome, never a leap of faith. */}
                      <ul className={styles.proposalLines}>
                        {proposal.preview.lines.slice(0, 3).map((line, index) => (
                          <li key={index} className={styles.proposalLine}>
                            {line.summary}
                            {line.detail ? <em className={styles.proposalDetail}> — {line.detail}</em> : null}
                          </li>
                        ))}
                      </ul>
                      {proposal.preview.warnings.length > 0 ? (
                        <span className={styles.proposalWarning}>
                          {proposal.preview.warnings[0]}
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.proposalActions}>
                      <Button variant="primary" onClick={() => handleDecide(proposal, 'approve')}>
                        {t('workspace.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => handleDecide(proposal, 'reject')}>
                        {t('workspace.reject')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </WorkspaceSection>
          ) : null}

          {sourcePreviews.length > 0 ? (
            <WorkspaceSection title={t('workspace.dataSources')} testId="workspace-data-sources">
              <div className={styles.sources}>
                {sourcePreviews.map(({ table, records }) => (
                  <section key={table.id} className={styles.source} data-testid={`workspace-source-${table.name}`}>
                    <header className={styles.sourceHead}>
                      <h3 className={styles.sourceTitle}>{table.displayName}</h3>
                      <Button
                        variant="ghost"
                        onClick={() => navigate({ kind: 'home', view: 'tables', tableName: table.name })}
                      >
                        {t('workspace.openTable')}
                      </Button>
                    </header>
                    <RecordGallery
                      fields={table.fields}
                      records={records}
                      testId={`source-gallery-${table.name}`}
                      onOpen={(recordId) => setEditing({ tableRef: table.name, recordId })}
                    />
                  </section>
                ))}
              </div>
            </WorkspaceSection>
          ) : null}

          <WorkspaceSection title={t('workspace.recent')}>
            {showSkeletons ? (
              <div className={styles.skeletonList}>
                <Skeleton height={44} shape="block" />
                <Skeleton height={44} shape="block" />
                <Skeleton height={44} shape="block" />
              </div>
            ) : recent.length === 0 ? (
              <EmptyState
                size="compact"
                title={t('workspace.noRecent')}
                description={t('workspace.noRecentHint')}
              />
            ) : (
              <ul className={styles.resultList}>
                {recent.map((hit) => (
                  <li key={hit.recordId}>
                    <button
                      type="button"
                      className={styles.result}
                      onClick={() => setEditing({ tableRef: hit.tableName, recordId: hit.recordId })}
                    >
                      <span className={styles.resultMain}>
                        <span className={styles.resultLabel}>{hit.label}</span>
                        <span className={styles.resultSecondary}>
                          {hit.tableDisplayName}
                          {hit.secondary ? ` · ${hit.secondary}` : ''}
                        </span>
                      </span>
                      <span className={styles.resultMeta}>{relativeTime(hit.updatedAt, t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </WorkspaceSection>
        </>
      )}

      {editing ? (
        <RecordEditor
          tableRef={editing.tableRef}
          {...(editing.recordId ? { recordId: editing.recordId } : {})}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}

      {buildingTool ? (
        <ToolBuilder
          initialMode={builderMode}
          {...(importSeedUrl ? { initialUrl: importSeedUrl } : {})}
          onClose={() => {
            setBuildingTool(false);
            setImportSeedUrl(null);
          }}
          onCreated={async () => {
            setBuildingTool(false);
            setImportSeedUrl(null);
            await load();
          }}
          onReload={load}
          {...(onAskProject ? { onAskProject } : {})}
        />
      ) : null}

      {uploading ? (
        <LibraryUploadModal
          seedFiles={null}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            navigate({ kind: 'home', view: 'library' });
          }}
        />
      ) : null}
    </WorkspacePage>
  );
}
