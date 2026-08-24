// Live GitHub hub. Repos stay on GitHub; this view talks to
// `/api/orgs/:orgId/github/*`, which proxies Composio. Connect uses the same
// Integrations path as Mail (`connectConnector('github')`).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, Input, Skeleton, Textarea } from '@open-design/components';
import type {
  GithubComment,
  GithubCommit,
  GithubIssue,
  GithubNotification,
  GithubProfile,
  GithubPullRequest,
  GithubRepo,
  GithubWorkflowRun,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  commentOrgGithubIssue,
  connectConnector,
  createOrgGithubIssue,
  fetchConnectorStatuses,
  fetchOrgGithubIssueDetail,
  fetchOrgGithubNotifications,
  fetchOrgGithubPullDetail,
  fetchOrgGithubRepoDetail,
  fetchOrgGithubRepos,
  fetchOrgGithubStatus,
  importGitHubDesignSystem,
  mergeOrgGithubPull,
  starOrgGithubRepo,
} from '../../providers/registry';
import { navigate } from '../../router';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { Icon } from '../Icon';
import styles from './DevView.module.css';

const GITHUB_CONNECTOR_ID = 'github';
const AUTH_POLL_MS = 2500;
const AUTH_POLL_MAX_MS = 3 * 60 * 1000;

type Tab = 'pulls' | 'issues' | 'actions' | 'commits' | 'inbox';
type StatusMap = Awaited<ReturnType<typeof fetchConnectorStatuses>>;
type Selection =
  | { kind: 'pull'; number: number }
  | { kind: 'issue'; number: number }
  | { kind: 'commit'; sha: string }
  | { kind: 'run'; id: string };

interface Props {
  active: boolean;
  initialOwner?: string;
  initialRepo?: string;
  onReviewWithAgent?: (payload: PluginLoopSubmit) => void;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isGithubConnected(statuses: StatusMap | null | undefined): boolean {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
  const entry = (statuses as Record<string, { status?: string }>)[GITHUB_CONNECTOR_ID];
  return entry?.status === 'connected';
}

async function waitForGithubConnected(signal: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < AUTH_POLL_MAX_MS) {
    const statuses = await fetchConnectorStatuses();
    if (isGithubConnected(statuses)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, AUTH_POLL_MS));
  }
  return false;
}

function repoKey(repo: Pick<GithubRepo, 'owner' | 'name'>): string {
  return `${repo.owner}/${repo.name}`;
}

function formatWhen(value: string | null): string {
  if (!value) return '';
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return '';
  const date = new Date(instant);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function githubConnectorContext() {
  return [{
    id: GITHUB_CONNECTOR_ID,
    name: 'GitHub',
    provider: 'github',
    category: 'code',
    status: 'connected',
  }];
}

export function DevView({ active, initialOwner, initialRepo, onReviewWithAgent }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [connected, setConnected] = useState(false);
  const [statusReady, setStatusReady] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [profile, setProfile] = useState<GithubProfile | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [tab, setTab] = useState<Tab>('pulls');
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialOwner && initialRepo ? `${initialOwner}/${initialRepo}` : null,
  );
  const [detail, setDetail] = useState<{
    repo: GithubRepo | null;
    pulls: GithubPullRequest[];
    issues: GithubIssue[];
    commits: GithubCommit[];
    workflowRuns: GithubWorkflowRun[];
  } | null>(null);
  const [notifications, setNotifications] = useState<GithubNotification[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pull, setPull] = useState<GithubPullRequest | null>(null);
  const [issue, setIssue] = useState<GithubIssue | null>(null);
  const [comments, setComments] = useState<GithubComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [issueTitle, setIssueTitle] = useState('');
  const [issueBody, setIssueBody] = useState('');
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const authAbortRef = useRef<AbortController | null>(null);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repoKey(repo) === selectedKey) ?? detail?.repo ?? null,
    [detail?.repo, repos, selectedKey],
  );

  const reloadRepos = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const listed = await fetchOrgGithubRepos(activeOrgId, { query: query || undefined });
      setConnected(listed.connected);
      setProfile(listed.profile);
      setRepos(listed.repos);
    } catch (err) {
      setError(asError(err));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, query]);

  const reloadStatus = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [status, statuses] = await Promise.all([
        fetchOrgGithubStatus(activeOrgId),
        fetchConnectorStatuses().catch(() => null),
      ]);
      setConnected(Boolean(status.connected || isGithubConnected(statuses)));
      setProfile(status.profile);
    } catch (err) {
      setError(asError(err));
    } finally {
      setStatusReady(true);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void reloadStatus();
  }, [active, reloadStatus]);

  useEffect(() => {
    if (!active || !connected) return;
    void reloadRepos();
  }, [active, connected, reloadRepos]);

  useEffect(() => {
    if (initialOwner && initialRepo) setSelectedKey(`${initialOwner}/${initialRepo}`);
  }, [initialOwner, initialRepo]);

  useEffect(() => {
    if (!active || !activeOrgId || !connected || !selectedKey) {
      setDetail(null);
      return;
    }
    const [owner, name] = selectedKey.split('/');
    if (!owner || !name) return;
    let cancelled = false;
    setDetailLoading(true);
    void fetchOrgGithubRepoDetail(activeOrgId, owner, name)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        navigate({ kind: 'home', view: 'dev', owner, repo: name });
      })
      .catch((err) => {
        if (!cancelled) setError(asError(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, connected, selectedKey]);

  useEffect(() => {
    if (!active || !activeOrgId || !connected || tab !== 'inbox') return;
    let cancelled = false;
    void fetchOrgGithubNotifications(activeOrgId)
      .then((result) => {
        if (!cancelled) setNotifications(result.notifications);
      })
      .catch((err) => {
        if (!cancelled) setError(asError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, connected, tab]);

  useEffect(() => {
    if (!active || !activeOrgId || !selectedRepo || !selection) {
      setPull(null);
      setIssue(null);
      setComments([]);
      return;
    }
    if (selection.kind !== 'pull' && selection.kind !== 'issue') return;
    let cancelled = false;
    const load = selection.kind === 'pull'
      ? fetchOrgGithubPullDetail(activeOrgId, selectedRepo.owner, selectedRepo.name, selection.number)
      : fetchOrgGithubIssueDetail(activeOrgId, selectedRepo.owner, selectedRepo.name, selection.number);
    void load
      .then((result) => {
        if (cancelled) return;
        if ('pull' in result) {
          setPull(result.pull);
          setIssue(null);
        } else {
          setIssue(result.issue);
          setPull(null);
        }
        setComments(result.comments);
      })
      .catch((err) => {
        if (!cancelled) setError(asError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, selectedRepo, selection]);

  useEffect(() => () => {
    authAbortRef.current?.abort();
  }, []);

  async function onConnectGithub() {
    if (!activeOrgId || connecting || authPending) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectConnector(GITHUB_CONNECTOR_ID);
      if (result.error) {
        setError(/composio|not configured|api key/i.test(result.error) ? t('github.composioRequired') : result.error);
        return;
      }
      if (result.connector?.status === 'connected') {
        setConnected(true);
        setAuthPending(false);
        await reloadStatus();
        return;
      }
      setAuthPending(true);
      authAbortRef.current?.abort();
      const controller = new AbortController();
      authAbortRef.current = controller;
      const ok = await waitForGithubConnected(controller.signal);
      if (controller.signal.aborted) return;
      if (ok) {
        setConnected(true);
        setAuthPending(false);
        await reloadStatus();
      } else {
        setAuthPending(false);
        setError(t('github.connectTimeout'));
      }
    } catch (err) {
      setError(asError(err));
      setAuthPending(false);
    } finally {
      setConnecting(false);
    }
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setQuery(searchInput.trim());
  }

  async function onStar() {
    if (!activeOrgId || !selectedRepo || busy) return;
    setBusy(true);
    setError(null);
    try {
      await starOrgGithubRepo(activeOrgId, selectedRepo.owner, selectedRepo.name);
      setRepos((prev) => prev.map((repo) => (
        repoKey(repo) === repoKey(selectedRepo) ? { ...repo, stars: repo.stars + 1 } : repo
      )));
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImportDesignSystem() {
    if (!selectedRepo || busy) return;
    setBusy(true);
    setError(null);
    setImportNote(null);
    try {
      const result = await importGitHubDesignSystem({ githubUrl: selectedRepo.htmlUrl });
      if ('error' in result) {
        setError(result.error.message);
        return;
      }
      setImportNote(t('github.imported'));
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  }

  function reviewPrompt(): string | null {
    if (!selectedRepo) return null;
    if (selection?.kind === 'pull' && pull) {
      return [
        `Review pull request #${pull.number} in ${selectedRepo.fullName}.`,
        `Title: ${pull.title}`,
        `URL: ${pull.htmlUrl}`,
        pull.body ? `Description:\n${pull.body}` : '',
        'Call out design-system, UX, and merge risks. Suggest comments I can paste on GitHub.',
      ].filter(Boolean).join('\n\n');
    }
    if (selection?.kind === 'issue' && issue) {
      return [
        `Triage issue #${issue.number} in ${selectedRepo.fullName}.`,
        `Title: ${issue.title}`,
        `URL: ${issue.htmlUrl}`,
        issue.body ? `Description:\n${issue.body}` : '',
        'Propose a fix plan that fits this product: agent chat, design systems, and connected GitHub work.',
      ].filter(Boolean).join('\n\n');
    }
    return [
      `Use the connected GitHub account to inspect ${selectedRepo.fullName}.`,
      selectedRepo.description ? `Description: ${selectedRepo.description}` : '',
      `URL: ${selectedRepo.htmlUrl}`,
      'Summarize open PRs and issues, then recommend the next design or engineering move in this workspace.',
    ].filter(Boolean).join('\n\n');
  }

  function onReviewWithAgentClick() {
    const prompt = reviewPrompt();
    if (!prompt || !onReviewWithAgent) return;
    void onReviewWithAgent({
      prompt,
      pluginId: null,
      appliedPluginSnapshotId: null,
      pluginTitle: selectedRepo ? `Review ${selectedRepo.fullName}` : 'GitHub review',
      taskKind: null,
      contextConnectors: githubConnectorContext(),
    });
  }

  async function onComment() {
    if (!activeOrgId || !selectedRepo || !commentBody.trim() || busy) return;
    const number = selection?.kind === 'pull' || selection?.kind === 'issue' ? selection.number : null;
    if (number == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commentOrgGithubIssue(
        activeOrgId,
        selectedRepo.owner,
        selectedRepo.name,
        number,
        { body: commentBody.trim() },
      );
      if (result.comment) setComments((prev) => [...prev, result.comment!]);
      setCommentBody('');
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onMerge() {
    if (!activeOrgId || !selectedRepo || selection?.kind !== 'pull' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mergeOrgGithubPull(
        activeOrgId,
        selectedRepo.owner,
        selectedRepo.name,
        selection.number,
        { method: 'squash' },
      );
      if (result.pull) setPull(result.pull);
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreateIssue(event: FormEvent) {
    event.preventDefault();
    if (!activeOrgId || !selectedRepo || !issueTitle.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createOrgGithubIssue(
        activeOrgId,
        selectedRepo.owner,
        selectedRepo.name,
        { title: issueTitle.trim(), body: issueBody.trim() || undefined },
      );
      if (result.issue) {
        setDetail((prev) => (prev ? { ...prev, issues: [result.issue!, ...prev.issues] } : prev));
        setSelection({ kind: 'issue', number: result.issue.number });
      }
      setIssueTitle('');
      setIssueBody('');
      setCreatingIssue(false);
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!activeOrgId) {
    return (
      <div className={styles.root} data-testid="dev-view">
        <EmptyState title={t('github.needOrg')} description={t('github.needOrgBody')} />
      </div>
    );
  }

  const statusClass = connected
    ? styles.statusConnected
    : authPending
      ? styles.statusPending
      : styles.statusIdle;
  const statusLabel = connected
    ? (profile?.login ?? t('github.statusConnected'))
    : authPending
      ? t('github.statusPending')
      : t('github.statusDisconnected');
  const showComposioCta = Boolean(error && /composio|api key|Integrations/i.test(error));
  const emptyListKey = (
    tab === 'inbox' ? 'github.emptyInbox'
      : tab === 'pulls' ? 'github.emptyPulls'
        : tab === 'issues' ? 'github.emptyIssues'
          : tab === 'actions' ? 'github.emptyActions'
            : 'github.emptyCommits'
  ) as 'github.emptyInbox';
  const listEmpty = tab === 'inbox'
    ? notifications.length === 0
    : tab === 'pulls'
      ? (detail?.pulls.length ?? 0) === 0
      : tab === 'issues'
        ? (detail?.issues.length ?? 0) === 0
        : tab === 'actions'
          ? (detail?.workflowRuns.length ?? 0) === 0
          : (detail?.commits.length ?? 0) === 0;

  return (
    <div className={styles.root} data-testid="dev-view">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t('github.title')}</h1>
            <span className={`${styles.statusPill} ${statusClass}`}>{statusLabel}</span>
          </div>
          <p className={styles.subtitle}>{t('github.subtitle')}</p>
        </div>
        <div className={styles.headerActions}>
          <form className={styles.search} onSubmit={onSearch}>
            <Icon name="search" size={14} />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('github.searchPlaceholder')}
              aria-label={t('github.search')}
            />
          </form>
          {connected ? (
            <Button variant="ghost" onClick={() => void reloadRepos()} disabled={loading}>
              {t('github.refresh')}
            </Button>
          ) : (
            <Button
              disabled={connecting || authPending}
              onClick={() => void onConnectGithub()}
              data-testid="dev-connect"
            >
              {connecting || authPending ? t('github.connecting') : t('github.connectGithub')}
            </Button>
          )}
        </div>
      </header>

      {error ? (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          {showComposioCta ? (
            <Button variant="ghost" onClick={() => navigate({ kind: 'home', view: 'integrations' })}>
              {t('github.openIntegrations')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!statusReady ? (
        <Skeleton className={styles.skeleton} />
      ) : !connected ? (
        <EmptyState
          title={t('github.statusDisconnected')}
          description={t('github.disconnectedBody')}
          action={(
            <Button disabled={connecting || authPending} onClick={() => void onConnectGithub()} data-testid="dev-connect">
              {connecting || authPending ? t('github.connecting') : t('github.connectGithub')}
            </Button>
          )}
        />
      ) : (
        <div className={styles.layout}>
          <nav className={styles.repos} aria-label={t('github.title')}>
            {loading && repos.length === 0 ? (
              Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={styles.skeleton} />)
            ) : repos.length === 0 ? (
              <p className={styles.emptyList}>{t('github.emptyRepos')}</p>
            ) : repos.map((repo) => {
              const activeRepo = repoKey(repo) === selectedKey;
              return (
                <button
                  key={repo.id}
                  type="button"
                  className={`${styles.row}${activeRepo ? ` ${styles.rowActive}` : ''}`}
                  onClick={() => {
                    setSelectedKey(repoKey(repo));
                    setSelection(null);
                    setImportNote(null);
                  }}
                >
                  <span className={styles.rowTitle}>{repo.fullName}</span>
                  <span className={styles.rowMeta}>
                    {repo.private ? `${t('github.private')} · ` : ''}
                    {repo.language ?? repo.defaultBranch}
                    {` · ${repo.stars}`}
                  </span>
                </button>
              );
            })}
          </nav>

          <section className={styles.list}>
            <div className={styles.tabs} role="tablist">
              {(['pulls', 'issues', 'actions', 'commits', 'inbox'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className={`${styles.tab}${tab === id ? ` ${styles.tabActive}` : ''}`}
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                    setSelection(null);
                    setCreatingIssue(false);
                  }}
                >
                  {t(`github.${id}`)}
                </button>
              ))}
            </div>
            {tab === 'issues' && selectedRepo ? (
              <div className={styles.actions}>
                <Button variant="ghost" onClick={() => setCreatingIssue((open) => !open)}>
                  {t('github.createIssue')}
                </Button>
              </div>
            ) : null}
            {detailLoading && tab !== 'inbox' ? (
              Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className={styles.skeleton} />)
            ) : listEmpty ? (
              <p className={styles.emptyList}>{t(emptyListKey)}</p>
            ) : tab === 'pulls' ? (
              (detail?.pulls ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.row}${selection?.kind === 'pull' && selection.number === item.number ? ` ${styles.rowActive}` : ''}`}
                  onClick={() => setSelection({ kind: 'pull', number: item.number })}
                >
                  <span className={styles.rowTitle}>#{item.number} {item.title}</span>
                  <span className={styles.rowMeta}>
                    {item.draft ? `${t('github.draft')} · ` : ''}
                    {item.state}
                    {item.user?.login ? ` · ${item.user.login}` : ''}
                    {item.updatedAt ? ` · ${formatWhen(item.updatedAt)}` : ''}
                  </span>
                </button>
              ))
            ) : tab === 'issues' ? (
              (detail?.issues ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.row}${selection?.kind === 'issue' && selection.number === item.number ? ` ${styles.rowActive}` : ''}`}
                  onClick={() => setSelection({ kind: 'issue', number: item.number })}
                >
                  <span className={styles.rowTitle}>#{item.number} {item.title}</span>
                  <span className={styles.rowMeta}>
                    {item.state}
                    {item.labels.length > 0 ? ` · ${item.labels.join(', ')}` : ''}
                    {item.updatedAt ? ` · ${formatWhen(item.updatedAt)}` : ''}
                  </span>
                </button>
              ))
            ) : tab === 'actions' ? (
              (detail?.workflowRuns ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.row}${selection?.kind === 'run' && selection.id === item.id ? ` ${styles.rowActive}` : ''}`}
                  onClick={() => setSelection({ kind: 'run', id: item.id })}
                >
                  <span className={styles.rowTitle}>{item.name}</span>
                  <span className={styles.rowMeta}>
                    {item.conclusion ?? item.status}
                    {item.headBranch ? ` · ${item.headBranch}` : ''}
                    {item.createdAt ? ` · ${formatWhen(item.createdAt)}` : ''}
                  </span>
                </button>
              ))
            ) : tab === 'commits' ? (
              (detail?.commits ?? []).map((item) => (
                <button
                  key={item.sha}
                  type="button"
                  className={`${styles.row}${selection?.kind === 'commit' && selection.sha === item.sha ? ` ${styles.rowActive}` : ''}`}
                  onClick={() => setSelection({ kind: 'commit', sha: item.sha })}
                >
                  <span className={styles.rowTitle}>{item.message.split('\n')[0]}</span>
                  <span className={styles.rowMeta}>
                    {item.sha.slice(0, 7)}
                    {item.author ? ` · ${item.author}` : ''}
                    {item.date ? ` · ${formatWhen(item.date)}` : ''}
                  </span>
                </button>
              ))
            ) : (
              notifications.map((item) => (
                <a
                  key={item.id}
                  className={styles.row}
                  href={item.htmlUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowMeta}>
                    {item.repository}
                    {` · ${item.reason}`}
                    {item.updatedAt ? ` · ${formatWhen(item.updatedAt)}` : ''}
                  </span>
                </a>
              ))
            )}
          </section>

          <section className={styles.detail}>
            {!selectedRepo ? (
              <EmptyState title={t('github.noSelection')} description={t('github.noSelectionBody')} />
            ) : (
              <>
                <h2 className={styles.detailTitle}>
                  {selectedRepo.fullName}
                  {' '}
                  {selectedRepo.private ? <span className={styles.badge}>{t('github.private')}</span> : null}
                </h2>
                <p className={styles.detailBody}>{selectedRepo.description ?? t('github.noBody')}</p>
                <div className={styles.actions}>
                  <Button variant="ghost" onClick={() => window.open(selectedRepo.htmlUrl, '_blank', 'noopener')}>
                    {t('github.openOnGithub')}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void onStar()}>
                    {t('github.star')}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void onImportDesignSystem()}>
                    {busy ? t('github.importing') : t('github.importDesignSystem')}
                  </Button>
                  {onReviewWithAgent ? (
                    <Button onClick={onReviewWithAgentClick}>{t('github.reviewWithAgent')}</Button>
                  ) : null}
                </div>
                {importNote ? <p className={styles.rowMeta}>{importNote}</p> : null}

                {creatingIssue ? (
                  <form className={styles.issueForm} onSubmit={(event) => void onCreateIssue(event)}>
                    <Input
                      value={issueTitle}
                      onChange={(event) => setIssueTitle(event.target.value)}
                      placeholder={t('github.issueTitle')}
                      aria-label={t('github.issueTitle')}
                    />
                    <Textarea
                      value={issueBody}
                      onChange={(event) => setIssueBody(event.target.value)}
                      placeholder={t('github.issueBody')}
                      aria-label={t('github.issueBody')}
                    />
                    <div className={styles.actions}>
                      <Button type="submit" disabled={busy || !issueTitle.trim()}>
                        {busy ? t('github.creating') : t('github.createIssue')}
                      </Button>
                      <Button variant="ghost" type="button" onClick={() => setCreatingIssue(false)}>
                        {t('github.cancel')}
                      </Button>
                    </div>
                  </form>
                ) : null}

                {pull ? (
                  <>
                    <h3 className={styles.detailTitle}>#{pull.number} {pull.title}</h3>
                    <p className={styles.rowMeta}>
                      {pull.state}
                      {pull.head && pull.base ? ` · ${pull.head} → ${pull.base}` : ''}
                      {pull.user?.login ? ` · ${pull.user.login}` : ''}
                    </p>
                    <p className={styles.detailBody}>{pull.body ?? t('github.noBody')}</p>
                    <div className={styles.actions}>
                      <Button variant="ghost" onClick={() => window.open(pull.htmlUrl, '_blank', 'noopener')}>
                        {t('github.openOnGithub')}
                      </Button>
                      {pull.state === 'open' ? (
                        <Button disabled={busy} onClick={() => void onMerge()}>
                          {busy ? t('github.merging') : t('github.merge')}
                        </Button>
                      ) : (
                        <span className={styles.badge}>{t('github.merged')}</span>
                      )}
                    </div>
                    <CommentThread comments={comments} commentBody={commentBody} busy={busy} onCommentBody={setCommentBody} onComment={() => void onComment()} />
                  </>
                ) : null}

                {issue ? (
                  <>
                    <h3 className={styles.detailTitle}>#{issue.number} {issue.title}</h3>
                    <p className={styles.rowMeta}>
                      {issue.state}
                      {issue.labels.length > 0 ? ` · ${issue.labels.join(', ')}` : ''}
                    </p>
                    <p className={styles.detailBody}>{issue.body ?? t('github.noBody')}</p>
                    <div className={styles.actions}>
                      <Button variant="ghost" onClick={() => window.open(issue.htmlUrl, '_blank', 'noopener')}>
                        {t('github.openOnGithub')}
                      </Button>
                    </div>
                    <CommentThread comments={comments} commentBody={commentBody} busy={busy} onCommentBody={setCommentBody} onComment={() => void onComment()} />
                  </>
                ) : null}

                {selection?.kind === 'commit' ? (
                  <SimpleDetail
                    title={detail?.commits.find((item) => item.sha === selection.sha)?.message.split('\n')[0] ?? ''}
                    meta={detail?.commits.find((item) => item.sha === selection.sha)?.sha ?? ''}
                    htmlUrl={detail?.commits.find((item) => item.sha === selection.sha)?.htmlUrl}
                    openLabel={t('github.openOnGithub')}
                  />
                ) : null}

                {selection?.kind === 'run' ? (
                  <SimpleDetail
                    title={detail?.workflowRuns.find((item) => item.id === selection.id)?.name ?? ''}
                    meta={detail?.workflowRuns.find((item) => item.id === selection.id)?.conclusion
                      ?? detail?.workflowRuns.find((item) => item.id === selection.id)?.status
                      ?? ''}
                    htmlUrl={detail?.workflowRuns.find((item) => item.id === selection.id)?.htmlUrl}
                    openLabel={t('github.openOnGithub')}
                  />
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function CommentThread({
  comments,
  commentBody,
  busy,
  onCommentBody,
  onComment,
}: {
  comments: GithubComment[];
  commentBody: string;
  busy: boolean;
  onCommentBody: (value: string) => void;
  onComment: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className={styles.comments}>
        {comments.map((comment) => (
          <article key={comment.id} className={styles.comment}>
            <p className={styles.commentMeta}>
              {comment.user?.login ?? ''}
              {comment.createdAt ? ` · ${formatWhen(comment.createdAt)}` : ''}
            </p>
            <p className={styles.detailBody}>{comment.body}</p>
          </article>
        ))}
      </div>
      <form
        className={styles.commentForm}
        onSubmit={(event) => {
          event.preventDefault();
          onComment();
        }}
      >
        <Textarea
          value={commentBody}
          onChange={(event) => onCommentBody(event.target.value)}
          placeholder={t('github.commentPlaceholder')}
          aria-label={t('github.comment')}
        />
        <Button type="submit" disabled={busy || !commentBody.trim()}>
          {busy ? t('github.commenting') : t('github.comment')}
        </Button>
      </form>
    </>
  );
}

function SimpleDetail({
  title,
  meta,
  htmlUrl,
  openLabel,
}: {
  title: string;
  meta: string;
  htmlUrl?: string;
  openLabel: string;
}) {
  if (!title) return null;
  return (
    <>
      <h3 className={styles.detailTitle}>{title}</h3>
      <p className={styles.rowMeta}>{meta}</p>
      {htmlUrl ? (
        <Button variant="ghost" onClick={() => window.open(htmlUrl, '_blank', 'noopener')}>
          {openLabel}
        </Button>
      ) : null}
    </>
  );
}
