import { useEffect, useMemo, useState } from 'react';
import {
  TOOL_CATALOG,
  isToolEnabled,
  mcpToolId,
  type McpServerConfig,
  type ToolCatalogEntry,
  type ToolId,
} from '@open-design/contracts';

import { Icon, type IconName } from './Icon';
import { fetchMcpServers, saveMcpServers } from '../state/mcp';
import { useT } from '../i18n';
import styles from './ToolsCatalogPanel.module.css';

export type ToolsCatalogMode = 'preference' | 'grant';

type Props = {
  disabledTools?: string[] | null;
  onDisabledToolsChange?: (next: string[]) => void;
  grantedIds?: string[];
  onGrantedIdsChange?: (next: string[]) => void;
  mode?: ToolsCatalogMode;
  compact?: boolean;
  mcpServers?: McpServerConfig[];
};

const TOOL_ICONS: Record<string, IconName> = {
  'internal:generate_image': 'image',
  'internal:generate_video': 'play',
  'internal:generate_speech': 'mic',
  'internal:web_search': 'search',
  'internal:web_fetch': 'globe',
  'internal:research': 'lightbulb',
  'internal:memory': 'history',
  'internal:design_files': 'file',
  'internal:live_artifacts': 'file-code',
  'internal:workspace_data': 'layout',
  'internal:skills': 'sparkles',
  'internal:plugins': 'puzzle',
  'internal:design_systems': 'palette',
  'internal:pages': 'file-text',
  'internal:team_chat': 'message-circle',
  'internal:mail': 'mail',
  'internal:publish': 'globe',
  'connector:github': 'github',
  'connector:notion': 'file-text',
  'connector:gmail': 'mail',
  'connector:google_drive': 'folder',
  'connector:slack': 'hash',
  'connector:googlecalendar': 'history',
  'connector:googlesheets': 'layout',
  'connector:outlook': 'mail',
  'connector:hubspot': 'orbit',
};

function iconFor(id: string): IconName {
  return TOOL_ICONS[id] ?? 'sparkles';
}

export function ToolsCatalogPanel({
  disabledTools,
  onDisabledToolsChange,
  grantedIds,
  onGrantedIdsChange,
  mode = 'preference',
  compact = false,
  mcpServers: mcpServersProp,
}: Props) {
  const t = useT();
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(mcpServersProp ?? []);

  useEffect(() => {
    if (mcpServersProp) {
      setMcpServers(mcpServersProp);
      return;
    }
    let canceled = false;
    void fetchMcpServers().then((result) => {
      if (canceled) return;
      setMcpServers(result?.servers ?? []);
    });
    return () => {
      canceled = true;
    };
  }, [mcpServersProp]);

  const disabled = disabledTools ?? [];
  const internal = useMemo(
    () => TOOL_CATALOG.filter((entry) => entry.origin === 'internal'),
    [],
  );
  const connectors = useMemo(
    () => TOOL_CATALOG.filter((entry) => entry.kind === 'connector'),
    [],
  );
  const mcpEntries = useMemo(
    () =>
      mcpServers.map((server) => ({
        id: mcpToolId(server.id),
        origin: 'external' as const,
        kind: 'mcp' as const,
        group: 'apps' as const,
        title: server.label?.trim() || server.id,
        description: server.url || server.command || server.transport,
        server,
      })),
    [mcpServers],
  );

  const allIds = useMemo(
    () => [...internal, ...connectors, ...mcpEntries].map((entry) => entry.id),
    [connectors, internal, mcpEntries],
  );

  function isOn(id: string): boolean {
    if (mode === 'grant') {
      return isToolEnabled(id, disabled) && (grantedIds ?? []).includes(id);
    }
    if (id.startsWith('mcp:')) {
      const serverId = id.slice('mcp:'.length);
      const server = mcpServers.find((item) => item.id === serverId);
      if (server && server.enabled === false) return false;
    }
    return isToolEnabled(id, disabled);
  }

  function setOn(id: string, nextOn: boolean) {
    if (mode === 'grant') {
      if (!isToolEnabled(id, disabled)) return;
      const set = new Set(grantedIds ?? []);
      if (nextOn) set.add(id);
      else set.delete(id);
      onGrantedIdsChange?.([...set]);
      return;
    }
    const set = new Set(disabled);
    if (nextOn) set.delete(id);
    else set.add(id);
    onDisabledToolsChange?.([...set]);
    if (id.startsWith('mcp:')) {
      const serverId = id.slice('mcp:'.length);
      const nextServers = mcpServers.map((server) =>
        server.id === serverId ? { ...server, enabled: nextOn } : server,
      );
      setMcpServers(nextServers);
      void saveMcpServers(nextServers);
    }
  }

  function setAll(nextOn: boolean) {
    if (mode === 'grant') {
      const allowed = allIds.filter((id) => isToolEnabled(id, disabled));
      onGrantedIdsChange?.(nextOn ? allowed : []);
      return;
    }
    onDisabledToolsChange?.(nextOn ? [] : [...allIds]);
    if (mcpServers.length > 0) {
      const nextServers = mcpServers.map((server) => ({ ...server, enabled: nextOn }));
      setMcpServers(nextServers);
      void saveMcpServers(nextServers);
    }
  }

  return (
    <div
      className={`${styles.panel}${compact ? ` ${styles.compact}` : ''}`}
      data-testid="tools-catalog"
    >
      <div className={styles.toolbar}>
        <button type="button" className={styles.textBtn} onClick={() => setAll(true)}>
          {t('settings.toolsEnableAll')}
        </button>
        <button type="button" className={styles.textBtn} onClick={() => setAll(false)}>
          {t('settings.toolsDisableAll')}
        </button>
      </div>
      <ToolGroup
        heading={t('settings.toolsInternalHeading')}
        entries={internal}
        isOn={isOn}
        setOn={setOn}
        locked={mode === 'grant' ? (id) => !isToolEnabled(id, disabled) : undefined}
      />
      <ToolGroup
        heading={t('settings.toolsExternalHeading')}
        entries={connectors}
        isOn={isOn}
        setOn={setOn}
        locked={mode === 'grant' ? (id) => !isToolEnabled(id, disabled) : undefined}
      />
      {mcpEntries.length > 0 ? (
        <ToolGroup
          heading={t('settings.toolsMcpHeading')}
          entries={mcpEntries}
          isOn={isOn}
          setOn={setOn}
          locked={mode === 'grant' ? (id) => !isToolEnabled(id, disabled) : undefined}
        />
      ) : null}
    </div>
  );
}

function ToolGroup({
  heading,
  entries,
  isOn,
  setOn,
  locked,
}: {
  heading: string;
  entries: Array<ToolCatalogEntry | (ToolCatalogEntry & { server?: McpServerConfig })>;
  isOn: (id: string) => boolean;
  setOn: (id: string, nextOn: boolean) => void;
  locked?: (id: string) => boolean;
}) {
  const t = useT();
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{heading}</h3>
      <ul className={styles.list}>
        {entries.map((entry) => {
          const on = isOn(entry.id);
          const isLocked = locked?.(entry.id) === true;
          return (
            <li key={entry.id}>
              <label
                className={`${styles.row}${on ? ` ${styles.on}` : ''}${isLocked ? ` ${styles.locked}` : ''}`}
                data-testid={`tool-row-${entry.id}`}
              >
                <span className={styles.icon} aria-hidden>
                  <Icon name={iconFor(entry.id)} size={15} />
                </span>
                <span className={styles.copy}>
                  <strong>{entry.title}</strong>
                  <small>{entry.description}</small>
                </span>
                <span className="toggle-switch toggle-switch-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={isLocked}
                    onChange={(event) => setOn(entry.id, event.target.checked)}
                    aria-label={t('tools.toggleAria', { name: entry.title })}
                  />
                  <span className="toggle-slider" />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function countEnabledTools(
  disabledTools?: string[] | null,
  extraIds: readonly string[] = [],
): number {
  const disabled = new Set(disabledTools ?? []);
  const ids = new Set<string>([...TOOL_CATALOG.map((entry) => entry.id), ...extraIds]);
  let count = 0;
  for (const id of ids) {
    if (!disabled.has(id)) count += 1;
  }
  return count;
}

export function defaultGrantedToolIds(
  disabledTools?: string[] | null,
  mcpServers: McpServerConfig[] = [],
): ToolId[] {
  const ids = [
    ...TOOL_CATALOG.map((entry) => entry.id),
    ...mcpServers.filter((server) => server.enabled).map((server) => mcpToolId(server.id)),
  ];
  return ids.filter((id) => isToolEnabled(id, disabledTools));
}
