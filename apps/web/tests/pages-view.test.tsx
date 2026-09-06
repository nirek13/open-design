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
  });

  it('tells the agent to create a unique file and embed it when making from a page', () => {
    const prompt = composePagesWikiPrompt({
      request: 'A hiring dashboard',
      pageId: 'page-1',
      pageTitle: 'Handbook',
      make: { kind: 'app', prompt: 'A hiring dashboard' },
    });
    expect(prompt).toContain('unique interactive app');
    expect(prompt).toContain('A hiring dashboard');
    expect(prompt).toContain('tools pages embed');
    expect(prompt).toContain('/raw/');
    expect(prompt).toContain('Do not stop at a description');
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
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customize page' }));
    expect(screen.getByTestId('pages-customize')).toBeTruthy();
    expect(screen.getByText('Full width')).toBeTruthy();
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
});
