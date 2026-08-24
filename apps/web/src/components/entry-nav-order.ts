export const ENTRY_NAV_ORDER_KEY = 'od:entry-nav-order';
export const ENTRY_NAV_HIDDEN_KEY = 'od:entry-nav-hidden';

/** Pointer must travel this far before a press becomes a dock drag. */
export const ENTRY_NAV_DRAG_THRESHOLD_PX = 18;

export const DEFAULT_ENTRY_NAV_ORDER = [
  'search',
  'erp',
  'team',
  'pages',
  'calendar',
  'mail',
  'slack',
  'dev',
  'home',
  'projects',
  'design-systems',
  'library',
  'tasks',
  'plugins',
  'apps',
  'database',
  'integrations',
  'organization',
] as const;

export type StaticEntryNavId = (typeof DEFAULT_ENTRY_NAV_ORDER)[number];

export function pinnedEntryNavId(appId: string): string {
  return `pinned:${appId}`;
}

export function isPinnedEntryNavId(id: string): boolean {
  return id.startsWith('pinned:');
}

function uniqueStrings(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Visible dock ids: honor stored order, skip hidden, then append newly
 * available destinations the user has never dismissed.
 */
export function normalizeEntryNavOrder(
  stored: readonly string[] | null | undefined,
  available: readonly string[],
  hidden: readonly string[] = [],
): string[] {
  const hiddenSet = new Set(hidden);
  const avail = available.filter((id) => !hiddenSet.has(id));
  const availSet = new Set(avail);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored ?? []) {
    if (!availSet.has(id) || seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  for (const id of avail) {
    if (seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  return out;
}

export function moveEntryNavItem(
  order: readonly string[],
  fromId: string,
  targetId: string,
  place: 'before' | 'after',
): string[] {
  if (fromId === targetId) return [...order];
  const next = order.filter((id) => id !== fromId);
  const idx = next.indexOf(targetId);
  if (idx < 0) return [...order];
  next.splice(place === 'before' ? idx : idx + 1, 0, fromId);
  return next;
}

export function nudgeEntryNavItem(
  order: readonly string[],
  id: string,
  direction: 'up' | 'down',
): string[] {
  const i = order.indexOf(id);
  if (i < 0) return [...order];
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return [...order];
  const next = [...order];
  const a = next[i];
  const b = next[j];
  if (a == null || b == null) return next;
  next[i] = b;
  next[j] = a;
  return next;
}

export function hideEntryNavItem(
  order: readonly string[],
  hidden: readonly string[],
  id: string,
): { order: string[]; hidden: string[] } {
  return {
    order: order.filter((item) => item !== id),
    hidden: uniqueStrings([...hidden, id]),
  };
}

export function showEntryNavItem(
  order: readonly string[],
  hidden: readonly string[],
  id: string,
): { order: string[]; hidden: string[] } {
  const nextHidden = hidden.filter((item) => item !== id);
  return {
    order: order.includes(id) ? [...order] : [...order, id],
    hidden: nextHidden,
  };
}

function readStringList(key: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  } catch {
    return null;
  }
}

export function readEntryNavOrder(): string[] | null {
  return readStringList(ENTRY_NAV_ORDER_KEY);
}

export function writeEntryNavOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(ENTRY_NAV_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Private browsing should not break navigation.
  }
}

export function readEntryNavHidden(): string[] {
  return readStringList(ENTRY_NAV_HIDDEN_KEY) ?? [];
}

export function writeEntryNavHidden(hidden: readonly string[]): void {
  try {
    window.localStorage.setItem(ENTRY_NAV_HIDDEN_KEY, JSON.stringify(uniqueStrings(hidden)));
  } catch {
    // Private browsing should not break navigation.
  }
}

/** Dock-style falloff: closer icons grow more. */
export function dockMagnifyScale(distancePx: number, rangePx = 56): number {
  if (distancePx >= rangePx) return 1;
  const t = 1 - distancePx / rangePx;
  return 1 + 0.42 * t * t;
}

export interface DockWheelPose {
  rotateX: number;
  scale: number;
  opacity: number;
  translateZ: number;
}

export const DOCK_WHEEL_IDENTITY: DockWheelPose = {
  rotateX: 0,
  scale: 1,
  opacity: 1,
  translateZ: 0,
};

/**
 * Cylinder falloff for the vertical app wheel. `offsetPx` is the item's
 * center minus the visible midpoint (negative = above). The middle band
 * stays readable; only icons near the clip edges tilt away.
 */
export function dockWheelPose(
  offsetPx: number,
  halfHeightPx: number,
  overflowing = true,
): DockWheelPose {
  if (!overflowing || halfHeightPx <= 8) return { ...DOCK_WHEEL_IDENTITY };
  const start = halfHeightPx * 0.28;
  const dist = Math.abs(offsetPx);
  if (dist <= start) return { ...DOCK_WHEEL_IDENTITY };
  const span = Math.max(1, halfHeightPx - start);
  const t = Math.min(1, (dist - start) / span);
  const signed = (offsetPx < 0 ? -1 : 1) * t;
  const falloff = t * t;
  return {
    rotateX: signed * 52,
    scale: 1 - 0.38 * falloff,
    opacity: 1 - 0.72 * t,
    translateZ: -42 * falloff,
  };
}
