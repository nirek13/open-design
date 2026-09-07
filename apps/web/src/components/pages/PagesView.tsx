// Organization pages — a Notion-shaped notes surface.
//
// Fullscreen canvas under the entry topbar: collapsible page tree, cover,
// icon, reading-column block editor, slash commands, and debounced autosave.
// Deep-links via /pages/:pageId.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Skeleton } from '@open-design/components';
import type { PageFont, PageStyle, PageTreeNode, WorkspacePage, WorkspacePageDetail } from '@open-design/contracts';
import { DEFAULT_PAGE_STYLE } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  archiveWorkspacePage,
  createWorkspacePage,
  embedInWorkspacePage,
  fetchPageTree,
  fetchProjectFiles,
  fetchWorkspacePage,
  setWorkspacePageBlocks,
  updateWorkspacePage,
} from '../../providers/registry';
import type { AgentInfo, AppConfig, SkillSummary } from '../../types';
import { createProject } from '../../state/projects';
import { navigate } from '../../router';
import { Icon } from '../Icon';
import type { SettingsSection } from '../SettingsDialog';
import {
  BlockEditor,
  blocksFromServer,
  blocksToServer,
  emptyBlock,
  stampServerIds,
  type DraftBlock,
  type PageIndexEntry,
} from './BlockEditor';
import { pageTemplateBlocks, type PageTemplateId } from './page-draft';
import { countPageWords, pageToMarkdown } from '../../runtime/page-export';
import { pageFontFamily } from '../../runtime/page-style';
import { composePagesWikiPrompt, draftBlocksPlainText } from './wiki-prompt';
import { pageMakeAction, type PageMakeKind } from '../../runtime/page-make';
import {
  collectPageEmbedUrls,
  mergeMissingMediaBlocks,
  normalizeEmbedUrl,
  pageMediaBlocks,
  selectProjectFilesToEmbed,
} from '../../runtime/created-embed';
import { canCommitPageBlocks, createPageWriteQueue } from '../../runtime/page-block-commit';
import { PageContextChip } from './PageContextChip';
import { PagesAgentBuilder, type PagesAgentSession } from './PagesAgentBuilder';
import { SendToChatPicker } from '../apps/SendToChatPicker';
import { sendPageToChat } from '../apps/sendToChat';
import styles from './PagesView.module.css';

interface Props {
  active: boolean;
  /** Deep-link target from `/pages/:pageId`. */
  initialPageId?: string;
  config?: AppConfig;
  agents?: AgentInfo[];
  skills?: SkillSummary[];
  onOpenSettings?: (section?: SettingsSection) => void;
}

const AUTOSAVE_MS = 700;
const ICONS = [
  '📄', '📝', '📘', '📚', '✨', '⚡️', '💡', '🧠', '🎯', '📌',
  '🚀', '🌱', '🪐', '🧪', '🛠️', '📦', '🏠', '💼', '📊', '📈',
  '🎨', '💬', '✅', '❤️', '⭐️', '🔥', '🌈', '🎵', '📷', '🔗',
  '📅', '✉️', '🛒', '💰', '🔐', '🧭', '🗺️', '🧩', '🪄', '🌸',
];

const COVER_PRESETS: Array<{ id: string; css: string }> = [
  { id: 'g0', css: 'linear-gradient(90deg, #e8dfd6 0%, #d4c4b0 100%)' },
  { id: 'g1', css: 'linear-gradient(90deg, #d6e4e8 0%, #b0c8d4 100%)' },
  { id: 'g2', css: 'linear-gradient(90deg, #e4d6e8 0%, #c8b0d4 100%)' },
  { id: 'g3', css: 'linear-gradient(90deg, #d6e8d8 0%, #b0d4b6 100%)' },
  { id: 'g4', css: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  { id: 'g5', css: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
  { id: 'g6', css: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' },
  { id: 'g7', css: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)' },
  { id: 's0', css: '#e3e2e0' },
  { id: 's1', css: '#d3e5ef' },
  { id: 's2', css: '#dbeddb' },
  { id: 's3', css: '#f5e0e9' },
];

const FALLBACK_AGENT_CONFIG: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flattenTree(nodes: PageTreeNode[]): WorkspacePage[] {
  const out: WorkspacePage[] = [];
  const walk = (list: PageTreeNode[]) => {
    for (const node of list) {
      out.push(node.page);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** During Ask AI, open work that landed on a newly created notes page
 * instead of leaving the person on an unchanged page. Prefer a child of
 * the page they were looking at so it shows in the sidebar under them. */
export function pickNewlyCreatedPage(
  created: Array<{ id: string; parentPageId: string | null }>,
  currentId: string | null,
): string | null {
  if (created.length === 0) return null;
  if (currentId) {
    const child = created.find((page) => page.parentPageId === currentId);
    if (child) return child.id;
  }
  return created.find((page) => page.parentPageId == null)?.id ?? created[created.length - 1]!.id;
}

function filterTree(nodes: PageTreeNode[], query: string): PageTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: PageTreeNode[]): PageTreeNode[] => {
    const next: PageTreeNode[] = [];
    for (const node of list) {
      const kids = walk(node.children);
      const hit = (node.page.title || '').toLowerCase().includes(q);
      if (hit || kids.length > 0) next.push({ ...node, children: hit ? node.children : kids });
    }
    return next;
  };
  return walk(nodes);
}

function breadcrumbsFor(nodes: PageTreeNode[], currentId: string | null): WorkspacePage[] {
  if (!currentId) return [];
  const byId = new Map(flattenTree(nodes).map((page) => [page.id, page]));
  const trail: WorkspacePage[] = [];
  let id: string | null = currentId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const page = byId.get(id);
    if (!page) break;
    trail.unshift(page);
    id = page.parentPageId;
  }
  return trail;
}

function coverStyle(cover: string | null): { background?: string; backgroundImage?: string } | undefined {
  if (!cover) return undefined;
  const preset = COVER_PRESETS.find((item) => item.id === cover);
  if (preset) return { background: preset.css };
  if (/^https?:\/\//i.test(cover) || cover.startsWith('data:')) {
    return { backgroundImage: `url("${cover}")` };
  }
  return { background: cover };
}

function favoriteKey(orgId: string): string {
  return `od:page-favorites:${orgId}`;
}

function readFavorites(orgId: string): string[] {
  try {
    const raw = window.localStorage.getItem(favoriteKey(orgId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeFavorites(orgId: string, ids: string[]): void {
  try {
    window.localStorage.setItem(favoriteKey(orgId), JSON.stringify(ids));
  } catch {
    // Private browsing should not break the editor.
  }
}

function TreeItems({
  nodes,
  currentId,
  expanded,
  onToggle,
  onSelect,
  onCreateChild,
  onAskAi,
  askLabel,
}: {
  nodes: PageTreeNode[];
  currentId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onCreateChild: (id: string) => void;
  onAskAi: (id: string) => void;
  askLabel: string;
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = expanded.has(node.page.id);
        const hasKids = node.children.length > 0;
        return (
          <div key={node.page.id} className={styles.treeNode}>
            <div
              className={`${styles.pageRow}${currentId === node.page.id ? ` ${styles.pageActive}` : ''}`}
            >
              <button
                type="button"
                className={styles.caret}
                aria-expanded={open}
                aria-label={open ? 'Collapse' : 'Expand'}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(node.page.id);
                }}
              >
                {hasKids || open ? (open ? '▾' : '▸') : ' '}
              </button>
              <button
                type="button"
                className={styles.pageButton}
                onClick={() => onSelect(node.page.id)}
              >
                <span className={styles.pageIcon}>{node.page.icon ?? '📄'}</span>
                <span className={styles.pageTitle}>{node.page.title || 'Untitled'}</span>
              </button>
              <button
                type="button"
                className={`${styles.rowAction}${currentId === node.page.id ? ` ${styles.rowAsk}` : ''}`}
                title={askLabel}
                aria-label={`${askLabel}: ${node.page.title || 'Untitled'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onAskAi(node.page.id);
                }}
              >
                <Icon name="sparkles" size={12} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                title="Add sub-page"
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateChild(node.page.id);
                }}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            {open && hasKids ? (
              <div className={styles.treeKids}>
                <TreeItems
                  nodes={node.children}
                  currentId={currentId}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onCreateChild={onCreateChild}
                  onAskAi={onAskAi}
                  askLabel={askLabel}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function PagesView({
  active,
  initialPageId,
  config,
  agents = [],
  skills,
  onOpenSettings,
}: Props) {
  const t = useT();
  const org = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const { activeOrgId, activeOrg } = org;

  const [tree, setTree] = useState<PageTreeNode[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [page, setPage] = useState<WorkspacePageDetail | null>(null);
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [style, setStyle] = useState<PageStyle>({});
  const [draft, setDraft] = useState<DraftBlock[]>([emptyBlock()]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [iconOpen, setIconOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [agentSession, setAgentSession] = useState<PagesAgentSession | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderLayout, setBuilderLayout] = useState<'docked' | 'expanded'>('docked');
  const [treePeek, setTreePeek] = useState(false);
  const aiInputRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const titleRef = useRef(title);
  const iconRef = useRef(icon);
  const coverRef = useRef(cover);
  const styleRef = useRef(style);
  const openedInitial = useRef<string | null>(null);
  const persistInFlight = useRef(false);
  const saveStateRef = useRef(saveState);
  const currentIdRef = useRef(currentId);
  const openTabIdsRef = useRef<string[]>([]);
  const pagesOrgRef = useRef<string | null>(null);
  const pageUpdatedAtRef = useRef<number | null>(null);
  const savedBlocksJsonRef = useRef('');
  const sessionKnownPageIdsRef = useRef<Set<string> | null>(null);
  const embedInFlightRef = useRef(false);
  const agentSessionRef = useRef<PagesAgentSession | null>(null);
  const liveMediaBlocksRef = useRef<DraftBlock[]>([]);
  const pageWriteQueueRef = useRef(createPageWriteQueue());
  const persistRef = useRef<() => Promise<void>>(async () => {});

  draftRef.current = draft;
  titleRef.current = title;
  iconRef.current = icon;
  coverRef.current = cover;
  styleRef.current = style;
  saveStateRef.current = saveState;
  currentIdRef.current = currentId;
  openTabIdsRef.current = openTabIds;
  agentSessionRef.current = agentSession;

  useEffect(() => {
    if (!activeOrgId) return;
    setFavorites(readFavorites(activeOrgId));
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId) return;
    if (pagesOrgRef.current && pagesOrgRef.current !== activeOrgId) {
      setOpenTabIds([]);
    }
    pagesOrgRef.current = activeOrgId;
  }, [activeOrgId]);

  const allPages = useMemo(() => flattenTree(tree), [tree]);
  const pageIndex: PageIndexEntry[] = useMemo(
    () => allPages.map((item) => ({ id: item.id, title: item.title, icon: item.icon })),
    [allPages],
  );
  const crumbs = useMemo(() => breadcrumbsFor(tree, currentId), [tree, currentId]);
  const openTabs = useMemo(() => {
    const byId = new Map(allPages.map((item) => [item.id, item]));
    return openTabIds.flatMap((id) => {
      if (id === currentId) {
        return [{ id, title, icon, parentPageId: page?.parentPageId ?? null }];
      }
      const item = byId.get(id);
      return item
        ? [{ id: item.id, title: item.title, icon: item.icon, parentPageId: item.parentPageId }]
        : [];
    });
  }, [allPages, currentId, icon, openTabIds, page?.parentPageId, title]);
  const visibleTree = useMemo(() => filterTree(tree, query), [tree, query]);
  const favoritePages = useMemo(
    () => allPages.filter((item) => favorites.includes(item.id)),
    [allPages, favorites],
  );
  const childPages = useMemo(
    () => allPages.filter((item) => item.parentPageId === currentId),
    [allPages, currentId],
  );

  const loadTree = useCallback(async () => {
    if (!activeOrgId) return [];
    const next = await fetchPageTree(activeOrgId);
    setTree(next);
    setLoaded(true);
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      for (const node of next) nextSet.add(node.page.id);
      return nextSet;
    });
    return next;
  }, [activeOrgId]);

  const showPage = useCallback(
    async (pageId: string, syncUrl = true) => {
      if (!activeOrgId) return;
      const detail = await fetchWorkspacePage(activeOrgId, pageId);
      const fromServer = blocksFromServer(detail.blocks);
      setCurrentId(pageId);
      setPage(detail);
      setTitle(detail.title);
      setIcon(detail.icon);
      setCover(detail.cover);
      setStyle(detail.style ?? {});
      setDraft(fromServer);
      draftRef.current = fromServer;
      liveMediaBlocksRef.current = pageMediaBlocks(fromServer);
      savedBlocksJsonRef.current = JSON.stringify(blocksToServer(fromServer));
      pageUpdatedAtRef.current = detail.updatedAt;
      setSaveState('saved');
      setError(null);
      setIconOpen(false);
      setCoverOpen(false);
      setMoreOpen(false);
      if (detail.parentPageId) {
        setExpanded((prev) => new Set(prev).add(detail.parentPageId!));
      }
      if (syncUrl) navigate({ kind: 'home', view: 'pages', pageId }, { replace: true });
    },
    [activeOrgId],
  );

  const openPage = useCallback(
    async (pageId: string, syncUrl = true) => {
      setOpenTabIds((prev) => (prev.includes(pageId) ? prev : [...prev, pageId]));
      await showPage(pageId, syncUrl);
    },
    [showPage],
  );

  const closeTab = useCallback(
    async (pageId: string) => {
      const prev = openTabIdsRef.current;
      const idx = prev.indexOf(pageId);
      const next = prev.filter((id) => id !== pageId);
      setOpenTabIds(next);
      if (currentIdRef.current !== pageId) return;
      const fallback = next[Math.min(idx, Math.max(next.length - 1, 0))] ?? null;
      if (fallback) {
        await showPage(fallback);
        return;
      }
      setCurrentId(null);
      setPage(null);
      setTitle('');
      setIcon(null);
      setCover(null);
      setDraft([emptyBlock()]);
      navigate({ kind: 'home', view: 'pages' }, { replace: true });
    },
    [showPage],
  );

  useEffect(() => {
    if (!active || !activeOrgId) return;
    void (async () => {
      try {
        const next = await loadTree();
        const prefer =
          initialPageId && initialPageId !== openedInitial.current ? initialPageId : null;
        const first = prefer ?? next[0]?.page.id ?? null;
        if (prefer) openedInitial.current = prefer;
        if (first) await openPage(first, Boolean(prefer));
        else {
          setCurrentId(null);
          setPage(null);
          setDraft([emptyBlock()]);
        }
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [active, activeOrgId, initialPageId, loadTree, openPage]);

  const persist = useCallback(async () => {
    if (!activeOrgId || !currentId) return;
    await pageWriteQueueRef.current.enqueue(async () => {
      if (persistInFlight.current) return;
      persistInFlight.current = true;
      setSaveState('saving');
      const snapshotTitle = titleRef.current;
      const snapshotIcon = iconRef.current;
      const snapshotCover = coverRef.current;
      const snapshotStyle = styleRef.current;
      const snapshotBlocks = draftRef.current;
      const savedJsonAtStart = savedBlocksJsonRef.current;
      const updatedAtAtStart = pageUpdatedAtRef.current;
      try {
        let saved = page;
        const wroteMeta =
          snapshotTitle !== page?.title ||
          snapshotIcon !== page?.icon ||
          snapshotCover !== page?.cover ||
          JSON.stringify(snapshotStyle ?? {}) !== JSON.stringify(page?.style ?? {});
        if (wroteMeta) {
          saved = await updateWorkspacePage(activeOrgId, currentId, {
            title: snapshotTitle || 'Untitled',
            icon: snapshotIcon,
            cover: snapshotCover,
            style: snapshotStyle,
          });
        }
        const toWrite = mergeMissingMediaBlocks(snapshotBlocks, [
          ...pageMediaBlocks(draftRef.current),
          ...liveMediaBlocksRef.current,
        ]);
        const nextBlocksJson = JSON.stringify(blocksToServer(toWrite));
        const wroteBlocks = canCommitPageBlocks({
          snapshotJson: nextBlocksJson,
          savedJson: savedBlocksJsonRef.current,
          savedJsonAtStart,
          updatedAtAtStart,
          currentUpdatedAt: pageUpdatedAtRef.current,
        });
        // Skip a no-op or stale block replace. Autosave otherwise overwrites
        // live `tools pages embed` / project-file embeds with an older draft.
        if (wroteBlocks) {
          saved = await setWorkspacePageBlocks(activeOrgId, currentId, {
            blocks: blocksToServer(toWrite),
          });
          savedBlocksJsonRef.current = nextBlocksJson;
        }
        if (saved && (wroteBlocks || wroteMeta)) {
          setPage(saved);
          pageUpdatedAtRef.current = saved.updatedAt;
          setDraft((current) => {
            const next = mergeMissingMediaBlocks(
              stampServerIds(current, saved.blocks),
              pageMediaBlocks(current),
            );
            draftRef.current = next;
            liveMediaBlocksRef.current = pageMediaBlocks(next);
            return next;
          });
        }
        const drifted =
          titleRef.current !== snapshotTitle ||
          iconRef.current !== snapshotIcon ||
          coverRef.current !== snapshotCover ||
          styleRef.current !== snapshotStyle ||
          draftRef.current !== snapshotBlocks;
        await loadTree();
        if (drifted) {
          setSaveState('dirty');
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            void persist();
          }, AUTOSAVE_MS);
        } else {
          setSaveState('saved');
        }
        setError(null);
      } catch (err) {
        setSaveState('dirty');
        setError(errorMessage(err));
      } finally {
        persistInFlight.current = false;
      }
    });
  }, [activeOrgId, currentId, loadTree, page]);
  persistRef.current = persist;

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist();
    }, AUTOSAVE_MS);
  }, [persist]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!iconOpen && !coverOpen && !moreOpen && !customizeOpen && !moveOpen) return;
    const onDoc = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null;
      if (el?.closest('[data-pages-popover]')) return;
      setIconOpen(false);
      setCoverOpen(false);
      setMoreOpen(false);
      setCustomizeOpen(false);
      setMoveOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [iconOpen, coverOpen, moreOpen, customizeOpen, moveOpen]);

  const onCreate = async (
    parentPageId: string | null = null,
    options: { open?: boolean; linkOnParent?: boolean } = {},
  ) => {
    if (!activeOrgId) return null;
    const open = options.open !== false;
    setBusy(true);
    try {
      const created = await createWorkspacePage(activeOrgId, {
        title: '',
        parentPageId,
        icon: null,
        blocks: [{ type: 'paragraph', content: '' }],
        linkOnParent: options.linkOnParent ?? Boolean(parentPageId),
      });
      if (parentPageId) {
        setExpanded((prev) => new Set(prev).add(parentPageId));
      }
      await loadTree();
      if (open) await openPage(created.id);
      return created;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const applyServerPage = useCallback((detail: WorkspacePageDetail) => {
    if (currentIdRef.current !== detail.id) return;
    const fromServer = blocksFromServer(detail.blocks);
    const merged = mergeMissingMediaBlocks(fromServer, liveMediaBlocksRef.current);
    const restoredMedia =
      collectPageEmbedUrls(merged).size > collectPageEmbedUrls(fromServer).size;
    setPage(detail);
    setTitle(detail.title);
    setIcon(detail.icon);
    setCover(detail.cover);
    setStyle(detail.style ?? {});
    setDraft(merged);
    draftRef.current = merged;
    liveMediaBlocksRef.current = pageMediaBlocks(merged);
    savedBlocksJsonRef.current = JSON.stringify(blocksToServer(fromServer));
    pageUpdatedAtRef.current = detail.updatedAt;
    if (restoredMedia) {
      setSaveState('dirty');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistRef.current();
      }, AUTOSAVE_MS);
      return;
    }
    setSaveState('saved');
  }, []);

  const refreshOpenPage = useCallback(async (): Promise<boolean> => {
    if (!activeOrgId || !currentIdRef.current) return false;
    if (saveStateRef.current !== 'saved' || persistInFlight.current) return false;
    const pageId = currentIdRef.current;
    const detail = await fetchWorkspacePage(activeOrgId, pageId);
    if (currentIdRef.current !== pageId) return false;
    if (saveStateRef.current !== 'saved' || persistInFlight.current) return false;
    if (pageUpdatedAtRef.current != null && detail.updatedAt <= pageUpdatedAtRef.current) return false;
    applyServerPage(detail);
    return true;
  }, [activeOrgId, applyServerPage]);

  const absorbServerEmbeds = useCallback((detail: WorkspacePageDetail) => {
    if (currentIdRef.current !== detail.id) return;
    const fromServer = blocksFromServer(detail.blocks);
    liveMediaBlocksRef.current = mergeMissingMediaBlocks(
      pageMediaBlocks(fromServer),
      liveMediaBlocksRef.current,
    );
    if (saveStateRef.current === 'saved' && !persistInFlight.current) {
      applyServerPage(detail);
      return;
    }
    const have = collectPageEmbedUrls(draftRef.current);
    const extras = fromServer.filter((block) => {
      if (block.type !== 'embed' && block.type !== 'image' && block.type !== 'video' && block.type !== 'artifact') {
        return false;
      }
      const url = normalizeEmbedUrl(String(block.props.url ?? block.props.path ?? block.text ?? ''));
      return Boolean(url) && !have.has(url);
    });
    if (extras.length === 0) {
      pageUpdatedAtRef.current = Math.max(pageUpdatedAtRef.current ?? 0, detail.updatedAt);
      return;
    }
    const next = [...draftRef.current, ...extras];
    draftRef.current = next;
    liveMediaBlocksRef.current = pageMediaBlocks(next);
    setDraft(next);
    pageUpdatedAtRef.current = Math.max(pageUpdatedAtRef.current ?? 0, detail.updatedAt);
  }, [applyServerPage]);

  const embedAgentProjectFiles = useCallback(async (): Promise<boolean> => {
    const session = agentSessionRef.current;
    if (!session || !activeOrgId || !currentIdRef.current) return false;
    if (embedInFlightRef.current) return false;
    const pageId = currentIdRef.current;
    const files = await fetchProjectFiles(session.projectId);
    const pending = selectProjectFilesToEmbed({
      files,
      projectId: session.projectId,
      alreadySeen: new Set(),
      pageUrls: collectPageEmbedUrls(draftRef.current),
    });
    if (pending.length === 0) return false;
    return pageWriteQueueRef.current.enqueue(async () => {
      if (embedInFlightRef.current || currentIdRef.current !== pageId) return false;
      const stillPending = selectProjectFilesToEmbed({
        files,
        projectId: session.projectId,
        alreadySeen: new Set(),
        pageUrls: collectPageEmbedUrls(draftRef.current),
      });
      if (stillPending.length === 0) return false;
      embedInFlightRef.current = true;
      try {
        let latest: WorkspacePageDetail | null = null;
        for (const item of stillPending) {
          latest = await embedInWorkspacePage(activeOrgId, pageId, { type: 'embed', url: item.url });
          if (currentIdRef.current !== pageId) return true;
        }
        if (latest && currentIdRef.current === pageId) {
          absorbServerEmbeds(latest);
        }
        return true;
      } finally {
        embedInFlightRef.current = false;
      }
    });
  }, [absorbServerEmbeds, activeOrgId]);

  const refreshAgentPages = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      await embedAgentProjectFiles();
      if (saveStateRef.current !== 'saved' || persistInFlight.current) return;
      const nextTree = await loadTree();
      const known = sessionKnownPageIdsRef.current;
      const created = known
        ? flattenTree(nextTree).filter((page) => !known.has(page.id))
        : [];
      if (known) {
        for (const page of created) known.add(page.id);
      }
      if (created.length > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const page of created) {
            next.add(page.id);
            if (page.parentPageId) next.add(page.parentPageId);
          }
          return next;
        });
      }
      const currentChanged = await refreshOpenPage();
      if (currentChanged || created.length === 0 || saveStateRef.current !== 'saved') return;
      const openId = pickNewlyCreatedPage(created, currentIdRef.current);
      if (openId && openId !== currentIdRef.current) {
        await openPage(openId);
      }
    } catch {
      // Keep the open page; the next tick retries.
    }
  }, [activeOrgId, embedAgentProjectFiles, loadTree, openPage, refreshOpenPage]);

  useEffect(() => {
    if (!agentSession) {
      sessionKnownPageIdsRef.current = null;
      return;
    }
    if (!sessionKnownPageIdsRef.current) {
      sessionKnownPageIdsRef.current = new Set(flattenTree(tree).map((page) => page.id));
      if (currentIdRef.current) sessionKnownPageIdsRef.current.add(currentIdRef.current);
    }
    void refreshAgentPages();
    const timer = setInterval(() => {
      void refreshAgentPages();
    }, 1000);
    return () => clearInterval(timer);
  }, [agentSession, activeOrgId, refreshAgentPages]);

  const askWikiAgent = async (request: string, options?: { makeKind?: PageMakeKind }) => {
    const trimmed = request.trim();
    if (!trimmed || aiBusy) return;
    setAiBusy(true);
    try {
      const pageTitle = (titleRef.current || '').trim() || undefined;
      const makeKind = options?.makeKind;
      const promptInput = {
        request: trimmed,
        pageId: currentId,
        pageTitle,
        pageIcon: iconRef.current,
        pageExcerpt: currentId ? draftBlocksPlainText(draftRef.current) : null,
        openTabs: openTabIdsRef.current.map((id) => {
          if (id === currentId) {
            return { id, title: pageTitle, icon: iconRef.current };
          }
          const item = allPages.find((page) => page.id === id);
          return { id, title: item?.title, icon: item?.icon };
        }),
        ...(makeKind ? { make: { kind: makeKind, prompt: trimmed } } : {}),
      };
      const created = await createProject({
        name: pageTitle
          ? `${pageTitle}: ${makeKind ? `Make ${pageMakeAction(makeKind).noun}` : trimmed}`.slice(0, 60)
          : (makeKind ? `Make ${pageMakeAction(makeKind).noun}: ${trimmed}` : trimmed).slice(0, 60),
        pendingPrompt: composePagesWikiPrompt(promptInput),
        skillId: null,
        designSystemId: null,
        metadata: {
          ...(makeKind ? { kind: pageMakeAction(makeKind).projectKind } : currentId ? { kind: 'other' as const } : {}),
          ...(activeOrgId ? { workspaceId: activeOrgId } : {}),
          ...(currentId
            ? {
                pageContext: {
                  pageId: currentId,
                  title: pageTitle || 'Untitled',
                  icon: iconRef.current,
                },
              }
            : {}),
        },
      });
      if (created?.project && created.conversationId) {
        setAiPrompt('');
        setAgentSession({
          projectId: created.project.id,
          conversationId: created.conversationId,
          pageId: currentId,
          pageTitle: pageTitle || t('pages.untitled'),
          pageIcon: iconRef.current,
          seedPrompt: composePagesWikiPrompt({
            ...promptInput,
            projectId: created.project.id,
          }),
        });
        setBuilderLayout('docked');
        setBuilderOpen(true);
        setTreePeek(false);
        setSidebarOpen(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAiBusy(false);
    }
  };

  const onArchive = async () => {
    if (!activeOrgId || !currentId) return;
    setBusy(true);
    setMoreOpen(false);
    try {
      const archivedId = currentId;
      await archiveWorkspacePage(activeOrgId, archivedId);
      const remainingTabs = openTabIdsRef.current.filter((id) => id !== archivedId);
      setOpenTabIds(remainingTabs);
      const next = await loadTree();
      const first = remainingTabs[0] ?? next[0]?.page.id;
      if (first) await openPage(first);
      else {
        setCurrentId(null);
        setPage(null);
        setDraft([emptyBlock()]);
        navigate({ kind: 'home', view: 'pages' }, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onDuplicate = async () => {
    if (!activeOrgId || !page) return;
    setBusy(true);
    setMoreOpen(false);
    try {
      const created = await createWorkspacePage(activeOrgId, {
        title: `${titleRef.current || 'Untitled'} (copy)`,
        parentPageId: page.parentPageId,
        icon: iconRef.current,
        cover: coverRef.current,
        blocks: blocksToServer(draftRef.current),
      });
      await loadTree();
      await openPage(created.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = () => {
    if (!activeOrgId || !currentId) return;
    setFavorites((prev) => {
      const next = prev.includes(currentId)
        ? prev.filter((id) => id !== currentId)
        : [...prev, currentId];
      writeFavorites(activeOrgId, next);
      return next;
    });
  };

  const setIconValue = (next: string | null) => {
    setIcon(next);
    setIconOpen(false);
    scheduleSave();
  };

  const setCoverValue = (next: string | null) => {
    setCover(next);
    setCoverOpen(false);
    scheduleSave();
  };

  if (!activeOrgId) {
    return (
      <div className={styles.fullscreen} data-testid="pages-view">
        <EmptyState title={t('pages.noOrg')} description={t('pages.noOrgBody')} />
      </div>
    );
  }

  const starred = currentId ? favorites.includes(currentId) : false;

  const builderVisible = Boolean(builderOpen && agentSession);
  const focusAskComposer = (pageId?: string | null) => {
    setSidebarOpen(true);
    if (agentSession) {
      setBuilderOpen(true);
      return;
    }
    if (pageId && pageId !== currentId) {
      void openPage(pageId).catch((err) => setError(errorMessage(err)));
    }
    window.requestAnimationFrame(() => aiInputRef.current?.focus());
  };

  return (
    <div
      className={styles.fullscreen}
      data-testid="pages-view"
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-builder-layout={builderVisible ? builderLayout : undefined}
    >
      {sidebarOpen ? (
        <aside
          className={styles.sidebar}
          data-testid="pages-sidebar"
          data-builder={builderVisible ? builderLayout : undefined}
        >
          {builderVisible && agentSession ? (
            <PagesAgentBuilder
              session={agentSession}
              layout={builderLayout}
              config={config ?? FALLBACK_AGENT_CONFIG}
              agents={agents}
              skills={skills}
              pagesNavOpen={treePeek}
              onTogglePagesNav={() => setTreePeek((open) => !open)}
              pagesNav={
                treePeek ? (
                  <div className={styles.treePeek} data-testid="pages-builder-tree">
                    <button
                      type="button"
                      className={styles.newPage}
                      onClick={() => void onCreate(null)}
                      disabled={busy}
                    >
                      <Icon name="plus" size={14} />
                      {t('pages.newPage')}
                    </button>
                    <TreeItems
                      nodes={visibleTree}
                      currentId={currentId}
                      expanded={expanded}
                      onToggle={(id) =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                      onSelect={(id) => {
                        void openPage(id).catch((err) => setError(errorMessage(err)));
                        setTreePeek(false);
                      }}
                      onCreateChild={(id) => void onCreate(id)}
                      onAskAi={(id) => {
                        setTreePeek(false);
                        focusAskComposer(id);
                      }}
                      askLabel={t('pages.askAi')}
                    />
                  </div>
                ) : null
              }
              onExpand={() => setBuilderLayout('expanded')}
              onDock={() => setBuilderLayout('docked')}
              onClose={() => {
                setBuilderOpen(false);
                setBuilderLayout('docked');
                setTreePeek(false);
              }}
              onSeeded={() => {
                setAgentSession((prev) => (prev ? { ...prev, seedPrompt: '' } : prev));
              }}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <>
          <div className={styles.workspace}>
            <span className={styles.workspaceName}>{activeOrg?.name ?? t('pages.pages')}</span>
            <button
              type="button"
              className={styles.iconGhost}
              aria-label={t('pages.hideSidebar')}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon name="panel-left" size={16} />
            </button>
          </div>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('pages.searchPlaceholder')}
              aria-label={t('pages.searchPlaceholder')}
              data-testid="pages-search"
            />
          </label>
          <button
            type="button"
            className={styles.newPage}
            onClick={() => void onCreate(null)}
            disabled={busy}
            data-testid="pages-new"
          >
            <Icon name="plus" size={14} />
            {t('pages.newPage')}
          </button>

          {favoritePages.length > 0 ? (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pages.favorites')}</h2>
              {favoritePages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.favButton}${currentId === item.id ? ` ${styles.pageActive}` : ''}`}
                  onClick={() => void openPage(item.id).catch((err) => setError(errorMessage(err)))}
                >
                  <span>{item.icon ?? '📄'}</span>
                  <span className={styles.pageTitle}>{item.title || t('pages.untitled')}</span>
                </button>
              ))}
            </section>
          ) : null}

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{t('pages.privatePages')}</h2>
            {!loaded ? <Skeleton height={120} /> : null}
            {loaded && visibleTree.length === 0 ? (
              <p className={styles.muted}>{query ? t('pages.noMatch') : t('pages.emptyTitle')}</p>
            ) : null}
            {loaded ? (
              <div className={styles.pageList}>
                <TreeItems
                  nodes={visibleTree}
                  currentId={currentId}
                  expanded={expanded}
                  onToggle={(id) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onSelect={(id) => void openPage(id).catch((err) => setError(errorMessage(err)))}
                  onCreateChild={(id) => void onCreate(id)}
                  onAskAi={(id) => focusAskComposer(id)}
                  askLabel={t('pages.askAi')}
                />
              </div>
            ) : null}
          </section>

          <form
            className={styles.sidebarAsk}
            data-testid="pages-ask-ai"
            onSubmit={(event) => {
              event.preventDefault();
              void askWikiAgent(aiPrompt);
            }}
          >
            <div className={styles.sidebarAskHead}>
              <Icon name="sparkles" size={14} />
              <span>{t('pages.askAi')}</span>
            </div>
            {currentId ? (
              <PageContextChip
                title={title || t('pages.untitled')}
                icon={icon}
              />
            ) : (
              <p className={styles.noPageHint}>{t('pages.noPageContext')}</p>
            )}
            <textarea
              ref={aiInputRef}
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void askWikiAgent(aiPrompt);
                }
              }}
              placeholder={t('pages.askPlaceholder')}
              aria-label={t('pages.askAi')}
              disabled={aiBusy}
              rows={3}
            />
            <Button type="submit" variant="primary" disabled={!aiPrompt.trim() || aiBusy}>
              {t('pages.askAi')}
            </Button>
          </form>
            </>
          )}
        </aside>
      ) : null}

      <div className={styles.main}>
        <header className={styles.chrome}>
          {!sidebarOpen ? (
            <button
              type="button"
              className={styles.iconGhost}
              aria-label={t('pages.showSidebar')}
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="panel-left" size={16} />
            </button>
          ) : null}
          <nav className={styles.tabs} role="tablist" aria-label={t('pages.openTabs')} data-testid="pages-tab-bar">
            {openTabs.map((item) => {
              const selected = item.id === currentId;
              const label = item.title || t('pages.untitled');
              return (
                <div
                  key={item.id}
                  className={`${styles.tab}${selected ? ` ${styles.tabActive}` : ''}`}
                  data-testid={`pages-tab-${item.id}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={styles.tabBtn}
                    title={label}
                    onClick={() => void openPage(item.id).catch((err) => setError(errorMessage(err)))}
                  >
                    <span aria-hidden>{item.icon ?? '📄'}</span>
                    <span className={styles.tabLabel}>{label}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.tabClose}
                    aria-label={t('pages.closeTab')}
                    onClick={() => void closeTab(item.id).catch((err) => setError(errorMessage(err)))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </nav>
          <div className={styles.chromeRight}>
            <button
              type="button"
              className={styles.iconGhost}
              data-testid="pages-focus-ask"
              aria-label={agentSession ? t('pages.builderOpen') : t('pages.askPlaceholder')}
              title={agentSession ? t('pages.builderOpen') : t('pages.askAi')}
              onClick={() => focusAskComposer(currentId)}
            >
              <Icon name="sparkles" size={16} />
            </button>
            <span className={styles.savePill} data-state={saveState}>
              {saveState === 'saving'
                ? t('pages.saving')
                : saveState === 'dirty'
                  ? t('pages.unsaved')
                  : t('pages.saved')}
            </span>
            {currentId ? (
              <button
                type="button"
                className={`${styles.iconGhost}${starred ? ` ${styles.starred}` : ''}`}
                aria-label={starred ? t('pages.unstar') : t('pages.star')}
                onClick={toggleFavorite}
              >
                <Icon name="star" size={16} />
              </button>
            ) : null}
            {currentId ? (
              <div className={styles.moreWrap} data-pages-popover>
                <button
                  type="button"
                  className={styles.iconGhost}
                  aria-label={t('pages.more')}
                  onClick={() => setMoreOpen((open) => !open)}
                >
                  <Icon name="more-horizontal" size={16} />
                </button>
                {moreOpen ? (
                  <div className={styles.moreMenu} data-testid="pages-more" data-pages-popover>
                    <button type="button" onClick={() => void onDuplicate()} disabled={busy}>
                      {t('pages.duplicate')}
                    </button>
                    <button type="button" onClick={() => void onCreate(currentId)} disabled={busy}>
                      {t('pages.addSubpage')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setCustomizeOpen(true);
                      }}
                    >
                      {t('pages.customize')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setMoveOpen(true);
                      }}
                    >
                      {t('pages.moveTo')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const markdown = pageToMarkdown(titleRef.current || t('pages.untitled'), draftRef.current);
                        const blob = new Blob([markdown], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${(titleRef.current || 'untitled').replace(/[^\w.-]+/g, '-')}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                        setMoreOpen(false);
                      }}
                    >
                      {t('pages.exportMarkdown')}
                    </button>
                    <button
                      type="button"
                      data-testid="pages-send"
                      onClick={() => {
                        setMoreOpen(false);
                        setSendOpen(true);
                      }}
                    >
                      {t('pages.send')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(window.location.href);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1600);
                        setMoreOpen(false);
                      }}
                    >
                      {copied ? t('pages.copied') : t('pages.copyLink')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStyle((prev) => ({ ...prev, locked: !prev.locked }));
                        scheduleSave();
                        setMoreOpen(false);
                      }}
                    >
                      {style.locked ? t('pages.unlock') : t('pages.lock')}
                    </button>
                    <button type="button" className={styles.danger} onClick={() => void onArchive()} disabled={busy}>
                      {t('pages.archive')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {customizeOpen ? (
              <div className={styles.moreMenu} data-testid="pages-customize" data-pages-popover>
                <label className={styles.menuCheck}>
                  <input
                    type="checkbox"
                    checked={Boolean(style.fullWidth)}
                    onChange={(event) => {
                      setStyle((prev) => ({ ...prev, fullWidth: event.target.checked }));
                      scheduleSave();
                    }}
                  />
                  {t('pages.fullWidth')}
                </label>
                <label className={styles.menuCheck}>
                  <input
                    type="checkbox"
                    checked={Boolean(style.smallText)}
                    onChange={(event) => {
                      setStyle((prev) => ({ ...prev, smallText: event.target.checked }));
                      scheduleSave();
                    }}
                  />
                  {t('pages.smallText')}
                </label>
                <div className={styles.menuLabel}>{t('pages.font')}</div>
                {(['default', 'serif', 'mono'] as const).map((font) => (
                  <button
                    key={font}
                    type="button"
                    onClick={() => {
                      setStyle((prev) => ({ ...prev, font }));
                      scheduleSave();
                    }}
                  >
                    {font === 'default' ? t('pages.fontDefault') : font === 'serif' ? t('pages.fontSerif') : t('pages.fontMono')}
                  </button>
                ))}
              </div>
            ) : null}
            {moveOpen ? (
              <div className={styles.moreMenu} data-testid="pages-move" data-pages-popover>
                <button
                  type="button"
                  onClick={() => {
                    if (!activeOrgId || !currentId) return;
                    void updateWorkspacePage(activeOrgId, currentId, { parentPageId: null }).then(() => {
                      setMoveOpen(false);
                      return loadTree();
                    });
                  }}
                >
                  {t('pages.moveToRoot')}
                </button>
                {allPages
                  .filter((item) => item.id !== currentId)
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (!activeOrgId || !currentId) return;
                        void updateWorkspacePage(activeOrgId, currentId, { parentPageId: item.id }).then(() => {
                          setMoveOpen(false);
                          return loadTree();
                        });
                      }}
                    >
                      {item.icon ?? '📄'} {item.title || t('pages.untitled')}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        </header>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <section className={styles.canvas}>
          {!loaded ? <Skeleton height={320} /> : null}
          {loaded && !page ? (
            <div className={styles.emptyCanvas}>
              <EmptyState
                title={t('pages.emptyTitle')}
                description={t('pages.emptyBody')}
                action={
                  <div className={styles.emptyActions}>
                    <Button variant="primary" onClick={() => void onCreate(null)} disabled={busy}>
                      {t('pages.newPage')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void askWikiAgent(t('pages.buildWiki'))}
                      disabled={aiBusy}
                    >
                      {t('pages.buildWiki')}
                    </Button>
                  </div>
                }
              />
            </div>
          ) : null}
          {loaded && page ? (
            <>
              {cover ? (
                <div className={styles.cover} style={coverStyle(cover)} data-testid="pages-cover">
                  <div className={styles.coverActions}>
                    <button type="button" onClick={() => setCoverOpen(true)}>
                      {t('pages.changeCover')}
                    </button>
                    <button type="button" onClick={() => setCoverValue(null)}>
                      {t('pages.removeCover')}
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className={`${styles.article}${cover ? ` ${styles.articleWithCover}` : ''}`}
                data-font={style.font ?? DEFAULT_PAGE_STYLE.font}
                data-small={style.smallText ? 'true' : undefined}
                data-full={style.fullWidth ? 'true' : undefined}
                style={{ fontFamily: pageFontFamily(style.font as PageFont | undefined) }}
              >
                <div className={styles.pageHead} data-pages-popover>
                  {icon ? (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => setIconOpen((open) => !open)}
                      title={t('pages.changeIcon')}
                    >
                      {icon}
                    </button>
                  ) : null}
                  <div className={styles.headActions}>
                    {!icon ? (
                      <button type="button" className={styles.metaBtn} onClick={() => setIconOpen(true)}>
                        {t('pages.addIcon')}
                      </button>
                    ) : (
                      <button type="button" className={styles.metaBtn} onClick={() => setIconValue(null)}>
                        {t('pages.removeIcon')}
                      </button>
                    )}
                    {!cover ? (
                      <button type="button" className={styles.metaBtn} onClick={() => setCoverOpen(true)}>
                        {t('pages.addCover')}
                      </button>
                    ) : null}
                  </div>
                  {iconOpen ? (
                    <div className={styles.picker} data-testid="pages-icon-picker" data-pages-popover>
                      {ICONS.map((glyph) => (
                        <button key={glyph} type="button" onClick={() => setIconValue(glyph)}>
                          {glyph}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {coverOpen ? (
                    <div className={styles.coverPicker} data-testid="pages-cover-picker" data-pages-popover>
                      {COVER_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          style={{ background: preset.css }}
                          aria-label={preset.id}
                          onClick={() => setCoverValue(preset.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                <textarea
                  className={styles.titleInput}
                  value={title === 'Untitled' ? '' : title}
                  placeholder={t('pages.untitled')}
                  aria-label={t('pages.titleField')}
                  rows={1}
                  data-testid="pages-title"
                  disabled={Boolean(style.locked)}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    event.target.style.height = 'auto';
                    event.target.style.height = `${event.target.scrollHeight}px`;
                    scheduleSave();
                  }}
                />
                <BlockEditor
                  key={page.id}
                  orgId={activeOrgId}
                  blocks={draft}
                  pages={pageIndex}
                  crumbs={crumbs.map((item) => ({ id: item.id, title: item.title, icon: item.icon }))}
                  readOnly={Boolean(style.locked)}
                  onOpenPage={(id) => void openPage(id).catch((err) => setError(errorMessage(err)))}
                  onCreateSubpage={async () => {
                    const created = await onCreate(page.id, { open: false, linkOnParent: false });
                    return created
                      ? { id: created.id, title: created.title || t('pages.untitled'), icon: created.icon }
                      : null;
                  }}
                  onMake={(kind, prompt) => {
                    void askWikiAgent(prompt, { makeKind: kind });
                  }}
                  onChange={(next) => {
                    setDraft(next);
                    draftRef.current = next;
                    liveMediaBlocksRef.current = pageMediaBlocks(next);
                    scheduleSave();
                  }}
                />
                {draft.length === 1 &&
                draft[0]?.type === 'paragraph' &&
                !draft[0].text &&
                draft[0].children.length === 0 &&
                !style.locked ? (
                  <div className={styles.templates} data-testid="pages-templates">
                    <p className={styles.templatesLabel}>{t('pages.templates')}</p>
                    {(
                      [
                        ['blank', t('pages.templateBlank')],
                        ['doc', t('pages.templateDoc')],
                        ['meeting', t('pages.templateMeeting')],
                        ['tasks', t('pages.templateTasks')],
                      ] as Array<[PageTemplateId, string]>
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setDraft(pageTemplateBlocks(id));
                          scheduleSave();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <p className={styles.pageMeta}>
                  {t('pages.lastEdited')}{' '}
                  {new Date(page.updatedAt).toLocaleString()} ·{' '}
                  {t('pages.wordCount').replace('{count}', String(countPageWords(title, draft)))}
                </p>
                {childPages.length > 0 ? (
                  <div className={styles.children}>
                    <h2 className={styles.childrenTitle}>{t('pages.childPages')}</h2>
                    {childPages.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        className={styles.childCard}
                        onClick={() => void openPage(child.id).catch((err) => setError(errorMessage(err)))}
                      >
                        <span>{child.icon ?? '📄'}</span>
                        <span>{child.title || t('pages.untitled')}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      </div>
      {sendOpen && activeOrgId && currentId ? (
        <div
          className={styles.sendScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSendOpen(false);
          }}
        >
          <div className={styles.sendCard} data-testid="pages-send-panel">
            <SendToChatPicker
              orgId={activeOrgId}
              name={title.trim() || t('pages.untitled')}
              lead={t('pages.send.lead')}
              exceptHint={t('pages.send.exceptHint')}
              testIdPrefix="send-page"
              onSkip={() => setSendOpen(false)}
              onSent={() => setSendOpen(false)}
              onSend={(destinations, body, except) =>
                sendPageToChat(
                  activeOrgId,
                  { id: currentId, title: title.trim() || t('pages.untitled') },
                  destinations,
                  body,
                  except,
                )
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
