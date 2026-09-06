// Unified tool catalog for agents and automations.
//
// Internal entries are built-in Substrate capabilities. External entries are
// connected apps (Composio connectors) plus any MCP servers the user has
// configured. Preferences are stored as `AppConfigPrefs.disabledTools`
// (opt-out): missing/empty means every catalog tool is on.

export type ToolOrigin = 'internal' | 'external';
export type ToolKind = 'capability' | 'connector' | 'mcp';
export type ToolGroup = 'create' | 'research' | 'workspace' | 'apps';

export type InternalToolId = `internal:${string}`;
export type ConnectorToolId = `connector:${string}`;
export type McpToolId = `mcp:${string}`;
export type ToolId = InternalToolId | ConnectorToolId | McpToolId;

export interface ToolCatalogEntry {
  id: ToolId;
  origin: ToolOrigin;
  kind: ToolKind;
  group: ToolGroup;
  title: string;
  description: string;
}

export const INTERNAL_GENERATE_IMAGE = 'internal:generate_image' as const;
export const INTERNAL_GENERATE_VIDEO = 'internal:generate_video' as const;
export const INTERNAL_GENERATE_SPEECH = 'internal:generate_speech' as const;
export const INTERNAL_WEB_SEARCH = 'internal:web_search' as const;
export const INTERNAL_WEB_FETCH = 'internal:web_fetch' as const;
export const INTERNAL_MEMORY = 'internal:memory' as const;
export const INTERNAL_DESIGN_FILES = 'internal:design_files' as const;
export const INTERNAL_LIVE_ARTIFACTS = 'internal:live_artifacts' as const;
export const INTERNAL_WORKSPACE_DATA = 'internal:workspace_data' as const;
export const INTERNAL_SKILLS = 'internal:skills' as const;
export const INTERNAL_PLUGINS = 'internal:plugins' as const;
export const INTERNAL_DESIGN_SYSTEMS = 'internal:design_systems' as const;
export const INTERNAL_RESEARCH = 'internal:research' as const;
export const INTERNAL_PUBLISH = 'internal:publish' as const;
export const INTERNAL_PAGES = 'internal:pages' as const;
export const INTERNAL_TEAM_CHAT = 'internal:team_chat' as const;
export const INTERNAL_MAIL = 'internal:mail' as const;

/** Maps BYOK / chat function names onto catalog ids. */
export const BYOK_TOOL_NAME_TO_ID: Record<string, InternalToolId> = {
  generate_image: INTERNAL_GENERATE_IMAGE,
  generate_video: INTERNAL_GENERATE_VIDEO,
  generate_speech: INTERNAL_GENERATE_SPEECH,
};

export const FEATURED_CONNECTOR_IDS = [
  'github',
  'notion',
  'gmail',
  'google_drive',
  'slack',
  'googlecalendar',
  'googlesheets',
  'outlook',
  'hubspot',
] as const;

export function internalToolId(capability: string): InternalToolId {
  return `internal:${capability}`;
}

export function connectorToolId(connectorId: string): ConnectorToolId {
  return `connector:${connectorId}`;
}

export function mcpToolId(serverId: string): McpToolId {
  return `mcp:${serverId}`;
}

export function isToolEnabled(
  id: string,
  disabledTools?: readonly string[] | null,
): boolean {
  if (!id) return false;
  return !(disabledTools ?? []).includes(id);
}

export function filterEnabledToolIds(
  ids: readonly string[],
  disabledTools?: readonly string[] | null,
): string[] {
  const disabled = new Set(disabledTools ?? []);
  return ids.filter((id) => id.length > 0 && !disabled.has(id));
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: INTERNAL_GENERATE_IMAGE,
    origin: 'internal',
    kind: 'capability',
    group: 'create',
    title: 'Generate images',
    description: 'Create stills, mockups, and illustrations from a prompt.',
  },
  {
    id: INTERNAL_GENERATE_VIDEO,
    origin: 'internal',
    kind: 'capability',
    group: 'create',
    title: 'Generate video',
    description: 'Render short clips and motion from a prompt.',
  },
  {
    id: INTERNAL_GENERATE_SPEECH,
    origin: 'internal',
    kind: 'capability',
    group: 'create',
    title: 'Generate speech',
    description: 'Turn copy into spoken audio.',
  },
  {
    id: INTERNAL_WEB_SEARCH,
    origin: 'internal',
    kind: 'capability',
    group: 'research',
    title: 'Web search',
    description: 'Search the public web for current sources.',
  },
  {
    id: INTERNAL_WEB_FETCH,
    origin: 'internal',
    kind: 'capability',
    group: 'research',
    title: 'Fetch URLs',
    description: 'Read a page or document from a URL.',
  },
  {
    id: INTERNAL_RESEARCH,
    origin: 'internal',
    kind: 'capability',
    group: 'research',
    title: 'Deep research',
    description: 'Run longer research jobs and save notes.',
  },
  {
    id: INTERNAL_MEMORY,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Memory',
    description: 'Read and update durable preferences and facts.',
  },
  {
    id: INTERNAL_DESIGN_FILES,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Design files',
    description: 'Read and edit project files the agent is working on.',
  },
  {
    id: INTERNAL_LIVE_ARTIFACTS,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Live artifacts',
    description: 'Refresh dashboards and other live documents in place.',
  },
  {
    id: INTERNAL_WORKSPACE_DATA,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Workspace data',
    description: 'Query, update, and magic-import organization tables and records.',
  },
  {
    id: INTERNAL_SKILLS,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Skills',
    description: 'Use reusable procedures from the skill library.',
  },
  {
    id: INTERNAL_PLUGINS,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Plugins',
    description: 'Run installed plugins during a task.',
  },
  {
    id: INTERNAL_DESIGN_SYSTEMS,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Design systems',
    description: 'Follow brand tokens, components, and DESIGN.md rules.',
  },
  {
    id: INTERNAL_PAGES,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Pages',
    description: 'Create and edit document pages.',
  },
  {
    id: INTERNAL_TEAM_CHAT,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Team chat',
    description: 'Message a colleague in channels and direct messages.',
  },
  {
    id: INTERNAL_MAIL,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Mail',
    description: 'Read, send, and reply to organization email.',
  },
  {
    id: INTERNAL_PUBLISH,
    origin: 'internal',
    kind: 'capability',
    group: 'workspace',
    title: 'Publish',
    description: 'Publish a project file to a public URL.',
  },
  {
    id: connectorToolId('github'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'GitHub',
    description: 'Repos, issues, pull requests, and commits.',
  },
  {
    id: connectorToolId('notion'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Notion',
    description: 'Search and read pages and databases.',
  },
  {
    id: connectorToolId('gmail'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Gmail',
    description: 'Search, read, and send email.',
  },
  {
    id: connectorToolId('google_drive'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Google Drive',
    description: 'Search and read files in Drive.',
  },
  {
    id: connectorToolId('slack'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Slack',
    description: 'Read channels and send messages.',
  },
  {
    id: connectorToolId('googlecalendar'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Google Calendar',
    description: 'List and create events.',
  },
  {
    id: connectorToolId('googlesheets'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Google Sheets',
    description: 'Read spreadsheets.',
  },
  {
    id: connectorToolId('outlook'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'Outlook',
    description: 'Read Outlook mail.',
  },
  {
    id: connectorToolId('hubspot'),
    origin: 'external',
    kind: 'connector',
    group: 'apps',
    title: 'HubSpot',
    description: 'List contacts and deals.',
  },
];

export function toolCatalogById(): Map<string, ToolCatalogEntry> {
  return new Map(TOOL_CATALOG.map((entry) => [entry.id, entry]));
}

export function catalogToolIds(): ToolId[] {
  return TOOL_CATALOG.map((entry) => entry.id);
}

export function enabledCatalogToolIds(
  disabledTools?: readonly string[] | null,
): ToolId[] {
  return filterEnabledToolIds(catalogToolIds(), disabledTools) as ToolId[];
}
