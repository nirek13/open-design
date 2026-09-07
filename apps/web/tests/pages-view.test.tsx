// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="pages-agent-chat" />,
}));

const { chatSend } = vi.hoisted(() => ({ chatSend: vi.fn() }));

vi.mock('../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [],
    streaming: false,
    error: null,
    loading: false,
    onSend: chatSend,
    onRetry: vi.fn(),
    onStop: vi.fn(),
  }),
}));

import { applyMarkdownShortcut, BlockEditor, emptyBlock, type DraftBlock } from '../src/components/pages/BlockEditor';
import { PagesView, pickNewlyCreatedPage } from '../src/components/pages/PagesView';
import { composePagesWikiPrompt } from '../src/components/pages/wiki-prompt';
import * as createdEmbed from '../src/runtime/created-embed';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';
import * as projects from '../src/state/projects';
import type { WorkspacePageDetail } from '@open-design/contracts';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

function pageDetail(overrides: Partial<WorkspacePageDetail> = {}): WorkspacePageDetail {
  return {
    id: 'page-1',
    orgId: 'ws-1',
    parentPageId: null,
    title: 'Handbook',
    icon: '📘',
    cover: null,
    linkedRecordId: null,
    linkedTableId: null,
    style: {},
    position: 0,
    createdBy: 'wsm-1',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    blocks: [
      {
        id: 'b1',
        pageId: 'page-1',
        parentBlockId: null,
        type: 'paragraph',
        content: 'Welcome',
        props: {},
        position: 0,
        children: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
  };
}

function renderPages() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <PagesView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('applyMarkdownShortcut', () => {
  it('turns markdown prefixes into Notion block types', () => {
    expect(applyMarkdownShortcut('# ')).toEqual({ type: 'heading_1', text: '' });
    expect(applyMarkdownShortcut('## ')).toEqual({ type: 'heading_2', text: '' });
    expect(applyMarkdownShortcut('- ')).toEqual({ type: 'bulleted_list_item', text: '' });
    expect(applyMarkdownShortcut('1. ')).toEqual({ type: 'numbered_list_item', text: '' });
    expect(applyMarkdownShortcut('[] ')).toEqual({ type: 'to_do', text: '' });
    expect(applyMarkdownShortcut('> ')).toEqual({ type: 'quote', text: '' });
    expect(applyMarkdownShortcut('```')).toEqual({ type: 'code', text: '' });
    expect(applyMarkdownShortcut('---')).toEqual({ type: 'divider', text: '' });
    expect(applyMarkdownShortcut('$$ ')).toEqual({ type: 'equation', text: '' });
    expect(applyMarkdownShortcut('hello')).toBeNull();
  });
});

describe('composePagesWikiPrompt', () => {
  it('asks the agent to use tools pages and keep the current page in scope', () => {
    const prompt = composePagesWikiPrompt({
      request: 'Employee handbook',
      pageId: 'page-1',
      pageTitle: 'Handbook',
    });
    expect(prompt).toContain('tools pages');
    expect(prompt).toContain('Employee handbook');
    expect(prompt).toContain('page-1');
    expect(prompt).toContain('Handbook');
    expect(prompt).toContain('type embed');
    expect(prompt).toContain('$OD_PROJECT_ID');
    expect(prompt).toContain('board');
    expect(prompt).toContain('assigner');
    expect(prompt).toContain('Native tools first');
    expect(prompt).toContain('Do not generate HTML/JS');
    expect(prompt).toContain('notes tab bar');
    expect(prompt).toContain('Do not edit other existing pages');
    expect(prompt).toContain('active tab');
    expect(prompt).toContain('"$OD_NODE_BIN" "$OD_BIN" tools pages append');
    expect(prompt).toContain('Writing a JSON payload to a file is not done');
    expect(prompt).toContain('content.items');
  });

  it('lists pages already open in the notes tab bar', () => {
    const prompt = composePagesWikiPrompt({
      request: 'Add hiring steps',
      pageId: 'page-1',
      pageTitle: 'Handbook',
      openTabs: [
        { id: 'page-1', title: 'Handbook', icon: '📘' },
        { id: 'page-2', title: 'Hiring', icon: '🤝' },
      ],
    });
    expect(prompt).toContain('Notes tab bar');
    expect(prompt).toContain('page-2');
    expect(prompt).toContain('Hiring');
  });

  it('prefers native page tools when making an app from a page, with embed as fallback', () => {
    const prompt = composePagesWikiPrompt({
      request: 'A hiring dashboard',
      pageId: 'page-1',
      pageTitle: 'Handbook',
      make: { kind: 'app', prompt: 'A hiring dashboard' },
    });
    expect(prompt).toContain('native wiki tool');
    expect(prompt).toContain('Do not generate HTML and embed it when a native tool covers the request');
    expect(prompt).toContain('A hiring dashboard');
    expect(prompt).toContain('unique interactive app');
    expect(prompt).toContain('tools pages embed');
    expect(prompt).toContain('/raw/');
    expect(prompt).toContain('chart');
  });

  it('includes the page excerpt when provided', () => {
    const prompt = composePagesWikiPrompt({
      request: 'Expand this',
      pageId: 'page-1',
      pageTitle: 'Handbook',
      pageIcon: '📘',
      pageExcerpt: 'Welcome to the team',
    });
    expect(prompt).toContain('📘');
    expect(prompt).toContain('Welcome to the team');
  });

  it('names the chat project so embed URLs are not placeholders', () => {
    const prompt = composePagesWikiPrompt({
      request: 'Embed a picture',
      pageId: 'page-1',
      pageTitle: 'Handbook',
      projectId: 'proj-wiki',
    });
    expect(prompt).toContain('proj-wiki');
    expect(prompt).toContain('/api/projects/proj-wiki/raw/');
    expect(prompt).not.toContain('<this project id>');
  });
});

describe('PagesView', () => {
  beforeEach(() => {
    chatSend.mockReset();
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null, bio: null, avatarUrl: null },
      organizations: [ORG],
    });
    const detail = pageDetail();
    vi.spyOn(registry, 'fetchPageTree').mockResolvedValue([
      { page: detail, children: [] },
    ]);
    vi.spyOn(registry, 'fetchWorkspacePage').mockResolvedValue(detail);
    vi.spyOn(registry, 'updateWorkspacePage').mockResolvedValue(detail);
    vi.spyOn(registry, 'setWorkspacePageBlocks').mockResolvedValue(detail);
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([]);
    vi.spyOn(registry, 'embedInWorkspacePage').mockResolvedValue(detail);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not show the marketing pages header', async () => {
    renderPages();
    expect(await screen.findByTestId('pages-view')).toBeTruthy();
    expect(screen.queryByText(/Notion-style notes for your organization/i)).toBeNull();
    expect(screen.getByTestId('pages-sidebar')).toBeTruthy();
    expect(await screen.findByDisplayValue('Handbook')).toBeTruthy();
    expect(screen.getByTestId('pages-ask-ai')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask AI' })).toBeTruthy();
    expect(screen.getByTestId('pages-tab-bar')).toBeTruthy();
    expect(screen.getByTestId('pages-tab-page-1').textContent).toContain('Handbook');
    expect(screen.getByTestId('page-context-chip').textContent).toContain('Handbook');
    expect(screen.getByTestId('page-context-chip').textContent).toContain('Building on');
  });

  it('keeps opened notes in a tab bar and tells Ask AI about those tabs', async () => {
    const handbook = pageDetail();
    const hiring = pageDetail({
      id: 'page-2',
      title: 'Hiring',
      icon: '🤝',
      parentPageId: null,
      blocks: [
        {
          id: 'h1',
          pageId: 'page-2',
          parentBlockId: null,
          type: 'paragraph',
          content: 'Roles',
          props: {},
          position: 0,
          children: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    vi.spyOn(registry, 'fetchPageTree').mockResolvedValue([
      { page: handbook, children: [] },
      { page: hiring, children: [] },
    ]);
    vi.spyOn(registry, 'fetchWorkspacePage').mockImplementation(async (_org, pageId) =>
      pageId === 'page-2' ? hiring : handbook,
    );
    const create = vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-tabs',
        name: 'Hiring: Add steps',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-tabs',
    });
    renderPages();
    expect(await screen.findByTestId('pages-tab-page-1')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('pages-sidebar')).getByText('Hiring'));
    expect(await screen.findByTestId('pages-tab-page-2')).toBeTruthy();
    expect(screen.getByTestId('pages-tab-page-1')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Add hiring steps' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const prompt = String(create.mock.calls[0]?.[0]?.pendingPrompt ?? '');
    expect(prompt).toContain('notes tab bar');
    expect(prompt).toContain('page-1');
    expect(prompt).toContain('page-2');
    fireEvent.click(
      within(screen.getByTestId('pages-tab-page-1')).getByRole('button', { name: 'Close tab' }),
    );
    await waitFor(() => expect(screen.queryByTestId('pages-tab-page-1')).toBeNull());
    expect(screen.getByTestId('pages-tab-page-2')).toBeTruthy();
  });

  it('adds a cover and favorites the open page', async () => {
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add cover' }));
    expect(screen.getByTestId('pages-cover-picker')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('g0'));
    expect(screen.getByTestId('pages-cover')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(screen.getByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
    expect(screen.getByText('Favorites')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize page' }));
    expect(screen.getByTestId('pages-customize')).toBeTruthy();
    expect(screen.getByText('Full width')).toBeTruthy();
  });

  it('opens a send picker so the page can go to a teammate', async () => {
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchOrgTeams').mockResolvedValue([]);
    vi.spyOn(registry, 'fetchChatChannels').mockResolvedValue({ channels: [], totalUnread: 0 });
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByTestId('pages-send'));
    expect(await screen.findByTestId('pages-send-panel')).toBeTruthy();
    expect(screen.getByTestId('send-page-picker')).toBeTruthy();
  });

  it('launches the agent from the sidebar with the open page as context', async () => {
    const create = vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-1',
        name: 'Handbook: Add onboarding',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-1',
    });
    renderPages();
    expect(await screen.findByTestId('page-context-chip')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Add an onboarding section' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const arg = create.mock.calls[0]?.[0];
    expect(arg?.metadata?.pageContext).toEqual({
      pageId: 'page-1',
      title: 'Handbook',
      icon: '📘',
    });
    expect(arg?.metadata?.workspaceId).toBe('ws-1');
    expect(arg?.pendingPrompt).toContain('page-1');
    expect(arg?.pendingPrompt).toContain('$OD_PROJECT_ID');
    expect(arg?.pendingPrompt).toContain('Welcome');
    expect(arg?.pendingPrompt).toContain('Add an onboarding section');
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    await waitFor(() => expect(chatSend).toHaveBeenCalled());
    expect(String(chatSend.mock.calls[0]?.[0])).toContain('proj-1');
    expect(String(chatSend.mock.calls[0]?.[0])).toContain('/api/projects/proj-1/raw/');
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('docked');
    expect(screen.getByTestId('pages-title')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pages-agent-expand'));
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('expanded');
    fireEvent.click(screen.getByTestId('pages-agent-dock'));
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('docked');
    fireEvent.click(screen.getByTestId('pages-agent-close'));
    expect(screen.getByTestId('pages-ask-ai')).toBeTruthy();
  });

  it('does not rewrite page blocks when only the title changes', async () => {
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pages-title'), { target: { value: 'Renamed handbook' } });
    await waitFor(() => expect(registry.updateWorkspacePage).toHaveBeenCalled(), { timeout: 2000 });
    expect(registry.setWorkspacePageBlocks).not.toHaveBeenCalled();
  });

  it('reloads the open page so an agent embed appears without a manual refresh', async () => {
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-embed',
        name: 'Handbook: Embed picture',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-embed',
    });
    let loads = 0;
    vi.spyOn(registry, 'fetchWorkspacePage').mockImplementation(async () => {
      loads += 1;
      if (loads === 1) return pageDetail();
      return pageDetail({
        updatedAt: 99,
        blocks: [
          ...pageDetail().blocks,
          {
            id: 'emb-1',
            pageId: 'page-1',
            parentBlockId: null,
            type: 'embed',
            content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            props: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
            position: 1,
            children: [],
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      });
    });
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Embed a walkthrough' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
  });

  it('embeds a chart from the chat project onto the open notes page', async () => {
    const chartUrl = '/api/projects/proj-chart/raw/revenue-chart.html';
    const withChart = pageDetail({
      updatedAt: 50,
      blocks: [
        ...pageDetail().blocks,
        {
          id: 'emb-chart',
          pageId: 'page-1',
          parentBlockId: null,
          type: 'embed',
          content: chartUrl,
          props: { url: chartUrl },
          position: 1,
          children: [],
          createdAt: 50,
          updatedAt: 50,
        },
      ],
    });
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-chart',
        name: 'Handbook: Revenue chart',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-chart',
    });
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([
      {
        name: 'revenue-chart.html',
        path: 'revenue-chart.html',
        type: 'file',
        size: 2048,
        mtime: 2,
        kind: 'html',
        mime: 'text/html',
      },
    ]);
    const embed = vi.spyOn(registry, 'embedInWorkspacePage').mockResolvedValue(withChart);
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Make a revenue chart' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    await waitFor(() => expect(embed).toHaveBeenCalled());
    expect(embed).toHaveBeenCalledWith('ws-1', 'page-1', { type: 'embed', url: chartUrl });
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
  });

  it('retries embedding a chart if the first attach fails', async () => {
    const chartUrl = '/api/projects/proj-chart/raw/revenue-chart.html';
    const withChart = pageDetail({
      updatedAt: 50,
      blocks: [
        ...pageDetail().blocks,
        {
          id: 'emb-chart',
          pageId: 'page-1',
          parentBlockId: null,
          type: 'embed',
          content: chartUrl,
          props: { url: chartUrl },
          position: 1,
          children: [],
          createdAt: 50,
          updatedAt: 50,
        },
      ],
    });
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-chart',
        name: 'Handbook: Revenue chart',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-chart',
    });
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([
      {
        name: 'revenue-chart.html',
        path: 'revenue-chart.html',
        type: 'file',
        size: 2048,
        mtime: 2,
        kind: 'html',
        mime: 'text/html',
      },
    ]);
    const embed = vi
      .spyOn(registry, 'embedInWorkspacePage')
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(withChart);
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Make a revenue chart' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    await waitFor(() => expect(embed.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3500 });
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
  });

  it('keeps the chart on the notes page after a title autosave', async () => {
    const chartUrl = '/api/projects/proj-chart/raw/revenue-chart.html';
    const withChart = pageDetail({
      updatedAt: 50,
      blocks: [
        ...pageDetail().blocks,
        {
          id: 'emb-chart',
          pageId: 'page-1',
          parentBlockId: null,
          type: 'embed',
          content: chartUrl,
          props: { url: chartUrl },
          position: 1,
          children: [],
          createdAt: 50,
          updatedAt: 50,
        },
      ],
    });
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-chart',
        name: 'Handbook: Revenue chart',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-chart',
    });
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([
      {
        name: 'revenue-chart.html',
        path: 'revenue-chart.html',
        type: 'file',
        size: 2048,
        mtime: 2,
        kind: 'html',
        mime: 'text/html',
      },
    ]);
    vi.spyOn(registry, 'embedInWorkspacePage').mockResolvedValue(withChart);
    vi.spyOn(registry, 'updateWorkspacePage').mockImplementation(async (_org, _id, input) =>
      pageDetail({
        ...withChart,
        title: String(input.title ?? withChart.title),
        updatedAt: 60,
      }),
    );
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Make a revenue chart' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pages-title'), { target: { value: 'Handbook with chart' } });
    await waitFor(() => expect(registry.updateWorkspacePage).toHaveBeenCalled(), { timeout: 2000 });
    expect(screen.getByTestId('pages-rich-embed')).toBeTruthy();
    for (const call of (registry.setWorkspacePageBlocks as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(JSON.stringify(call[2])).toContain('revenue-chart.html');
    }
  });

  it('embeds a chart that appears after Ask AI has already started', async () => {
    const chartUrl = '/api/projects/proj-chart/raw/charts/revenue.html';
    const withChart = pageDetail({
      updatedAt: 50,
      blocks: [
        ...pageDetail().blocks,
        {
          id: 'emb-chart',
          pageId: 'page-1',
          parentBlockId: null,
          type: 'embed',
          content: chartUrl,
          props: { url: chartUrl },
          position: 1,
          children: [],
          createdAt: 50,
          updatedAt: 50,
        },
      ],
    });
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-chart',
        name: 'Handbook: Revenue chart',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-chart-late',
    });
    let files: Array<{
      name: string;
      path: string;
      type: 'file';
      size: number;
      mtime: number;
      kind: 'html';
      mime: string;
    }> = [];
    vi.spyOn(registry, 'fetchProjectFiles').mockImplementation(async () => files);
    const embed = vi.spyOn(registry, 'embedInWorkspacePage').mockResolvedValue(withChart);
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Make a revenue chart' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(embed).not.toHaveBeenCalled();
    files = [
      {
        name: 'charts/revenue.html',
        path: 'charts/revenue.html',
        type: 'file',
        size: 2048,
        mtime: 2,
        kind: 'html',
        mime: 'text/html',
      },
    ];
    await waitFor(() => expect(embed).toHaveBeenCalled(), { timeout: 3500 });
    expect(embed).toHaveBeenCalledWith('ws-1', 'page-1', { type: 'embed', url: chartUrl });
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
  });

  it('keeps the chart on the notes page after a body autosave', async () => {
    const chartUrl = '/api/projects/proj-chart/raw/revenue-chart.html';
    const withChart = pageDetail({
      updatedAt: 50,
      blocks: [
        ...pageDetail().blocks,
        {
          id: 'emb-chart',
          pageId: 'page-1',
          parentBlockId: null,
          type: 'embed',
          content: chartUrl,
          props: { url: chartUrl },
          position: 1,
          children: [],
          createdAt: 50,
          updatedAt: 50,
        },
      ],
    });
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: {
        id: 'proj-chart',
        name: 'Handbook: Revenue chart',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conv-chart-body',
    });
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([
      {
        name: 'revenue-chart.html',
        path: 'revenue-chart.html',
        type: 'file',
        size: 2048,
        mtime: 2,
        kind: 'html',
        mime: 'text/html',
      },
    ]);
    vi.spyOn(registry, 'embedInWorkspacePage').mockResolvedValue(withChart);
    vi.spyOn(registry, 'setWorkspacePageBlocks').mockImplementation(async (_org, _id, input) =>
      pageDetail({
        ...withChart,
        updatedAt: 90,
        blocks: (input.blocks ?? []).map((block, index) => ({
          id: `b${index}`,
          pageId: 'page-1',
          parentBlockId: null,
          type: block.type,
          content: block.content ?? '',
          props: block.props ?? {},
          position: index,
          children: [],
          createdAt: 90,
          updatedAt: 90,
        })),
      } as WorkspacePageDetail),
    );
    renderPages();
    expect(await screen.findByTestId('pages-title')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Make a revenue chart' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-rich-embed')).toBeTruthy();
    const editor = within(screen.getByTestId('pages-editor')).getByRole('textbox');
    fireEvent.focus(editor);
    fireEvent.input(editor, { target: { textContent: 'Welcome — see the chart' } });
    await waitFor(() => expect(registry.setWorkspacePageBlocks).toHaveBeenCalled(), { timeout: 2000 });
    expect(screen.getByTestId('pages-rich-embed')).toBeTruthy();
    const last = (registry.setWorkspacePageBlocks as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.at(-1);
    expect(JSON.stringify(last?.[2])).toContain('revenue-chart.html');
  });

  it('opens a newly created notes page when the open page did not change', async () => {
    const handbook = pageDetail();
    const created = pageDetail({
      id: 'page-new',
      title: 'Hiring wiki',
      updatedAt: 5,
      parentPageId: 'page-1',
      blocks: [
        {
          id: 'n1',
          pageId: 'page-new',
          parentBlockId: null,
          type: 'paragraph',
          content: 'Roles',
          props: {},
          position: 0,
          children: [],
          createdAt: 5,
          updatedAt: 5,
        },
      ],
    });
    let includeCreated = false;
    vi.spyOn(registry, 'fetchPageTree').mockImplementation(async () =>
      includeCreated
        ? [{ page: handbook, children: [{ page: created, children: [] }] }]
        : [{ page: handbook, children: [] }],
    );
    vi.spyOn(registry, 'fetchWorkspacePage').mockImplementation(async (_org, pageId) =>
      pageId === 'page-new' ? created : handbook,
    );
    vi.spyOn(projects, 'createProject').mockImplementation(async () => {
      includeCreated = true;
      return {
        project: {
          id: 'proj-new-page',
          name: 'Handbook: Hiring wiki',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
        },
        conversationId: 'conv-new-page',
      };
    });
    renderPages();
    expect(await screen.findByDisplayValue('Handbook')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), {
      target: { value: 'Create a hiring wiki' },
    });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    expect(await screen.findByDisplayValue('Hiring wiki')).toBeTruthy();
    expect(screen.getByTestId('pages-tab-page-new').textContent).toContain('Hiring wiki');
    expect(screen.getByTestId('pages-tab-page-1')).toBeTruthy();
  });
});

describe('pickNewlyCreatedPage', () => {
  it('prefers a new child of the open page, else a new root', () => {
    expect(
      pickNewlyCreatedPage(
        [
          { id: 'other', parentPageId: 'elsewhere' },
          { id: 'child', parentPageId: 'page-1' },
        ],
        'page-1',
      ),
    ).toBe('child');
    expect(
      pickNewlyCreatedPage(
        [
          { id: 'nested', parentPageId: 'x' },
          { id: 'root', parentPageId: null },
        ],
        'page-1',
      ),
    ).toBe('root');
    expect(pickNewlyCreatedPage([], 'page-1')).toBeNull();
  });
});

describe('BlockEditor', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens the slash menu when typing /', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.focus(textbox);
    fireEvent.input(textbox, { target: { textContent: '/' } });
    expect(screen.getByTestId('pages-slash')).toBeTruthy();
    expect(screen.getByText('Heading 1')).toBeTruthy();
    expect(screen.getByText('Embed')).toBeTruthy();
    expect(screen.getByText('Make app')).toBeTruthy();
    expect(screen.getByText('Make picture')).toBeTruthy();
    expect(screen.getByText('Make video')).toBeTruthy();
    expect(screen.getByText('Make slides')).toBeTruthy();
    expect(screen.getByText('Image')).toBeTruthy();
    expect(screen.getByText('Block equation')).toBeTruthy();
    expect(screen.getByText('Table of contents')).toBeTruthy();
    expect(screen.getByText('2 columns')).toBeTruthy();
    expect(screen.getByText('Toggle heading 1')).toBeTruthy();
    expect(screen.getByText('Board')).toBeTruthy();
    expect(screen.getByText('To-do list')).toBeTruthy();
    expect(screen.getByText('Task assigner')).toBeTruthy();
    expect(screen.getByText('Poll')).toBeTruthy();
    expect(screen.getByText('Timeline')).toBeTruthy();
    expect(screen.getByText('Decision')).toBeTruthy();
    expect(screen.getByText('Goals')).toBeTruthy();
  });

  it('turns a pasted URL on an empty paragraph into a live embed', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.paste(textbox, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'https://youtu.be/dQw4w9WgXcQ' : ''),
      },
    });
    expect(screen.getByTestId('pages-rich-embed')).toHaveAttribute('data-provider', 'YouTube');
  });

  it('lets you embed a created app, picture, video, or slides from the picker', async () => {
    vi.spyOn(createdEmbed, 'loadCreatedEmbedItems').mockResolvedValue([
      {
        id: 'app:1',
        kind: 'app',
        title: 'Expense form',
        subtitle: 'expense-form.html',
        url: '/api/projects/p1/raw/expense-form.html',
      },
      {
        id: 'file:hero',
        kind: 'image',
        title: 'Hero',
        subtitle: 'Campaign',
        url: '/api/projects/p1/raw/hero.png',
      },
      {
        id: 'file:clip',
        kind: 'video',
        title: 'Walkthrough',
        subtitle: 'Campaign',
        url: '/api/projects/p1/raw/walkthrough.mp4',
      },
      {
        id: 'file:deck',
        kind: 'slides',
        title: 'Pitch deck',
        subtitle: 'Campaign',
        url: '/api/projects/p1/raw/pitch-deck.html',
      },
    ]);

    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock('embed')]);
      return <BlockEditor orgId="org-1" blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);

    expect(await screen.findByTestId('pages-created-picker')).toBeTruthy();
    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getByText('Pictures')).toBeTruthy();
    expect(screen.getByText('Videos')).toBeTruthy();
    expect(screen.getByText('Slides')).toBeTruthy();
    expect(screen.getByText('Hero')).toBeTruthy();
    expect(screen.getByText('Walkthrough')).toBeTruthy();
    expect(screen.getByText('Pitch deck')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Expense form/ }));
    expect(screen.getByTestId('pages-rich-embed')).toHaveAttribute('data-provider', 'App');
    const frame = screen.getByTitle('expense-form.html');
    expect(frame.getAttribute('data-preview-src')).toBe('/api/projects/p1/raw/expense-form.html');
    expect(frame.getAttribute('src')).toBeFalsy();
  });

  it('lets you make a unique app from the slash menu', () => {
    const onMake = vi.fn();
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} onMake={onMake} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.focus(textbox);
    fireEvent.input(textbox, { target: { textContent: '/' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Make app/ }));
    expect(screen.getByTestId('pages-make-composer')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /unique interactive app/i }), {
      target: { value: 'A hiring tracker for this team' },
    });
    fireEvent.submit(screen.getByTestId('pages-make-composer'));
    expect(onMake).toHaveBeenCalledWith('app', 'A hiring tracker for this team');
  });

  it('inserts a table of contents that lists headings', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([
        { ...emptyBlock('heading_1'), text: 'Welcome' },
        emptyBlock(),
      ]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const boxes = screen.getAllByRole('textbox');
    fireEvent.focus(boxes[1]!);
    fireEvent.input(boxes[1]!, { target: { textContent: '/toc' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Table of contents/ }));
    expect(screen.getByTestId('pages-toc').textContent).toContain('Welcome');
  });

  it('turns /2 columns into a two-column layout', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.focus(textbox);
    fireEvent.input(textbox, { target: { textContent: '/2 col' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /2 columns/ }));
    expect(document.querySelector('[data-type="column_list"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-type="column"]').length).toBe(2);
  });

  it('inserts a drag-and-drop board from the slash menu', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.focus(textbox);
    fireEvent.input(textbox, { target: { textContent: '/kanban' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Board/ }));
    expect(screen.getByTestId('pages-tool-board')).toBeTruthy();
    expect(screen.getByDisplayValue('To do')).toBeTruthy();
    expect(screen.getByDisplayValue('In progress')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '+ Card' })[0]!);
    expect(screen.getByLabelText('Card title')).toBeTruthy();
  });

  it('inserts a to-do list and checks an item off', () => {
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock()]);
      return <BlockEditor blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    const textbox = screen.getByRole('textbox');
    fireEvent.focus(textbox);
    fireEvent.input(textbox, { target: { textContent: '/checklist' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /To-do list/ }));
    expect(screen.getByTestId('pages-tool-checklist')).toBeTruthy();
    const items = screen.getAllByLabelText('To-do text');
    fireEvent.change(items[0]!, { target: { value: 'Ship the board' } });
    fireEvent.click(screen.getByLabelText('Ship the board'));
    expect((screen.getByLabelText('Ship the board') as HTMLInputElement).checked).toBe(true);
  });

  it('assigns a task to a teammate', async () => {
    vi.spyOn(registry, 'fetchOrgMembers').mockResolvedValue([
      {
        id: 'm1',
        orgId: 'org-1',
        userId: 'user-ada',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        username: 'ada',
        bio: null,
        avatarUrl: null,
        role: 'member',
        status: 'active',
        reportsTo: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    function Harness() {
      const [blocks, setBlocks] = useState<DraftBlock[]>([emptyBlock('assigner')]);
      return <BlockEditor orgId="org-1" blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    expect(screen.getByTestId('pages-tool-assigner')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Write brief' } });
    expect(await screen.findByRole('option', { name: 'Ada Lovelace' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'user-ada' } });
    expect((screen.getByLabelText('Assignee') as HTMLSelectElement).value).toBe('user-ada');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('todo');
  });
});
