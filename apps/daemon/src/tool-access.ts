import {
  BYOK_TOOL_NAME_TO_ID,
  INTERNAL_DESIGN_SYSTEMS,
  INTERNAL_LIVE_ARTIFACTS,
  INTERNAL_MAIL,
  INTERNAL_PAGES,
  INTERNAL_PLUGINS,
  INTERNAL_SKILLS,
  INTERNAL_TEAM_CHAT,
  INTERNAL_WORKSPACE_DATA,
  connectorToolId,
  filterEnabledToolIds,
  isToolEnabled,
  mcpToolId,
} from '@open-design/contracts';
import type { RunContextSelection } from '@open-design/contracts';

const TOOL_FAMILY_TO_CATALOG_ID: Record<string, string> = {
  'live-artifacts': INTERNAL_LIVE_ARTIFACTS,
  'design-systems': INTERNAL_DESIGN_SYSTEMS,
  data: INTERNAL_WORKSPACE_DATA,
  erp: INTERNAL_WORKSPACE_DATA,
  pages: INTERNAL_PAGES,
  team: INTERNAL_TEAM_CHAT,
  mail: INTERNAL_MAIL,
};

export function isCatalogToolAllowed(
  id: string,
  disabledTools?: readonly string[] | null,
  grantedToolIds?: readonly string[] | null,
): boolean {
  if (!isToolEnabled(id, disabledTools)) return false;
  if (grantedToolIds && grantedToolIds.length > 0 && !grantedToolIds.includes(id)) return false;
  return true;
}

function familyFromEndpoint(endpoint: string): string | null {
  const match = /^\/api\/tools\/([^/]+)\//u.exec(endpoint);
  return match?.[1] ?? null;
}

function familyFromOperation(operation: string): string | null {
  const idx = operation.indexOf(':');
  return idx === -1 ? null : operation.slice(0, idx);
}

function familyAllowed(
  family: string | null,
  disabledTools?: readonly string[] | null,
  grantedToolIds?: readonly string[] | null,
): boolean {
  if (!family) return true;
  const catalogId = TOOL_FAMILY_TO_CATALOG_ID[family];
  if (!catalogId) return true;
  return isCatalogToolAllowed(catalogId, disabledTools, grantedToolIds);
}

export function filterChatToolSurface<TEndpoint extends string, TOperation extends string>(
  endpoints: readonly TEndpoint[],
  operations: readonly TOperation[],
  disabledTools?: readonly string[] | null,
  grantedToolIds?: readonly string[] | null,
): { endpoints: TEndpoint[]; operations: TOperation[] } {
  return {
    endpoints: endpoints.filter((endpoint) =>
      familyAllowed(familyFromEndpoint(endpoint), disabledTools, grantedToolIds),
    ),
    operations: operations.filter((operation) =>
      familyAllowed(familyFromOperation(operation), disabledTools, grantedToolIds),
    ),
  };
}

export function byokFunctionName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  const record = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof record.function?.name === 'string') return record.function.name;
  if (typeof record.name === 'string') return record.name;
  return '';
}

export function filterByokTools<T>(
  tools: readonly T[],
  disabledTools?: readonly string[] | null,
  grantedToolIds?: readonly string[] | null,
): T[] {
  const granted = grantedToolIds && grantedToolIds.length > 0 ? new Set(grantedToolIds) : null;
  return tools.filter((tool) => {
    const name = byokFunctionName(tool);
    const id = name ? BYOK_TOOL_NAME_TO_ID[name] : undefined;
    if (!id) return true;
    if (!isToolEnabled(id, disabledTools)) return false;
    if (granted && !granted.has(id)) return false;
    return true;
  });
}

export function applyToolAccess(
  context: RunContextSelection,
  disabledTools?: readonly string[] | null,
): RunContextSelection {
  const next: RunContextSelection = { ...context };
  if (next.connectorIds?.length) {
    next.connectorIds = next.connectorIds.filter((id) =>
      isToolEnabled(connectorToolId(id), disabledTools),
    );
  }
  if (next.mcpServerIds?.length) {
    next.mcpServerIds = next.mcpServerIds.filter((id) =>
      isToolEnabled(mcpToolId(id), disabledTools),
    );
  }
  if (next.toolIds?.length) {
    next.toolIds = filterEnabledToolIds(next.toolIds, disabledTools);
  }
  if (next.skillIds?.length && !isToolEnabled(INTERNAL_SKILLS, disabledTools)) {
    next.skillIds = [];
  }
  if (next.pluginIds?.length && !isToolEnabled(INTERNAL_PLUGINS, disabledTools)) {
    next.pluginIds = [];
  }
  return next;
}
