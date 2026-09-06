// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolsCatalogPanel } from '../../src/components/ToolsCatalogPanel';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/state/mcp', () => ({
  fetchMcpServers: vi.fn(async () => ({ servers: [], templates: [] })),
  saveMcpServers: vi.fn(async () => ({ servers: [], templates: [] })),
}));

afterEach(() => {
  cleanup();
});

describe('ToolsCatalogPanel', () => {
  it('toggles a built-in tool off in preference mode', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ToolsCatalogPanel
          mode="preference"
          disabledTools={[]}
          onDisabledToolsChange={onChange}
        />
      </I18nProvider>,
    );

    const toggle = screen.getByTestId('tool-row-internal:generate_image').querySelector('input');
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    expect(onChange).toHaveBeenCalledWith(['internal:generate_image']);
  });

  it('lists document pages, team chat, and mail as built-in tools', () => {
    render(
      <I18nProvider>
        <ToolsCatalogPanel mode="preference" disabledTools={[]} />
      </I18nProvider>,
    );

    expect(screen.getByTestId('tool-row-internal:pages')).toHaveTextContent('Create and edit document pages');
    expect(screen.getByTestId('tool-row-internal:team_chat')).toHaveTextContent('Message a colleague');
    expect(screen.getByTestId('tool-row-internal:mail')).toHaveTextContent('Read, send, and reply');
  });

  it('hides globally disabled tools from the grant list', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ToolsCatalogPanel
          mode="grant"
          disabledTools={['internal:generate_image']}
          grantedIds={['internal:memory']}
          onGrantedIdsChange={onChange}
        />
      </I18nProvider>,
    );

    const imageToggle = screen.getByTestId('tool-row-internal:generate_image').querySelector('input');
    expect(imageToggle).toBeDisabled();
    const memoryToggle = screen.getByTestId('tool-row-internal:memory').querySelector('input');
    expect(memoryToggle).toBeChecked();
  });
});
