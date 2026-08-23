// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand logo,
// followed by the primary destinations users expect to keep in reach:
// New project, home, projects, brand kit, automations, plugins,
// and integrations. Footer controls are reserved for lower-frequency
// support affordances such as the help launcher.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.
//
// Destination icons behave like a macOS Dock: click to open, drag to
// rearrange, drag off or right-click to remove, and add shortcuts back
// from the dock plus menu. When the stack is taller than the rail, the
// dock scrolls as a cylinder — icons tilt and fade at the rim so every
// app stays reachable without a scrollbar.

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
import { Icon } from './Icon';
import { useT } from '../i18n';
import { LIBRARY_UI_VISIBLE } from '../features/libraryUi';
import { DATABASE_UI_VISIBLE } from '../features/databaseUi';
import type { OrgAppWithOrgName } from '@open-design/contracts';
import { fetchAllOrgApps, recordOrgAppOpen } from '../providers/registry';
import { useOptionalRunningApp } from './apps/RunningAppContext';
import { isErpEntryView } from './erp/ErpShell';
import {
  dockMagnifyScale,
  dockWheelPose,
  ENTRY_NAV_DRAG_THRESHOLD_PX,
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

export type EntryView =
  | 'home'
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
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Collapse the rail — called after a destination is chosen or the user dismisses it. */
  onClose: () => void;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  fixed?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}

function NavButton({
  active,
  ariaLabel,
  tooltip,
  onClick,
  disabled,
  testId,
  fixed = false,
  onKeyDown,
  children,
}: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}${fixed ? ' entry-nav-rail__btn--fixed' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </button>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function dockItemLabel(
  id: string,
  t: ReturnType<typeof useT>,
  pinnedApps: OrgAppWithOrgName[],
): string {
  if (isPinnedEntryNavId(id)) {
    const appId = id.slice('pinned:'.length);
    return pinnedApps.find((app) => app.id === appId)?.name ?? appId;
  }
  switch (id) {
    case 'erp': return t('entry.navErp');
    case 'team': return t('entry.navTeam');
    case 'pages': return t('entry.navPages');
    case 'calendar': return t('entry.navCalendar');
    case 'mail': return t('entry.navMail');
    case 'home': return t('entry.navHome');
    case 'projects': return t('entry.navProjects');
    case 'design-systems': return t('entry.navDesignSystems');
    case 'library': return 'Library';
    case 'tasks': return t('entry.navTasks');
    case 'plugins': return t('entry.navPlugins');
    case 'apps': return t('entry.navApps');
    case 'database': return t('entry.navDatabase');
    case 'integrations': return t('entry.navIntegrations');
    case 'organization': return t('entry.navOrganization');
    default: return id;
  }
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  newProjectDisabled = false,
  open,
  onClose,
}: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';
  const [pinnedApps, setPinnedApps] = useState<OrgAppWithOrgName[]>([]);
  const runningApp = useOptionalRunningApp();
  const [order, setOrder] = useState<string[]>(() => readEntryNavOrder() ?? []);
  const [hidden, setHidden] = useState<string[]>(() => readEntryNavHidden());
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [scales, setScales] = useState<Record<string, number>>({});
  const [poses, setPoses] = useState<Record<string, { rotateX: number; opacity: number; z: number }>>({});
  const [overflowing, setOverflowing] = useState(false);
  const [tip, setTip] = useState<{ label: string; x: number; y: number; rtl?: boolean } | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const dockRef = useRef<HTMLDivElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ id: string; x: number; y: number; pointerId: number } | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const magFrameRef = useRef(0);
  const hoverYRef = useRef<number | null>(null);
  const dockOrderRef = useRef<string[]>([]);
  const dropRef = useRef<{ id: string; place: 'before' | 'after' } | null>(null);
  const removingRef = useRef(false);
  const hiddenRef = useRef(hidden);
  const commitDockRef = useRef<(nextOrder: string[], nextHidden: string[]) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const apps = await fetchAllOrgApps({ pinnedOnly: true });
        if (!cancelled) setPinnedApps(apps);
      } catch {
        if (!cancelled) setPinnedApps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, open]);

  const selectView = (next: EntryView) => {
    onViewChange(next);
  };

  const openPinned = (app: OrgAppWithOrgName) => {
    void recordOrgAppOpen(app.orgId, app.id).catch(() => {});
    if (!runningApp) return;
    void runningApp.openApp(app.orgId, app).catch(() => {
      // openApp already surfaces openError on the provider; pinned clicks
      // stay silent so the rail doesn't grow an error banner.
    });
  };

  const availableIds = useMemo(() => {
    const ids: string[] = [
      'erp',
      'team',
      'pages',
      'calendar',
      'mail',
      'home',
      'projects',
      'design-systems',
    ];
    if (LIBRARY_UI_VISIBLE) ids.push('library');
    ids.push('tasks', 'plugins', 'apps');
    for (const app of pinnedApps) ids.push(pinnedEntryNavId(app.id));
    if (DATABASE_UI_VISIBLE) ids.push('database');
    ids.push('integrations', 'organization');
    return ids;
  }, [pinnedApps]);

  const dockOrder = useMemo(
    () => normalizeEntryNavOrder(order, availableIds, hidden),
    [availableIds, hidden, order],
  );
  dockOrderRef.current = dockOrder;
  dropRef.current = drop;
  removingRef.current = removing;
  hiddenRef.current = hidden;

  const commitDock = useCallback((nextOrder: string[], nextHidden: string[]) => {
    setOrder(nextOrder);
    setHidden(nextHidden);
    writeEntryNavOrder(nextOrder);
    writeEntryNavHidden(nextHidden);
  }, []);
  commitDockRef.current = commitDock;

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
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    commitDock(
      nudgeEntryNavItem(dockOrderRef.current, id, event.key === 'ArrowUp' ? 'up' : 'down'),
      hiddenRef.current,
    );
  };

  const updateDockVisuals = (clientY: number | null = hoverYRef.current) => {
    if (magFrameRef.current) cancelAnimationFrame(magFrameRef.current);
    magFrameRef.current = requestAnimationFrame(() => {
      const dock = dockRef.current;
      const reduce = prefersReducedMotion();
      const nextScales: Record<string, number> = {};
      const nextPoses: Record<string, { rotateX: number; opacity: number; z: number }> = {};
      let nextOverflowing = false;
      if (dock) {
        nextOverflowing = dock.scrollHeight > dock.clientHeight + 1;
        const dockRect = dock.getBoundingClientRect();
        const midY = dockRect.top + dockRect.height / 2;
        const half = Math.max(1, dockRect.height / 2);
        const hoverActive = clientY != null && !draggingRef.current && !reduce && !contextId && !addOpen;
        for (const [id, el] of slotRefs.current) {
          const rect = el.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const pose = reduce
            ? { rotateX: 0, scale: 1, opacity: 1, translateZ: 0 }
            : dockWheelPose(center - midY, half, nextOverflowing);
          nextPoses[id] = { rotateX: pose.rotateX, opacity: pose.opacity, z: pose.translateZ };
          const hover = hoverActive && clientY != null
            ? dockMagnifyScale(Math.abs(clientY - center))
            : 1;
          nextScales[id] = pose.scale * hover;
        }
      }
      setOverflowing(nextOverflowing);
      setScales((prev) => {
        const keys = Object.keys(nextScales);
        if (keys.length === 0 && Object.keys(prev).length === 0) return prev;
        return nextScales;
      });
      setPoses(nextPoses);
      if (clientY == null || draggingRef.current || contextId || addOpen) {
        setTip(null);
      }
    });
  };

  const updateDockVisualsRef = useRef(updateDockVisuals);
  updateDockVisualsRef.current = updateDockVisuals;

  const onDockPointerDown = (id: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStartRef.current = { id, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    draggingRef.current = false;
    setContextId(null);
    setAddOpen(false);
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dist = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (!draggingRef.current && dist < ENTRY_NAV_DRAG_THRESHOLD_PX) return;
      if (!draggingRef.current) {
        draggingRef.current = true;
        suppressClickRef.current = true;
        setDragId(start.id);
        setTip(null);
        setScales({});
        const slot = slotRefs.current.get(start.id);
        try {
          slot?.setPointerCapture(event.pointerId);
        } catch {
          // Capture is optional; document listeners still track the pointer.
        }
      }
      const hit = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-nav-id]');
      const id = hit?.getAttribute('data-nav-id');
      if (id && id !== start.id && hit) {
        const hitRect = hit.getBoundingClientRect();
        setRemoving(false);
        setDrop({
          id,
          place: event.clientY < hitRect.top + hitRect.height / 2 ? 'before' : 'after',
        });
        return;
      }
      const dock = dockRef.current;
      if (dock) {
        const rect = dock.getBoundingClientRect();
        const edge = 28;
        if (event.clientY < rect.top + edge) dock.scrollTop -= 12;
        else if (event.clientY > rect.bottom - edge) dock.scrollTop += 12;
        const pad = 36;
        const outside = event.clientX > rect.right + pad
          || event.clientX < rect.left - pad
          || event.clientY < rect.top - pad
          || event.clientY > rect.bottom + pad;
        setRemoving(outside);
      }
      setDrop(null);
      updateDockVisualsRef.current();
    };
    const onUp = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      if (draggingRef.current) {
        if (removingRef.current) {
          const next = hideEntryNavItem(dockOrderRef.current, hiddenRef.current, start.id);
          commitDockRef.current(next.order, next.hidden);
        } else if (dropRef.current) {
          commitDockRef.current(
            moveEntryNavItem(dockOrderRef.current, start.id, dropRef.current.id, dropRef.current.place),
            hiddenRef.current,
          );
        }
      }
      try {
        slotRefs.current.get(start.id)?.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already be released.
      }
      dragStartRef.current = null;
      draggingRef.current = false;
      setDragId(null);
      setDrop(null);
      setRemoving(false);
      updateDockVisualsRef.current();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  useEffect(() => {
    if (!contextId && !addOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (contextId) {
        const slot = slotRefs.current.get(contextId);
        if (slot && target && slot.contains(target)) return;
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
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen, contextId]);

  const renderDockButton = (id: string) => {
    const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>) => handleNudgeKey(id, event);
    switch (id) {
      case 'erp':
        return (
          <NavButton
            active={isErpEntryView(view)}
            ariaLabel={t('entry.navErp')}
            tooltip={t('entry.navErp')}
            onClick={activate(() => selectView('workspace'))}
            testId="entry-nav-erp"
            onKeyDown={nudge}
          >
            <Icon name="grid" size={18} />
          </NavButton>
        );
      case 'team':
        return (
          <NavButton
            active={view === 'team'}
            ariaLabel={t('entry.navTeam')}
            tooltip={t('entry.navTeam')}
            onClick={activate(() => selectView('team'))}
            testId="entry-nav-team"
            onKeyDown={nudge}
          >
            <Icon name="message-circle" size={18} />
          </NavButton>
        );
      case 'pages':
        return (
          <NavButton
            active={view === 'pages'}
            ariaLabel={t('entry.navPages')}
            tooltip={t('entry.navPages')}
            onClick={activate(() => selectView('pages'))}
            testId="entry-nav-pages"
            onKeyDown={nudge}
          >
            <Icon name="file-text" size={18} />
          </NavButton>
        );
      case 'calendar':
        return (
          <NavButton
            active={view === 'calendar'}
            ariaLabel={t('entry.navCalendar')}
            tooltip={t('entry.navCalendar')}
            onClick={activate(() => selectView('calendar'))}
            testId="entry-nav-calendar"
            onKeyDown={nudge}
          >
            <Icon name="history" size={18} />
          </NavButton>
        );
      case 'mail':
        return (
          <NavButton
            active={view === 'mail'}
            ariaLabel={t('entry.navMail')}
            tooltip={t('entry.navMail')}
            onClick={activate(() => selectView('mail'))}
            testId="entry-nav-mail"
            onKeyDown={nudge}
          >
            <Icon name="mail" size={18} />
          </NavButton>
        );
      case 'home':
        return (
          <NavButton
            active={isHome}
            ariaLabel={homeLabel}
            tooltip={homeLabel}
            onClick={activate(() => selectView('home'))}
            testId="entry-nav-home"
            onKeyDown={nudge}
          >
            <Icon name="home" size={18} />
          </NavButton>
        );
      case 'projects':
        return (
          <NavButton
            active={view === 'projects'}
            ariaLabel={t('entry.navProjects')}
            tooltip={t('entry.navProjects')}
            onClick={activate(() => selectView('projects'))}
            testId="entry-nav-projects"
            onKeyDown={nudge}
          >
            <Icon name="folder" size={18} />
          </NavButton>
        );
      case 'design-systems':
        return (
          <NavButton
            active={view === 'design-systems'}
            ariaLabel={t('entry.navDesignSystems')}
            tooltip={t('entry.navDesignSystems')}
            onClick={activate(() => selectView('design-systems'))}
            testId="entry-nav-design-systems"
            onKeyDown={nudge}
          >
            <Icon name="palette" size={18} />
          </NavButton>
        );
      case 'library':
        return (
          <NavButton
            active={view === 'library'}
            ariaLabel="Library"
            tooltip="Library"
            onClick={activate(() => selectView('library'))}
            testId="entry-nav-library"
            onKeyDown={nudge}
          >
            <Icon name="layers-filled" size={18} />
          </NavButton>
        );
      case 'tasks':
        return (
          <NavButton
            active={view === 'tasks'}
            ariaLabel={t('entry.navTasks')}
            tooltip={t('entry.navTasks')}
            onClick={activate(() => selectView('tasks'))}
            testId="entry-nav-tasks"
            onKeyDown={nudge}
          >
            <Icon name="kanban" size={18} />
          </NavButton>
        );
      case 'plugins':
        return (
          <NavButton
            active={view === 'plugins'}
            ariaLabel={t('entry.navPlugins')}
            tooltip={t('entry.navPlugins')}
            onClick={activate(() => selectView('plugins'))}
            testId="entry-nav-plugins"
            onKeyDown={nudge}
          >
            <Icon name="grid" size={18} />
          </NavButton>
        );
      case 'apps':
        return (
          <NavButton
            active={view === 'apps'}
            ariaLabel={t('entry.navApps')}
            tooltip={t('entry.navApps')}
            onClick={activate(() => selectView('apps'))}
            testId="entry-nav-apps"
            onKeyDown={nudge}
          >
            <Icon name="blocks" size={18} />
          </NavButton>
        );
      case 'database':
        return (
          <NavButton
            active={view === 'database'}
            ariaLabel={t('entry.navDatabase')}
            tooltip={t('entry.navDatabase')}
            onClick={activate(() => selectView('database'))}
            testId="entry-nav-database"
            onKeyDown={nudge}
          >
            <Icon name="layout" size={18} />
          </NavButton>
        );
      case 'integrations':
        return (
          <NavButton
            active={view === 'integrations'}
            ariaLabel={t('entry.navIntegrations')}
            tooltip={t('entry.navIntegrations')}
            onClick={activate(() => selectView('integrations'))}
            testId="entry-nav-integrations"
            onKeyDown={nudge}
          >
            <Icon name="link" size={18} />
          </NavButton>
        );
      case 'organization':
        return (
          <NavButton
            active={view === 'organization'}
            ariaLabel={t('entry.navOrganization')}
            tooltip={t('entry.navOrganization')}
            onClick={activate(() => selectView('organization'))}
            testId="entry-nav-organization"
            onKeyDown={nudge}
          >
            <Icon name="orbit" size={18} />
          </NavButton>
        );
      default: {
        if (!isPinnedEntryNavId(id)) return null;
        const appId = id.slice('pinned:'.length);
        const app = pinnedApps.find((item) => item.id === appId);
        if (!app) return null;
        return (
          <NavButton
            ariaLabel={app.name}
            tooltip={app.name}
            onClick={activate(() => openPinned(app))}
            testId={`entry-nav-pinned-app-${app.id}`}
            onKeyDown={nudge}
          >
            <span className="entry-nav-rail__app-pin" aria-hidden="true">
              {(app.name.trim()[0] || 'A').toUpperCase()}
            </span>
          </NavButton>
        );
      }
    }
  };

  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  useEffect(() => () => {
    if (magFrameRef.current) cancelAnimationFrame(magFrameRef.current);
  }, []);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const onScroll = () => {
      setContextId(null);
      setContextPos(null);
      setTip(null);
      updateDockVisualsRef.current();
    };
    dock.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => updateDockVisualsRef.current());
    observer.observe(dock);
    updateDockVisualsRef.current();
    return () => {
      dock.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [dockOrder, open]);

  const hiddenIds = availableIds.filter((id) => !dockOrder.includes(id));

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}${dragId ? ' is-reordering' : ''}${removing ? ' is-removing' : ''}`}
      aria-label="Primary"
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__group">
        <div className="entry-nav-rail__brand">
          <button
            type="button"
            className="entry-nav-rail__logo"
            onClick={() => selectView('home')}
            aria-label={brandLabel}
            data-testid="entry-nav-logo"
          >
            <span
              className="entry-nav-rail__logo-img od-brand-glyph"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="entry-nav-rail__collapse"
            onClick={onClose}
            aria-label={t('entry.navCollapse')}
            title={t('entry.navCollapse')}
            data-testid="entry-nav-collapse"
          >
            <Icon name="panel-left" size={20} />
          </button>
        </div>
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />
        <NavButton
          ariaLabel={t('entry.navNewProject')}
          tooltip={t('entry.navNewProject')}
          onClick={onNewProject}
          disabled={newProjectDisabled}
          testId="entry-nav-new-project"
          fixed
        >
          <Icon name="plus" size={18} />
        </NavButton>
        <div
          ref={dockRef}
          className={`entry-nav-rail__dock${overflowing ? ' is-overflowing' : ''}`}
          data-testid="entry-nav-dock"
          aria-label={t('entry.navDock')}
          title={t('entry.navDockHint')}
          onPointerMove={(event) => {
            if (dragStartRef.current) return;
            hoverYRef.current = event.clientY;
            updateDockVisuals(event.clientY);
          }}
          onPointerLeave={() => {
            if (dragStartRef.current) return;
            hoverYRef.current = null;
            setTip(null);
            updateDockVisuals(null);
          }}
        >
          {dockOrder.map((id) => {
            const button = renderDockButton(id);
            if (!button) return null;
            const scale = dragId ? 1 : (scales[id] ?? 1);
            const pose = poses[id];
            const rotateX = dragId ? 0 : (pose?.rotateX ?? 0);
            const opacity = pose?.opacity ?? 1;
            const translateZ = dragId ? 0 : (pose?.z ?? 0);
            return (
              <div
                key={id}
                className={[
                  'entry-nav-rail__slot',
                  dragId === id ? 'is-dragging' : '',
                  dragId === id && removing ? 'is-throwing' : '',
                  drop?.id === id && drop.place === 'before' ? 'is-drop-before' : '',
                  drop?.id === id && drop.place === 'after' ? 'is-drop-after' : '',
                ].filter(Boolean).join(' ')}
                data-nav-id={id}
                data-testid={`entry-nav-slot-${id}`}
                style={{
                  transform: `translateZ(${translateZ}px) rotateX(${rotateX}deg) scale(${scale})`,
                  opacity,
                  zIndex: scale > 1.04 || contextId === id ? 4 : 1,
                }}
                ref={(node) => {
                  if (node) slotRefs.current.set(id, node);
                  else slotRefs.current.delete(id);
                }}
                onPointerDown={(event) => onDockPointerDown(id, event)}
                onPointerEnter={(event) => {
                  if (dragStartRef.current || contextId) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const rtl = document.documentElement.dir === 'rtl';
                  setTip({
                    label: dockItemLabel(id, t, pinnedApps),
                    x: rtl ? rect.left - 10 : rect.right + 10,
                    y: rect.top + rect.height / 2,
                    rtl,
                  });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setAddOpen(false);
                  setTip(null);
                  setContextId(id);
                  setContextPos({ x: event.clientX + 8, y: event.clientY });
                }}
              >
                {button}
              </div>
            );
          })}
        </div>
        {tip && !dragId && !contextId ? (
          <div
            className={`entry-nav-rail__wheel-tip${tip.rtl ? ' is-rtl' : ''}`}
            style={{ top: tip.y, left: tip.x }}
            role="tooltip"
          >
            {tip.label}
          </div>
        ) : null}
        {contextId && contextPos ? (
          <div
            ref={contextMenuRef}
            className="entry-nav-dock-menu entry-nav-dock-menu--fixed"
            role="menu"
            data-testid="entry-nav-dock-item-menu"
            style={{ left: contextPos.x, top: contextPos.y }}
          >
            <button
              type="button"
              className="entry-nav-dock-menu__item"
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
        {removing ? (
          <div className="entry-nav-dock-remove-hint" data-testid="entry-nav-dock-remove-hint">
            {t('entry.navDockRemoving')}
          </div>
        ) : null}
        <div className="entry-nav-rail__add" ref={addMenuRef}>
          <NavButton
            ariaLabel={t('entry.navDockEdit')}
            tooltip={t('entry.navDockEdit')}
            onClick={() => {
              setContextId(null);
              setContextPos(null);
              setAddOpen((openMenu) => !openMenu);
            }}
            testId="entry-nav-dock-add"
            fixed
          >
            <Icon name="more-horizontal" size={18} />
          </NavButton>
          {addOpen ? (
            <div className="entry-nav-dock-menu entry-nav-dock-menu--add" role="menu" data-testid="entry-nav-dock-add-menu">
              {hiddenIds.length === 0 ? (
                <div className="entry-nav-dock-menu__empty">{t('entry.navDockEmptyAdd')}</div>
              ) : (
                hiddenIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="entry-nav-dock-menu__item"
                    role="menuitem"
                    data-testid={`entry-nav-dock-add-${id}`}
                    onClick={() => {
                      const next = showEntryNavItem(dockOrder, hidden, id);
                      commitDock(next.order, next.hidden);
                      setAddOpen(false);
                    }}
                  >
                    {dockItemLabel(id, t, pinnedApps)}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div className="entry-nav-rail__footer">
        <div className="entry-nav-rail__divider" role="separator" />
        <EntryHelpMenu />
      </div>
    </nav>
  );
}
