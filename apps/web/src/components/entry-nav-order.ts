export const ENTRY_NAV_ORDER_KEY = 'od:entry-nav-order-v3';
export const ENTRY_NAV_HIDDEN_KEY = 'od:entry-nav-hidden-v3';
export const ENTRY_NAV_LAYOUT_KEY = 'od:entry-nav-layout-v1';

/** Pointer must travel this far before a press becomes a stage drag. */
export const ENTRY_NAV_DRAG_THRESHOLD_PX = 18;

export type StagePoint = { x: number; y: number };

export type EntryNavIslandId = 'work' | 'make' | 'connect' | 'more';

/** Groups in the Places catalog. Pinned apps join as their own island. */
export const ENTRY_NAV_ISLANDS: ReadonlyArray<{
  id: EntryNavIslandId;
  labelKey:
    | 'entry.navIslandWork'
    | 'entry.navIslandMake'
    | 'entry.navIslandConnect'
    | 'entry.navIslandMore';
  ids: readonly string[];
}> = [
  { id: 'work', labelKey: 'entry.navIslandWork', ids: ['home', 'pages', 'team', 'organization'] },
  { id: 'make', labelKey: 'entry.navIslandMake', ids: ['projects', 'apps', 'design-systems', 'library', 'plugins'] },
  { id: 'connect', labelKey: 'entry.navIslandConnect', ids: ['mail', 'calendar', 'slack', 'integrations', 'dev'] },
  { id: 'more', labelKey: 'entry.navIslandMore', ids: ['search', 'erp', 'tasks', 'database'] },
];

/** Company spine on the default sidebar. Everything else is one Add away. */
export const DEFAULT_ENTRY_NAV_ORDER = [
  'home',
  'pages',
  'team',
  'projects',
  'apps',
] as const;

/** Off the default stage until the person adds them. Mail/Calendar/Slack stay
 *  choosable even before those accounts are connected. */
export const DEFAULT_ENTRY_NAV_HIDDEN = [
  'search',
  'mail',
  'calendar',
  'slack',
  'erp',
  'dev',
  'design-systems',
  'library',
  'tasks',
  'plugins',
  'database',
  'integrations',
  'organization',
] as const;

/** Dock destinations that appear only after the matching account is connected. */
export const DOCK_WORK_SURFACE_CONNECTORS = {
  mail: ['gmail'],
  calendar: ['googlecalendar'],
  slack: ['slack'],
} as const;

export type DockWorkSurfaceId = keyof typeof DOCK_WORK_SURFACE_CONNECTORS;

export function dockWorkSurfacesFromStatuses(
  statuses: Record<string, { status?: string } | undefined>,
): DockWorkSurfaceId[] {
  const out: DockWorkSurfaceId[] = [];
  for (const id of Object.keys(DOCK_WORK_SURFACE_CONNECTORS) as DockWorkSurfaceId[]) {
    const connected = DOCK_WORK_SURFACE_CONNECTORS[id].some(
      (connectorId) => statuses[connectorId]?.status === 'connected',
    );
    if (connected) out.push(id);
  }
  return out;
}

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
  return readStringList(ENTRY_NAV_HIDDEN_KEY) ?? [...DEFAULT_ENTRY_NAV_HIDDEN];
}

export function writeEntryNavHidden(hidden: readonly string[]): void {
  try {
    window.localStorage.setItem(ENTRY_NAV_HIDDEN_KEY, JSON.stringify(uniqueStrings(hidden)));
  } catch {
    // Private browsing should not break navigation.
  }
}

function isStagePoint(value: unknown): value is StagePoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as StagePoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function clampStagePoint(point: StagePoint): StagePoint {
  return {
    x: Math.min(0.96, Math.max(0.04, point.x)),
    y: Math.min(0.94, Math.max(0.06, point.y)),
  };
}

/**
 * Default bloom around the compass: a fan up and to the right so chips
 * do not cover the centered hub, and never form a vertical dock.
 */
export function defaultBloomPoint(
  index: number,
  viewport: { w: number; h: number } = { w: 1280, h: 800 },
): StagePoint {
  const compassX = 48;
  const compassY = viewport.h - 48;
  const deg = 12 + index * 22;
  const rad = (deg * Math.PI) / 180;
  const r = 150 + (index % 2) * 36;
  return clampStagePoint({
    x: (compassX + Math.cos(rad) * r) / Math.max(1, viewport.w),
    y: (compassY - Math.sin(rad) * r) / Math.max(1, viewport.h),
  });
}

export function nudgeStagePoint(
  point: StagePoint,
  direction: 'up' | 'down' | 'left' | 'right',
  step = 0.014,
): StagePoint {
  const dx = direction === 'left' ? -step : direction === 'right' ? step : 0;
  const dy = direction === 'up' ? -step : direction === 'down' ? step : 0;
  return clampStagePoint({ x: point.x + dx, y: point.y + dy });
}

/** A little rest tilt so chips feel placed, not filed. */
export function restTilt(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 7) - 3) * 1.15;
}

export function readEntryNavLayout(): Record<string, StagePoint> {
  try {
    const raw = window.localStorage.getItem(ENTRY_NAV_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StagePoint> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || !isStagePoint(value)) continue;
      out[id] = clampStagePoint(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function writeEntryNavLayout(layout: Record<string, StagePoint>): void {
  try {
    window.localStorage.setItem(ENTRY_NAV_LAYOUT_KEY, JSON.stringify(layout));
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
