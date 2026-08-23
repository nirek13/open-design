// The main view: find anything, open anything, make anything.
//
// The order of this page is the order of the work. Search sits at the top and
// takes focus on load, because finding something you already have is the
// common case. Anything waiting on a person comes next — an approval nobody
// looks at is the same as no approval at all. Then the numbers worth a glance,
// then the ways to make something new, then what was touched recently.
//
// Everything here is org-scoped. With no organization resolved the page shows
// its empty shape rather than failing, because the shell mounts this view
// whether or not the org layer answered yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { HubStatus, Proposal, SavedQuestionAnswer, WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  decideProposal,
  fetchHomeWidgets,
  fetchHubStatus,
  fetchProposals,
  fetchRecentRecords,
  fetchWorkspaceTables,
  searchWorkspace,
  setUpHub,
  type SearchHit,
  type SearchResultGroup,
} from '../../providers/registry';
import { navigate } from '../../router';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { StatCard } from '../workspace/StatCard';
import { formatMoney, relativeTime, singularize } from '../workspace/format';
import { RecordEditor } from './RecordEditor';
import { ToolBuilder } from './ToolBuilder';
import styles from './WorkspaceHome.module.css';

interface Props {
  active: boolean;
}

/** The documents a business runs on, in the order work flows through them. */
const DOCUMENT_TABLES = ['quotes', 'orders', 'invoices', 'payments'];
const HUB_TABLES = [...DOCUMENT_TABLES, 'customers'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Widget values are counts or money depending on what was asked. Money is
 * integer minor units; a count is just a count. */
function formatWidgetValue(widget: SavedQuestionAnswer): string {
  if (widget.value === null || widget.value === undefined) return '—';
  if (typeof widget.value !== 'number') return String(widget.value);
  const op = widget.question.aggregate?.op;
  const isMoney = op === 'sum' || op === 'avg' || op === 'min' || op === 'max';
  return isMoney ? formatMoney(widget.value) : String(widget.value);
}

export function WorkspaceHome({ active }: Props) {
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
  const [widgets, setWidgets] = useState<SavedQuestionAnswer[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [editing, setEditing] = useState<{ tableRef: string; recordId?: string } | null>(null);
  const [buildingTool, setBuildingTool] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [nextTables, nextHub, nextRecent, nextWidgets, nextProposals] = await Promise.all([
        fetchWorkspaceTables(activeOrgId),
        fetchHubStatus(activeOrgId),
        fetchRecentRecords(activeOrgId),
        fetchHomeWidgets(activeOrgId),
        fetchProposals(activeOrgId, 'pending'),
      ]);
      setTables(nextTables);
      setHub(nextHub);
      setRecent(nextRecent);
      setWidgets(nextWidgets);
      setProposals(nextProposals);
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
    if (active) searchRef.current?.focus();
  }, [active]);

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

  const searchField = (
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
  );

  return (
    <WorkspacePage
      testId="workspace-home"
      eyebrow={activeOrg?.name}
      title={t('workspace.title')}
      lead={t('workspace.subtitle')}
      banner={searchField}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate({ kind: 'home', view: 'database' })}>
            {t('workspace.openDatabase')}
          </Button>
          <Button variant="primary" onClick={() => setBuildingTool(true)} data-testid="workspace-build-tool">
            {t('workspace.buildTool')}
          </Button>
        </>
      }
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
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

          {widgets.length > 0 ? (
            <WorkspaceSection title={t('workspace.pinned')} testId="workspace-widgets">
              <div className={styles.widgetGrid}>
                {widgets.map((widget) => (
                  <StatCard
                    key={widget.question.id}
                    label={widget.question.question}
                    value={formatWidgetValue(widget)}
                    detail={
                      widget.count !== undefined && widget.count !== null
                        ? t('workspace.acrossRecords', { count: String(widget.count) })
                        : undefined
                    }
                  />
                ))}
              </div>
            </WorkspaceSection>
          ) : null}

          <WorkspaceSection title={t('workspace.createTitle')}>
            {showSkeletons ? (
              <div className={styles.createGrid}>
                <Skeleton shape="block" height={74} />
                <Skeleton shape="block" height={74} />
                <Skeleton shape="block" height={74} />
              </div>
            ) : (
              <div className={styles.createGrid}>
                {documentTables.map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    className={styles.createCard}
                    onClick={() => setEditing({ tableRef: table.name })}
                    data-testid={`workspace-new-${table.name}`}
                  >
                    <span className={styles.createCardName}>
                      {t('workspace.newOf', { name: singularize(table.displayName || table.name) })}
                    </span>
                    <span className={styles.createCardHint}>
                      {t('workspace.newOfHint', {
                        name: singularize(table.displayName || table.name).toLowerCase(),
                      })}
                    </span>
                  </button>
                ))}
                {customTables.map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    className={styles.createCard}
                    onClick={() => setEditing({ tableRef: table.name })}
                    data-testid={`workspace-new-${table.name}`}
                  >
                    <span className={styles.createCardName}>
                      {t('workspace.newOf', { name: singularize(table.displayName || table.name) })}
                    </span>
                    <span className={styles.createCardHint}>{t('workspace.yourTable')}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={`${styles.createCard} ${styles.createCardAccent}`}
                  onClick={() => setBuildingTool(true)}
                >
                  <span className={styles.createCardName}>{t('workspace.buildTool')}</span>
                  <span className={styles.createCardHint}>{t('workspace.buildToolHint')}</span>
                </button>
              </div>
            )}
          </WorkspaceSection>

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
          onClose={() => setBuildingTool(false)}
          onCreated={async () => {
            setBuildingTool(false);
            await load();
          }}
        />
      ) : null}
    </WorkspacePage>
  );
}
