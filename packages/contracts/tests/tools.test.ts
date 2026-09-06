import { describe, expect, it } from 'vitest';

import {
  BYOK_TOOL_NAME_TO_ID,
  TOOL_CATALOG,
  catalogToolIds,
  connectorToolId,
  enabledCatalogToolIds,
  filterEnabledToolIds,
  isToolEnabled,
  mcpToolId,
} from '../src/api/tools.js';

describe('tool catalog', () => {
  it('uses unique ids and splits internal from external tools', () => {
    const ids = catalogToolIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOOL_CATALOG.some((entry) => entry.origin === 'internal')).toBe(true);
    expect(TOOL_CATALOG.some((entry) => entry.origin === 'external')).toBe(true);
    expect(TOOL_CATALOG.filter((entry) => entry.kind === 'connector').map((entry) => entry.id)).toContain(
      connectorToolId('github'),
    );
  });

  it('treats missing disabledTools as everything on', () => {
    expect(isToolEnabled('internal:generate_image')).toBe(true);
    expect(isToolEnabled('internal:generate_image', [])).toBe(true);
    expect(isToolEnabled('internal:generate_image', ['internal:generate_video'])).toBe(true);
    expect(isToolEnabled('internal:generate_image', ['internal:generate_image'])).toBe(false);
  });

  it('filters granted ids against the global disabled list', () => {
    expect(
      filterEnabledToolIds(
        ['internal:memory', 'connector:github', 'mcp:pollinations'],
        ['connector:github'],
      ),
    ).toEqual(['internal:memory', 'mcp:pollinations']);
    expect(enabledCatalogToolIds(['internal:publish'])).not.toContain('internal:publish');
    expect(mcpToolId('linear')).toBe('mcp:linear');
  });

  it('includes pages, team chat, and mail as built-in workspace tools', () => {
    expect(catalogToolIds()).toContain('internal:pages');
    expect(catalogToolIds()).toContain('internal:team_chat');
    expect(catalogToolIds()).toContain('internal:mail');
  });

  it('maps BYOK function names onto catalog ids', () => {
    expect(BYOK_TOOL_NAME_TO_ID.generate_image).toBe('internal:generate_image');
    expect(BYOK_TOOL_NAME_TO_ID.generate_video).toBe('internal:generate_video');
    expect(BYOK_TOOL_NAME_TO_ID.generate_speech).toBe('internal:generate_speech');
  });
});
