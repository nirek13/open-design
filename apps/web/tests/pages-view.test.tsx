// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="pages-agent-chat" />,
}));

vi.mock('../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [],
    streaming: false,
    error: null,
    loading: false,
    onSend: vi.fn(),
    onRetry: vi.fn(),
    onStop: vi.fn(),
  }),
}));

import { applyMarkdownShortcut, BlockEditor, emptyBlock, type DraftBlock } from '../src/components/pages/BlockEditor';
import { PagesView } from '../src/components/pages/PagesView';
import { composePagesWikiPrompt } from '../src/components/pages/wiki-prompt';
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
});

describe('PagesView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
      organizations: [ORG],
    });
    const detail = pageDetail();
    vi.spyOn(registry, 'fetchPageTree').mockResolvedValue([
      { page: detail, children: [] },
    ]);
    vi.spyOn(registry, 'fetchWorkspacePage').mockResolvedValue(detail);
    vi.spyOn(registry, 'updateWorkspacePage').mockResolvedValue(detail);
    vi.spyOn(registry, 'setWorkspacePageBlocks').mockResolvedValue(detail);
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
    expect(screen.getByTestId('page-context-chip').textContent).toContain('Handbook');
    expect(screen.getByTestId('page-context-chip').textContent).toContain('Building on');
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
    expect(arg?.pendingPrompt).toContain('page-1');
    expect(arg?.pendingPrompt).toContain('Welcome');
    expect(arg?.pendingPrompt).toContain('Add an onboarding section');
    expect(await screen.findByTestId('pages-agent-builder')).toBeTruthy();
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('docked');
    expect(screen.getByTestId('pages-title')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pages-agent-expand'));
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('expanded');
    fireEvent.click(screen.getByTestId('pages-agent-dock'));
    expect(screen.getByTestId('pages-view').getAttribute('data-builder-layout')).toBe('docked');
    fireEvent.click(screen.getByTestId('pages-agent-close'));
    expect(screen.getByTestId('pages-ask-ai')).toBeTruthy();
  });
});

describe('BlockEditor', () => {
  afterEach(() => {
    cleanup();
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
  });
});
