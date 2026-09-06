import { describe, expect, it } from 'vitest';

import { applyToolAccess, filterByokTools, filterChatToolSurface, isCatalogToolAllowed } from '../src/tool-access.js';
import { CHAT_TOOL_ENDPOINTS, CHAT_TOOL_OPERATIONS } from '../src/tool-tokens.js';

describe('tool access', () => {
  it('drops BYOK media tools the user turned off', () => {
    const tools = [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'generate_video' } },
      { type: 'function', function: { name: 'generate_speech' } },
    ];
    expect(
      filterByokTools(tools, ['internal:generate_video']).map((tool) => tool.function.name),
    ).toEqual(['generate_image', 'generate_speech']);
  });

  it('intersects BYOK tools with a per-run grant list', () => {
    const tools = [
      { function: { name: 'generate_image' } },
      { function: { name: 'generate_speech' } },
    ];
    expect(
      filterByokTools(tools, [], ['internal:generate_image']).map((tool) => tool.function.name),
    ).toEqual(['generate_image']);
  });

  it('strips disabled connectors, MCP servers, and skill/plugin masters from run context', () => {
    const next = applyToolAccess(
      {
        connectorIds: ['github', 'notion'],
        mcpServerIds: ['pollinations', 'linear'],
        skillIds: ['blog-post'],
        pluginIds: ['brand-kit'],
        toolIds: ['internal:memory', 'internal:generate_image'],
      },
      [
        'connector:notion',
        'mcp:linear',
        'internal:skills',
        'internal:plugins',
        'internal:generate_image',
      ],
    );
    expect(next.connectorIds).toEqual(['github']);
    expect(next.mcpServerIds).toEqual(['pollinations']);
    expect(next.skillIds).toEqual([]);
    expect(next.pluginIds).toEqual([]);
    expect(next.toolIds).toEqual(['internal:memory']);
  });

  it('allows a catalog tool unless it is globally off or missing from a grant list', () => {
    expect(isCatalogToolAllowed('internal:team_chat')).toBe(true);
    expect(isCatalogToolAllowed('internal:team_chat', ['internal:team_chat'])).toBe(false);
    expect(isCatalogToolAllowed('internal:mail', [], ['internal:pages'])).toBe(false);
    expect(isCatalogToolAllowed('internal:pages', [], ['internal:pages'])).toBe(true);
  });

  it('strips pages, team, and mail token surface when those tools are off', () => {
    const disabled = filterChatToolSurface(
      CHAT_TOOL_ENDPOINTS,
      CHAT_TOOL_OPERATIONS,
      ['internal:pages', 'internal:team_chat', 'internal:mail'],
    );
    expect(disabled.endpoints.some((endpoint) => endpoint.includes('/pages/'))).toBe(false);
    expect(disabled.endpoints.some((endpoint) => endpoint.includes('/team/'))).toBe(false);
    expect(disabled.endpoints.some((endpoint) => endpoint.includes('/mail/'))).toBe(false);
    expect(disabled.endpoints).toContain('/api/tools/data/query');
    expect(disabled.endpoints).toContain('/api/tools/data/import-url');
    expect(disabled.operations).toContain('data:query');
    expect(disabled.operations).toContain('data:import-url');

    const granted = filterChatToolSurface(
      CHAT_TOOL_ENDPOINTS,
      CHAT_TOOL_OPERATIONS,
      [],
      ['internal:team_chat'],
    );
    expect(granted.endpoints).toContain('/api/tools/team/post');
    expect(granted.operations).toContain('team:post');
    expect(granted.endpoints.some((endpoint) => endpoint.includes('/pages/'))).toBe(false);
    expect(granted.endpoints.some((endpoint) => endpoint.includes('/mail/'))).toBe(false);
    expect(granted.endpoints.some((endpoint) => endpoint.includes('/data/'))).toBe(false);
  });
});
