// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { I18nProvider } from '../../src/i18n';
import { flushMounts } from '../helpers/lexical-composer';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [], templates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/plugins')) {
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/connectors')) {
      return new Response(JSON.stringify({ connectors: [], statuses: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/skills')) {
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ChatComposer page context', () => {
  it('shows a building-on chip for the wiki page this project was launched from', async () => {
    render(
      <I18nProvider initial="en">
        <ChatComposer
          projectId="project-1"
          projectFiles={[]}
          streaming={false}
          onEnsureProject={async () => 'project-1'}
          onSend={vi.fn()}
          onStop={vi.fn()}
          projectMetadata={{
            kind: 'other',
            pageContext: { pageId: 'page-1', title: 'Handbook', icon: '📘' },
          }}
        />
      </I18nProvider>,
    );
    await flushMounts();
    const chip = screen.getByTestId('composer-page-context');
    expect(chip.textContent).toContain('Building on');
    expect(chip.textContent).toContain('Handbook');
  });
});
