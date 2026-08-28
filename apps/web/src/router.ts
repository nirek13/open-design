// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useSyncExternalStore } from 'react';
import { LIBRARY_UI_VISIBLE } from './features/libraryUi';
import { DATABASE_UI_VISIBLE } from './features/databaseUi';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
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

export type Route =
  | {
      kind: 'home';
      view: EntryHomeView;
      /**
       * Optional preselected brand for the Brands tab. The tab renders
       * everything inline in its preview panel (there is no separate detail
       * view), so a `/brands/:id` deep-link simply drives which brand the
       * inline preview shows. Lets external surfaces (the rail, a chat link)
       * select a specific brand without leaving the tab.
       */
      brandId?: string;
      /** Deep-link into a Substrate page (`/pages/:pageId`). */
      pageId?: string;
      /** Deep-link into a mail thread (`/mail/:threadId`). */
      threadId?: string;
      /** Deep-link into a Slack channel (`/slack/:channelId`). */
      channelId?: string;
      /** Deep-link into a GitHub repo (`/dev/:owner/:repo`). */
      owner?: string;
      repo?: string;
      /** Deep-link into a workspace table (`/tables/:tableName`). */
      tableName?: string;
    }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string }
  /** Invite landing page. Renders outside the app shell: whoever follows the
   * link may not be a member of anything yet. */
  | { kind: 'join'; token: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  // The workspace is the front door. `/home` used to be a second design-agent
  // landing; it now redirects here so Ask and find share one place.
  if (parts.length === 0) return { kind: 'home', view: 'workspace' };
  if (parts[0] === 'home' && !parts[1]) return { kind: 'home', view: 'workspace' };
  if (parts[0] === 'connect' && !parts[1]) {
    return { kind: 'home', view: 'integrations' };
  }
  if (parts[0] === 'search' && !parts[1]) {
    return { kind: 'home', view: 'search' };
  }
  if (parts[0] === 'onboarding') {
    return { kind: 'home', view: 'onboarding' };
  }
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeURIComponent(parts[1]);
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeURIComponent(parts[3]);
        if (parts[4] === 'files' && parts[5]) {
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName: decodeURIComponent(parts.slice(5).join('/')),
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(3).join('/')),
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'design-systems') {
    if (parts[1] === 'create') {
      return { kind: 'design-system-create' };
    }
    if (parts[1]) {
      return { kind: 'design-system-detail', designSystemId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'brands') {
    // Brands merged into Design systems: a brand is a `user:<id>` design system
    // and extraction now starts from the design-system create wizard. Legacy
    // `/brands` and `/brands/:id` deep-links redirect onto the unified tab.
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'plugins' && !parts[1]) {
    return { kind: 'home', view: 'plugins' };
  }
  if (LIBRARY_UI_VISIBLE && parts[0] === 'library' && !parts[1]) {
    return { kind: 'home', view: 'library' };
  }
  if (parts[0] === 'integrations' || parts[0] === 'connect') {
    return { kind: 'home', view: 'integrations' };
  }
  if (DATABASE_UI_VISIBLE && parts[0] === 'database' && !parts[1]) {
    return { kind: 'home', view: 'database' };
  }
  if (parts[0] === 'workspace' && !parts[1]) {
    return { kind: 'home', view: 'workspace' };
  }
  if (parts[0] === 'erp') {
    if (parts[1] === 'netsuite') return { kind: 'home', view: 'erp' };
    if (parts[1] === 'connections') return { kind: 'home', view: 'integrations' };
    return { kind: 'home', view: 'books' };
  }
  if (parts[0] === 'connections' && !parts[1]) {
    return { kind: 'home', view: 'integrations' };
  }
  if (parts[0] === 'books' && !parts[1]) {
    return { kind: 'home', view: 'books' };
  }
  if (parts[0] === 'approvals' && !parts[1]) {
    return { kind: 'home', view: 'approvals' };
  }
  if (parts[0] === 'crm' && !parts[1]) {
    return { kind: 'home', view: 'crm' };
  }
  if (parts[0] === 'purchasing' && !parts[1]) {
    return { kind: 'home', view: 'purchasing' };
  }
  if (parts[0] === 'team') {
    if (parts[1]) {
      return { kind: 'home', view: 'team', channelId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'team' };
  }
  if (parts[0] === 'pages') {
    if (parts[1]) {
      return { kind: 'home', view: 'pages', pageId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'pages' };
  }
  if (parts[0] === 'calendar' && !parts[1]) {
    return { kind: 'home', view: 'calendar' };
  }
  if (parts[0] === 'mail') {
    if (parts[1]) {
      return { kind: 'home', view: 'mail', threadId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'mail' };
  }
  if (parts[0] === 'slack') {
    if (parts[1]) {
      return { kind: 'home', view: 'slack', channelId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'slack' };
  }
  if (parts[0] === 'dev') {
    if (parts[1] && parts[2]) {
      return {
        kind: 'home',
        view: 'dev',
        owner: decodeURIComponent(parts[1]),
        repo: decodeURIComponent(parts[2]),
      };
    }
    return { kind: 'home', view: 'dev' };
  }
  if (parts[0] === 'templates' && !parts[1]) {
    return { kind: 'home', view: 'templates' };
  }
  if (parts[0] === 'tables') {
    if (parts[1]) {
      return { kind: 'home', view: 'tables', tableName: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'tables' };
  }
  if (parts[0] === 'inventory' && !parts[1]) {
    return { kind: 'home', view: 'inventory' };
  }
  if (parts[0] === 'jobs' && !parts[1]) {
    return { kind: 'home', view: 'jobs' };
  }
  if (parts[0] === 'apps' && !parts[1]) {
    return { kind: 'home', view: 'apps' };
  }
  if (parts[0] === 'organization' && !parts[1]) {
    return { kind: 'home', view: 'organization' };
  }
  if (parts[0] === 'join' && parts[1]) {
    return { kind: 'join', token: decodeURIComponent(parts[1]) };
  }
  // Phase 2B / spec §11.6 — marketplace deep UI routes. Two paths:
  //   /marketplace            → catalog grid (MarketplaceView)
  //   /marketplace/<pluginId> → detail page (PluginDetailView)
  // Aliases to /plugins remain reserved for the public site (spec §13);
  // in-app we keep /marketplace canonical.
  if (parts[0] === 'marketplace' || parts[0] === 'plugins') {
    if (parts[1]) {
      return { kind: 'marketplace-detail', pluginId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'marketplace' };
  }
  return { kind: 'home', view: 'workspace' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'onboarding') return '/onboarding';
    if (route.view === 'search') return '/search';
    if (route.view === 'jobs') return '/jobs';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'plugins') return '/plugins';
    if (route.view === 'design-systems') return '/design-systems';
    if (route.view === 'library') return LIBRARY_UI_VISIBLE ? '/library' : '/';
    if (route.view === 'brands') {
      return route.brandId ? `/brands/${encodeURIComponent(route.brandId)}` : '/brands';
    }
    if (route.view === 'integrations') return '/connect';
    if (route.view === 'database') return DATABASE_UI_VISIBLE ? '/database' : '/';
    if (route.view === 'workspace') return '/';
    if (route.view === 'erp') return '/erp/netsuite';
    if (route.view === 'connections') return '/connect';
    if (route.view === 'books') return '/books';
    if (route.view === 'approvals') return '/approvals';
    if (route.view === 'crm') return '/crm';
    if (route.view === 'purchasing') return '/purchasing';
    if (route.view === 'team') {
      return route.channelId ? `/team/${encodeURIComponent(route.channelId)}` : '/team';
    }
    if (route.view === 'pages') {
      return route.pageId ? `/pages/${encodeURIComponent(route.pageId)}` : '/pages';
    }
    if (route.view === 'calendar') return '/calendar';
    if (route.view === 'mail') {
      return route.threadId ? `/mail/${encodeURIComponent(route.threadId)}` : '/mail';
    }
    if (route.view === 'slack') {
      return route.channelId ? `/slack/${encodeURIComponent(route.channelId)}` : '/slack';
    }
    if (route.view === 'dev') {
      if (route.owner && route.repo) {
        return `/dev/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
      }
      return '/dev';
    }
    if (route.view === 'templates') return '/templates';
    if (route.view === 'tables') {
      return route.tableName ? `/tables/${encodeURIComponent(route.tableName)}` : '/tables';
    }
    if (route.view === 'inventory') return '/inventory';
    if (route.view === 'projects') return '/projects';
    if (route.view === 'apps') return '/apps';
    if (route.view === 'organization') return '/organization';
    return '/';
  }
  if (route.kind === 'join') return `/join/${encodeURIComponent(route.token)}`;
  if (route.kind === 'marketplace') return '/marketplace';
  if (route.kind === 'marketplace-detail') return `/marketplace/${encodeURIComponent(route.pluginId)}`;
  if (route.kind === 'design-system-create') return '/design-systems/create';
  if (route.kind === 'design-system-detail') {
    return `/design-systems/${encodeURIComponent(route.designSystemId)}`;
  }
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName.split('/').map((s) => encodeURIComponent(s)).join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
//
// The `popstate` dispatch is deferred to a microtask so that callers
// can safely invoke `navigate()` from inside a `useState` updater or
// during a render commit phase without triggering React's
// "Cannot update a component while rendering a different component"
// warning. The `history` API call itself stays synchronous so the URL
// bar updates immediately; only the `useRoute()` subscriber updates
// are deferred past the current render.
// Each history entry carries a monotonic depth (`odIndex`) so `goBack()` can
// tell whether there is an in-app entry behind the current one. We store it in
// `history.state` — nothing else reads host history state — so it survives
// reloads and the browser's own back/forward. The very first entry (a fresh
// load or deep link) has no state, which reads as index 0.
interface HistoryState {
  odIndex: number;
}

function readHistoryIndex(): number {
  const state = window.history.state as Partial<HistoryState> | null;
  return typeof state?.odIndex === 'number' ? state.odIndex : 0;
}

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  if (target === current) return;
  const index = readHistoryIndex();
  // `replace` keeps the current depth (it swaps the entry in place); a push
  // adds one level so the entry we are leaving becomes the "previous layer".
  const nextState: HistoryState = { odIndex: opts.replace ? index : index + 1 };
  if (opts.replace) {
    window.history.replaceState(nextState, '', target);
  } else {
    window.history.pushState(nextState, '', target);
  }
  queueMicrotask(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

// Step back to the route the user actually came from. We pop the browser
// history stack (which `navigate()` builds via pushState) so "back" lands on
// the real previous layer — Projects, Tasks, a design system, wherever — not a
// hardcoded destination. When the current entry is the first in-app entry
// (`odIndex` 0: deep link or fresh load), there is nothing in-app to pop, so we
// navigate to `fallback` instead of letting `history.back()` escape the app.
export function goBack(fallback: Route): void {
  if (readHistoryIndex() > 0) {
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

let cachedPathname: string | null = null;
let cachedRoute: Route | null = null;

function getRouteSnapshot(): Route {
  const pathname = window.location.pathname;
  if (cachedPathname !== pathname || cachedRoute === null) {
    cachedPathname = pathname;
    cachedRoute = parseRoute(pathname);
  }
  return cachedRoute;
}

function subscribeToRouteChanges(onStoreChange: () => void): () => void {
  window.addEventListener('popstate', onStoreChange);
  return () => window.removeEventListener('popstate', onStoreChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeToRouteChanges, getRouteSnapshot, getRouteSnapshot);
}
