// Slim left sidebar: icon-first, hover to read labels, yours to arrange.
//
// Destinations you pin live in a narrow rail that does not cover the page.
// Everything else stays in Places (the org mark). Add apps or sections from
// the plus menu; drag to reorder; right-click to remove.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { EntryHelpMenu } from './EntryHelpMenu';
import { Icon, type IconName } from './Icon';
import { isMacPlatform } from '../utils/platform';
import { useT } from '../i18n';
import { DATABASE_UI_VISIBLE } from '../features/databaseUi';
import type { OrgAppWithOrgName } from '@open-design/contracts';
import { fetchAllOrgApps, recordOrgAppOpen, updateOrgApp } from '../providers/registry';
import { useOptionalOrg } from '../org/OrgContext';
import { OrgMark } from './org/OrgMark';
import { useOptionalRunningApp } from './apps/RunningAppContext';
import { isErpEntryView } from './erp/ErpShell';
import {
  ENTRY_NAV_DRAG_THRESHOLD_PX,
  ENTRY_NAV_ISLANDS,
  hideEntryNavItem,
  isPinnedEntryNavId,
  moveEntryNavItem,
  normalizeEntryNavOrder,
  nudgeEntryNavItem,
  pinnedEntryNavId,
  readEntryNavHidden,
  readEntryNavOrder,
  showEntryNavItem,
  writeEntryNavHidden,
  writeEntryNavOrder,
} from './entry-nav-order';
import styles from './EntryNavRail.module.css';

export type EntryView =
  | 'home'
  | 'search'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'library'
  | 'brands'
  | 'integrations'
  | 'database'
  | 'apps'
  | 'organization'
  | 'workspace'
  | 'erp'
  | 'books'
  | 'approvals'
  | 'crm'
  | 'purchasing'
  | 'team'
  | 'pages'
  | 'calendar'
  | 'mail'
  | 'slack'
  | 'dev'
  | 'templates'
  | 'tables'
  | 'inventory'
  | 'jobs'
  | 'connections';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  newProjectDisabled?: boolean;
  /** Kept so existing shells/tests compile; the sidebar is always present. */
  open: boolean;
  onClose: () => void;
}

type LabelKey =
  | 'entry.navSearch'
  | 'entry.navWorkspace'
  | 'entry.navErp'
  | 'entry.navTeam'
  | 'entry.navPages'
  | 'entry.navCalendar'
  | 'entry.navMail'
  | 'entry.navSlack'
  | 'entry.navDev'
  | 'entry.navProjects'
  | 'entry.navDesignSystems'
  | 'entry.navLibrary'
  | 'entry.navTasks'
  | 'entry.navPlugins'
  | 'entry.navApps'
  | 'entry.navDatabase'
  | 'entry.navIntegrations'
  | 'entry.navOrganization';

interface StaticDest {
  id: string;
  view: EntryView;
  icon: IconName;
  labelKey: LabelKey;
  testId: string;
  isActive: (view: EntryView) => boolean;
}

const STATIC_DESTINATIONS: readonly StaticDest[] = [
  { id: 'search', view: 'search', icon: 'search', labelKey: 'entry.navSearch', testId: 'entry-nav-search', isActive: (v) => v === 'search' },
  { id: 'erp', view: 'books', icon: 'grid', labelKey: 'entry.navErp', testId: 'entry-nav-erp', isActive: isErpEntryView },
  { id: 'team', view: 'team', icon: 'message-circle', labelKey: 'entry.navTeam', testId: 'entry-nav-team', isActive: (v) => v === 'team' },
  { id: 'pages', view: 'pages', icon: 'file-text', labelKey: 'entry.navPages', testId: 'entry-nav-pages', isActive: (v) => v === 'pages' },
  { id: 'calendar', view: 'calendar', icon: 'history', labelKey: 'entry.navCalendar', testId: 'entry-nav-calendar', isActive: (v) => v === 'calendar' },
  { id: 'mail', view: 'mail', icon: 'mail', labelKey: 'entry.navMail', testId: 'entry-nav-mail', isActive: (v) => v === 'mail' },
  { id: 'slack', view: 'slack', icon: 'hash', labelKey: 'entry.navSlack', testId: 'entry-nav-slack', isActive: (v) => v === 'slack' },
  { id: 'dev', view: 'dev', icon: 'github', labelKey: 'entry.navDev', testId: 'entry-nav-dev', isActive: (v) => v === 'dev' },
  { id: 'home', view: 'workspace', icon: 'home', labelKey: 'entry.navWorkspace', testId: 'entry-nav-home', isActive: (v) => v === 'workspace' || v === 'home' },
  { id: 'projects', view: 'projects', icon: 'folder', labelKey: 'entry.navProjects', testId: 'entry-nav-projects', isActive: (v) => v === 'projects' },
  { id: 'design-systems', view: 'design-systems', icon: 'palette', labelKey: 'entry.navDesignSystems', testId: 'entry-nav-design-systems', isActive: (v) => v === 'design-systems' },
  { id: 'library', view: 'library', icon: 'layers-filled', labelKey: 'entry.navLibrary', testId: 'entry-nav-library', isActive: (v) => v === 'library' },
  { id: 'tasks', view: 'tasks', icon: 'kanban', labelKey: 'entry.navTasks', testId: 'entry-nav-tasks', isActive: (v) => v === 'tasks' },
  { id: 'plugins', view: 'plugins', icon: 'grid', labelKey: 'entry.navPlugins', testId: 'entry-nav-plugins', isActive: (v) => v === 'plugins' },
  { id: 'apps', view: 'apps', icon: 'blocks', labelKey: 'entry.navApps', testId: 'entry-nav-apps', isActive: (v) => v === 'apps' },
  { id: 'database', view: 'database', icon: 'layout', labelKey: 'entry.navDatabase', testId: 'entry-nav-database', isActive: (v) => v === 'database' },
  { id: 'integrations', view: 'integrations', icon: 'link', labelKey: 'entry.navIntegrations', testId: 'entry-nav-integrations', isActive: (v) => v === 'integrations' },
  { id: 'organization', view: 'organization', icon: 'orbit', labelKey: 'entry.navOrganization', testId: 'entry-nav-organization', isActive: (v) => v === 'organization' },
];

const STATIC_BY_ID = new Map(STATIC_DESTINATIONS.map((item) => [item.id, item]));

function dockItemLabel(
  id: string,
  t: ReturnType<typeof useT>,
  pinnedApps: OrgAppWithOrgName[],
): string {
  if (isPinnedEntryNavId(id)) {
    const appId = id.slice('pinned:'.length);
    return pinnedApps.find((app) => app.id === appId)?.name ?? appId;
  }
  const dest = STATIC_BY_ID.get(id);
  return dest ? t(dest.labelKey) : id;
}

function dropTargetFromPoint(
  list: HTMLElement,
  clientY: number,
  order: readonly string[],
  dragId: string,
): { targetId: string; place: 'before' | 'after' } | null {
  const slots = [...list.querySelectorAll<HTMLElement>('[data-nav-id]')];
  if (slots.length === 0) return null;
  for (const slot of slots) {
    const id = slot.getAttribute('data-nav-id');
    if (!id || id === dragId) continue;
    const rect = slot.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { targetId: id, place: 'before' };
    }
  }
  const last = order.filter((id) => id !== dragId).at(-1);
  return last ? { targetId: last, place: 'after' } : null;
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  newProjectDisabled = false,
}: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const activeOrg = useOptionalOrg()?.activeOrg ?? null;
  const websiteUrl = activeOrg?.websiteUrl ?? null;
  const logoLabel = websiteUrl && activeOrg?.name ? activeOrg.name : brandLabel;
  const [allApps, setAllApps] = useState<OrgAppWithOrgName[]>([]);
  const runningApp = useOptionalRunningApp();
  const [order, setOrder] = useState<string[]>(() => readEntryNavOrder() ?? []);
  const [hidden, setHidden] = useState<string[]>(() => readEntryNavHidden());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; place: 'before' | 'after' } | null>(null);
  const [atlasOpen, setAtlasOpen] = useState(false);
  const [atlasQuery, setAtlasQuery] = useState('');
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const atlasSearchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dockOrderRef = useRef<string[]>([]);
  const dropHintRef = useRef<{ targetId: string; place: 'before' | 'after' } | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  dropHintRef.current = dropHint;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const apps = await fetchAllOrgApps();
        if (!cancelled) setAllApps(Array.isArray(apps) ? apps : []);
      } catch {
        if (!cancelled) setAllApps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  const selectView = (next: EntryView) => {
    setAtlasOpen(false);
    onViewChange(next);
  };

  const openPinned = (app: OrgAppWithOrgName) => {
    setAtlasOpen(false);
    void recordOrgAppOpen(app.orgId, app.id).catch(() => {});
    if (!runningApp) return;
    void runningApp.openApp(app.orgId, app).catch(() => {});
  };

  const apps = Array.isArray(allApps) ? allApps : [];

  const availableIds = useMemo(() => {
    const ids: string[] = [
      'home',
      'pages',
      'team',
      'mail',
      'calendar',
      'slack',
      'projects',
      'apps',
      'search',
      'erp',
      'dev',
      'design-systems',
      'library',
    ];
    ids.push('tasks', 'plugins');
    for (const app of apps) ids.push(pinnedEntryNavId(app.id));
    if (DATABASE_UI_VISIBLE) ids.push('database');
    ids.push('integrations', 'organization');
    return ids;
  }, [apps]);

  const effectiveHidden = useMemo(() => {
    const extra = apps
      .filter((app) => !app.pinned)
      .map((app) => pinnedEntryNavId(app.id))
      .filter((id) => !order.includes(id) && !hidden.includes(id));
    return extra.length === 0 ? hidden : [...hidden, ...extra];
  }, [apps, hidden, order]);

  const dockOrder = useMemo(
    () => normalizeEntryNavOrder(order, availableIds, effectiveHidden),
    [availableIds, effectiveHidden, order],
  );
  dockOrderRef.current = dockOrder;

  const commitDock = useCallback((nextOrder: string[], nextHidden: string[]) => {
    setOrder(nextOrder);
    setHidden(nextHidden);
    writeEntryNavOrder(nextOrder);
    writeEntryNavHidden(nextHidden);
  }, []);

  const addDockItem = (id: string) => {
    const next = showEntryNavItem(dockOrder, hidden, id);
    commitDock(next.order, next.hidden);
    if (isPinnedEntryNavId(id)) {
      const appId = id.slice('pinned:'.length);
      const app = apps.find((item) => item.id === appId);
      if (app && !app.pinned) {
        void updateOrgApp(app.orgId, app.id, { pinned: true })
          .then(() => {
            setAllApps((rows) => rows.map((row) => (
              row.id === app.id ? { ...row, pinned: true } : row
            )));
          })
          .catch(() => {});
      }
    }
    setAddOpen(false);
  };

  const activate = (fn: () => void) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setContextId(null);
    setAddOpen(false);
    fn();
  };

  const handleNudgeKey = (id: string, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey) return;
    const dir = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
    if (!dir) return;
    event.preventDefault();
    commitDock(nudgeEntryNavItem(dockOrderRef.current, id, dir), hidden);
  };

  const onItemPointerDown = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    dragStartRef.current = { id, x: event.clientX, y: event.clientY };
    draggingRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!draggingRef.current) {
        if (Math.hypot(dx, dy) < ENTRY_NAV_DRAG_THRESHOLD_PX) return;
        draggingRef.current = true;
        setDragId(start.id);
        setTip(null);
        setContextId(null);
        setAddOpen(false);
      }
      const list = listRef.current;
      if (list) {
        const next = dropTargetFromPoint(list, event.clientY, dockOrderRef.current, start.id);
        dropHintRef.current = next;
        setDropHint(next);
      }
    };
    const onUp = () => {
      const start = dragStartRef.current;
      if (!start) return;
      if (draggingRef.current) {
        suppressClickRef.current = true;
        const hint = dropHintRef.current;
        if (hint) {
          commitDock(
            moveEntryNavItem(dockOrderRef.current, start.id, hint.targetId, hint.place),
            hiddenRef.current,
          );
        }
      }
      dragStartRef.current = null;
      draggingRef.current = false;
      dropHintRef.current = null;
      setDragId(null);
      setDropHint(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [commitDock]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (contextId) {
        if (contextMenuRef.current && target && contextMenuRef.current.contains(target)) return;
        setContextId(null);
        setContextPos(null);
      }
      if (addOpen) {
        if (addMenuRef.current && target && addMenuRef.current.contains(target)) return;
        setAddOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextId(null);
        setContextPos(null);
        setAddOpen(false);
        setAtlasOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen, contextId]);

  useEffect(() => {
    if (!atlasOpen) return;
    atlasSearchRef.current?.focus();
  }, [atlasOpen]);

  const renderIcon = (id: string): ReactNode => {
    if (isPinnedEntryNavId(id)) {
      const appId = id.slice('pinned:'.length);
      const app = apps.find((item) => item.id === appId);
      const letter = (app?.name.trim()[0] || 'A').toUpperCase();
      return <span className={styles.appPin} aria-hidden="true">{letter}</span>;
    }
    const dest = STATIC_BY_ID.get(id);
    if (!dest) return null;
    return <Icon name={dest.icon} size={16} />;
  };

  const activateDestination = (id: string) => {
    if (isPinnedEntryNavId(id)) {
      const appId = id.slice('pinned:'.length);
      const app = apps.find((item) => item.id === appId);
      if (app) openPinned(app);
      return;
    }
    const dest = STATIC_BY_ID.get(id);
    if (dest) selectView(dest.view);
  };

  const isActiveId = (id: string): boolean => {
    const dest = STATIC_BY_ID.get(id);
    return dest ? dest.isActive(view) : false;
  };

  const renderNavButton = (id: string, variant: 'rail' | 'atlas') => {
    const label = dockItemLabel(id, t, apps);
    const dest = STATIC_BY_ID.get(id);
    const testId = dest?.testId ?? (isPinnedEntryNavId(id)
      ? `entry-nav-pinned-app-${id.slice('pinned:'.length)}`
      : undefined);
    const shortcut = id === 'search'
      ? ` (${isMacPlatform() ? '⌘ Space / ⌘ 1' : 'Ctrl+Space / Ctrl+1'})`
      : '';
    const className = variant === 'rail'
      ? `${styles.item}${isActiveId(id) ? ` ${styles.itemActive}` : ''}${dragId === id ? ` ${styles.itemDragging}` : ''}`
      : [
        styles.islandChip,
        dockOrder.includes(id) ? styles.islandChipOnStage : '',
        isActiveId(id) ? styles.islandChipActive : '',
      ].filter(Boolean).join(' ');
    return (
      <button
        type="button"
        className={className}
        onClick={activate(() => activateDestination(id))}
        onKeyDown={(event) => handleNudgeKey(id, event)}
        aria-label={label}
        aria-current={isActiveId(id) ? 'page' : undefined}
        title={`${label}${shortcut}`}
        {...(testId && variant === 'rail' ? { 'data-testid': testId } : {})}
        {...(variant === 'atlas' ? { 'data-testid': `entry-nav-atlas-${id}` } : {})}
      >
        <span className={styles.itemIcon}>{renderIcon(id)}</span>
        <span className={styles.itemLabel}>{label}</span>
      </button>
    );
  };

  const hiddenIds = availableIds.filter((id) => !dockOrder.includes(id));
  const hiddenPlaces = hiddenIds.filter((id) => !isPinnedEntryNavId(id));
  const hiddenApps = hiddenIds.filter((id) => isPinnedEntryNavId(id));
  const atlasNeedle = atlasQuery.trim().toLowerCase();
  const matchesAtlas = (id: string) => {
    if (!atlasNeedle) return true;
    return dockItemLabel(id, t, apps).toLowerCase().includes(atlasNeedle);
  };
  const expanded = Boolean(dragId);

  return (
    <nav
      className={`entry-nav-rail is-open ${styles.rail}${expanded ? ` ${styles.railExpanded}` : ''}${atlasOpen ? ` ${styles.railCatalog}` : ''}${dragId ? ' is-reordering' : ''}`}
      aria-label="Primary"
    >
      <div className={styles.head}>
        <button
          type="button"
          className={`${styles.logo}${atlasOpen ? ` ${styles.logoOpen}` : ''}`}
          onClick={() => {
            setAddOpen(false);
            setContextId(null);
            setAtlasOpen((openAtlas) => !openAtlas);
          }}
          aria-label={`${logoLabel}. ${t('entry.navOpenAtlas')}`}
          aria-expanded={atlasOpen}
          data-testid="entry-nav-logo"
        >
          <OrgMark
            orgId={activeOrg?.id}
            markVersion={activeOrg?.updatedAt}
            websiteUrl={websiteUrl}
            className={styles.logoMark}
            size={32}
          />
        </button>
        <button
          type="button"
          className={styles.tool}
          onClick={onNewProject}
          disabled={newProjectDisabled}
          aria-label={t('entry.navNewProject')}
          title={t('entry.navNewProject')}
          data-testid="entry-nav-new-project"
        >
          <span className={styles.itemIcon}><Icon name="plus" size={16} /></span>
          <span className={styles.itemLabel}>{t('entry.navNewProject')}</span>
        </button>
      </div>

      <div
        ref={listRef}
        className={`${styles.list} entry-nav-rail__dock entry-nav-rail__group`}
        data-testid="entry-nav-dock"
        aria-label={t('entry.navDock')}
        title={t('entry.navDockHint')}
      >
        {dockOrder.map((id) => {
          const hintHere = dropHint && dropHint.targetId === id;
          return (
            <div
              key={id}
              className={[
                styles.slot,
                'entry-nav-rail__slot',
                dragId === id ? 'is-dragging' : '',
                hintHere && dropHint.place === 'before' ? styles.slotDropBefore : '',
                hintHere && dropHint.place === 'after' ? styles.slotDropAfter : '',
              ].filter(Boolean).join(' ')}
              data-nav-id={id}
              data-testid={`entry-nav-slot-${id}`}
              onPointerDown={(event) => onItemPointerDown(id, event)}
              onPointerEnter={(event) => {
                if (dragStartRef.current || contextId || atlasOpen || addOpen) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setTip({
                  label: dockItemLabel(id, t, apps),
                  x: rect.right + 10,
                  y: rect.top + rect.height / 2,
                });
              }}
              onPointerLeave={() => {
                if (dragStartRef.current) return;
                setTip(null);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setAddOpen(false);
                setTip(null);
                setContextId(id);
                setContextPos({ x: event.clientX + 8, y: event.clientY });
              }}
            >
              {renderNavButton(id, 'rail')}
            </div>
          );
        })}
      </div>

      <div className={styles.foot}>
        <div className={styles.addWrap} ref={addMenuRef}>
          <button
            type="button"
            className={styles.tool}
            aria-label={t('entry.navDockEdit')}
            title={t('entry.navDockEdit')}
            onClick={() => {
              setContextId(null);
              setContextPos(null);
              setAtlasOpen(false);
              setAddOpen((openMenu) => !openMenu);
            }}
            data-testid="entry-nav-dock-add"
          >
            <span className={styles.itemIcon}><Icon name="plus" size={16} /></span>
            <span className={styles.itemLabel}>{t('entry.navDockEdit')}</span>
          </button>
          {addOpen ? (
            <div className={`${styles.menu} ${styles.addMenu} entry-nav-dock-menu`} role="menu" data-testid="entry-nav-dock-add-menu">
              {hiddenIds.length === 0 ? (
                <div className={styles.menuEmpty}>{t('entry.navDockEmptyAdd')}</div>
              ) : (
                <>
                  {ENTRY_NAV_ISLANDS.map((island) => {
                    const ids = island.ids.filter((id) => hiddenPlaces.includes(id));
                    if (ids.length === 0) return null;
                    return (
                      <div key={island.id}>
                        <div className={styles.menuLabel}>{t(island.labelKey)}</div>
                        {ids.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className={styles.menuItem}
                            role="menuitem"
                            data-testid={`entry-nav-dock-add-${id}`}
                            onClick={() => addDockItem(id)}
                          >
                            {dockItemLabel(id, t, apps)}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {hiddenApps.length > 0 ? (
                    <>
                      <div className={styles.menuLabel}>{t('entry.navDockApps')}</div>
                      {hiddenApps.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-testid={`entry-nav-dock-add-${id}`}
                          onClick={() => addDockItem(id)}
                        >
                          {dockItemLabel(id, t, apps)}
                        </button>
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
        <EntryHelpMenu />
      </div>

      {tip && !dragId && !contextId && !atlasOpen ? (
        <div className={styles.tip} style={{ top: tip.y, left: tip.x }} role="tooltip">
          {tip.label}
        </div>
      ) : null}

      {contextId && contextPos ? (
        <div
          ref={contextMenuRef}
          className={`${styles.menu} entry-nav-dock-menu entry-nav-dock-menu--fixed`}
          role="menu"
          data-testid="entry-nav-dock-item-menu"
          style={{ left: contextPos.x, top: contextPos.y }}
        >
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-testid="entry-nav-dock-remove"
            onClick={() => {
              const next = hideEntryNavItem(dockOrder, hidden, contextId);
              commitDock(next.order, next.hidden);
              setContextId(null);
              setContextPos(null);
            }}
          >
            {t('entry.navDockRemove')}
          </button>
        </div>
      ) : null}

      {atlasOpen ? (
        <div
          className={styles.atlas}
          role="dialog"
          aria-label={t('entry.navAtlas')}
          data-testid="entry-nav-atlas"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAtlasOpen(false);
          }}
        >
          <div className={styles.atlasPanel}>
            <div className={styles.atlasHead}>
              <p className={styles.atlasKicker}>{logoLabel}</p>
              <h2 className={styles.atlasTitle}>{t('entry.navAtlas')}</h2>
              <p className={styles.atlasHint}>{t('entry.navAtlasHint')}</p>
              <input
                ref={atlasSearchRef}
                className={styles.atlasSearch}
                value={atlasQuery}
                onChange={(event) => setAtlasQuery(event.target.value)}
                placeholder={t('entry.navSearch')}
                aria-label={t('entry.navSearch')}
                data-testid="entry-nav-atlas-search"
              />
            </div>
            <div className={styles.islands}>
              {ENTRY_NAV_ISLANDS.map((island) => {
                const ids = island.ids.filter((id) => availableIds.includes(id) && matchesAtlas(id));
                if (ids.length === 0) return null;
                return (
                  <section key={island.id} className={styles.island} data-testid={`entry-nav-island-${island.id}`}>
                    <h3 className={styles.islandTitle}>{t(island.labelKey)}</h3>
                    <div className={styles.islandChips}>
                      {ids.map((id) => (
                        <div key={id} className={styles.islandRow}>
                          {renderNavButton(id, 'atlas')}
                          {dockOrder.includes(id) ? null : (
                            <button
                              type="button"
                              className={styles.pinBtn}
                              aria-label={`${t('entry.navPin')}: ${dockItemLabel(id, t, apps)}`}
                              data-testid={`entry-nav-pin-${id}`}
                              onClick={() => addDockItem(id)}
                            >
                              <Icon name="plus" size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
              {apps.filter((app) => matchesAtlas(pinnedEntryNavId(app.id))).length > 0 ? (
                <section className={styles.island} data-testid="entry-nav-island-apps">
                  <h3 className={styles.islandTitle}>{t('entry.navDockApps')}</h3>
                  <div className={styles.islandChips}>
                    {apps.filter((app) => matchesAtlas(pinnedEntryNavId(app.id))).map((app) => {
                      const id = pinnedEntryNavId(app.id);
                      return (
                        <div key={app.id} className={styles.islandRow}>
                          {renderNavButton(id, 'atlas')}
                          {dockOrder.includes(id) ? null : (
                            <button
                              type="button"
                              className={styles.pinBtn}
                              aria-label={`${t('entry.navPin')}: ${app.name}`}
                              data-testid={`entry-nav-pin-${id}`}
                              onClick={() => addDockItem(id)}
                            >
                              <Icon name="plus" size={12} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </nav>
  );
}
