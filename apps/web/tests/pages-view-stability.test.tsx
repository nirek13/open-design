// @vitest-environment jsdom
//
// Regressions for the notes surface: an open note must never be moved,
// rewritten, or re-fetched because of something the person did not do.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/ChatPane', () => ({ ChatPane: () => <div data-testid="pages-agent-chat" /> }));
vi.mock('../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [], streaming: false, error: null, loading: false,
    onSend: vi.fn(), onRetry: vi.fn(), onStop: vi.fn(),
  }),
}));

import { PagesView } from '../src/components/pages/PagesView';
import { useRoute } from '../src/router';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';
import * as projects from '../src/state/projects';
import type { PageTreeNode, WorkspacePageDetail } from '@open-design/contracts';

const ORG = {
  id: 'ws-1', name: 'Northwind', createdBy: 'wsm-1',
  createdAt: 1, updatedAt: 1, role: 'owner' as const, memberCount: 1,
};

function pageDetail(id: string, title: string, body: string): WorkspacePageDetail {
  return {
    id, orgId: 'ws-1', parentPageId: null, title, icon: '📘', cover: null,
    linkedRecordId: null, linkedTableId: null, style: {}, visibility: 'public',
    position: 0, createdBy: 'wsm-1', createdAt: 1, updatedAt: 1, archivedAt: null,
    blocks: [{
      id: `${id}-b1`, pageId: id, parentBlockId: null, type: 'paragraph',
      content: body, props: {}, position: 0, children: [], createdAt: 1, updatedAt: 1,
    }],
  };
}

function RoutedPages() {
  const route = useRoute();
  return (
    <PagesView
      active
      initialPageId={route.kind === 'home' && route.view === 'pages' ? route.pageId : undefined}
    />
  );
}

function renderNotes() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider><RoutedPages /></OrgProvider>
    </I18nProvider>,
  );
}

const settle = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));
const shownTitle = () => (screen.getByTestId('pages-title') as HTMLTextAreaElement).value;
const clickInSidebar = (name: string) =>
  fireEvent.click(within(screen.getByTestId('pages-sidebar')).getByText(name));

describe('notes stability', () => {
  let tree: PageTreeNode[];
  let alpha: WorkspacePageDetail;
  let beta: WorkspacePageDetail;

  beforeEach(() => {
    window.localStorage.setItem('open-design:active-org:v1', 'ws-1');
    window.history.replaceState({}, '', '/pages');
    alpha = pageDetail('page-a', 'Alpha', 'Alpha body');
    beta = pageDetail('page-b', 'Beta', 'Beta body');
    tree = [{ page: alpha, children: [] }, { page: beta, children: [] }];
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'u1', displayName: 'Local Owner', email: null, username: null, bio: null, avatarUrl: null },
      organizations: [ORG],
    } as never);
    vi.spyOn(registry, 'fetchPageTree').mockImplementation(async () => tree as never);
    vi.spyOn(registry, 'fetchWorkspacePage').mockImplementation(
      async (_org: string, id: string) => (id === 'page-b' ? beta : alpha) as never,
    );
    vi.spyOn(registry, 'updateWorkspacePage').mockImplementation(
      async (_org: string, id: string) => (id === 'page-b' ? beta : alpha) as never,
    );
    vi.spyOn(registry, 'setWorkspacePageBlocks').mockImplementation(
      async (_org: string, id: string) => (id === 'page-b' ? beta : alpha) as never,
    );
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([] as never);
    vi.spyOn(registry, 'embedInWorkspacePage').mockImplementation(
      async (_org: string, id: string) => (id === 'page-b' ? beta : alpha) as never,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/pages');
  });

  it('never writes one note over another when you switch mid-autosave', async () => {
    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();

    // Rename Alpha, then jump to Beta before the 700ms autosave fires.
    fireEvent.change(screen.getByTestId('pages-title'), { target: { value: 'Alpha renamed' } });
    clickInSidebar('Beta');
    await settle(1500);

    const writes = (registry.updateWorkspacePage as never as {
      mock: { calls: Array<[string, string, { title?: string }]> };
    }).mock.calls;
    for (const [, pageId, input] of writes) {
      if (input.title === undefined) continue;
      const belongsToAlpha = pageId === 'page-a';
      expect(input.title, `page ${pageId} was written the title ${input.title}`).toBe(
        belongsToAlpha ? 'Alpha renamed' : 'Beta',
      );
    }
    const blockWrites = (registry.setWorkspacePageBlocks as never as {
      mock: { calls: Array<[string, string, { blocks: Array<{ content?: unknown }> }]> };
    }).mock.calls;
    for (const [, pageId, input] of blockWrites) {
      const body = JSON.stringify(input.blocks);
      expect(body, `page ${pageId} got the wrong body`).toContain(
        pageId === 'page-a' ? 'Alpha body' : 'Beta body',
      );
    }
  }, 20000);

  it('settles on Saved without re-reading the whole tree for a body edit', async () => {
    // A server that mints ids for new blocks, the way the daemon does.
    let minted = 0;
    let stored = alpha;
    (registry.setWorkspacePageBlocks as never as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (_org: string, id: string, input: { blocks: Array<Record<string, unknown>> }) => {
        stored = {
          ...(id === 'page-b' ? beta : alpha),
          updatedAt: 100 + minted,
          blocks: input.blocks.map((block, index) => ({
            id: (block.id as string | undefined) ?? `minted-${(minted += 1)}`,
            pageId: id, parentBlockId: null,
            type: block.type as never, content: block.content as never,
            props: (block.props ?? {}) as never,
            position: index, children: [], createdAt: 1, updatedAt: 1,
          })),
        } as WorkspacePageDetail;
        return stored as never;
      });

    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();

    // Press Enter to add a block the server has not seen, so the save reply
    // carries a freshly minted id — the case where the saved-state bookkeeping
    // is easiest to get wrong.
    const block = screen.getByTestId('pages-editor').querySelector('[role="textbox"]');
    expect(block).toBeTruthy();
    (block as HTMLElement).textContent = 'Alpha body plus a new sentence';
    fireEvent.input(block as HTMLElement);
    fireEvent.keyDown(block as HTMLElement, { key: 'Enter' });
    const blocksNow = screen.getByTestId('pages-editor').querySelectorAll('[role="textbox"]');
    expect(blocksNow.length).toBe(2);
    (blocksNow[1] as HTMLElement).textContent = 'A second paragraph';
    fireEvent.input(blocksNow[1] as HTMLElement);

    await waitFor(
      () => expect(screen.getByText('Saved')).toBeTruthy(),
      { timeout: 5000 },
    );
    await settle(1200);
    expect(screen.getByText('Saved')).toBeTruthy();
    const writes = (registry.setWorkspacePageBlocks as never as { mock: { calls: unknown[][] } }).mock.calls;
    expect(writes.length).toBe(1);
    // Editing the body changes nothing the sidebar shows, so the note tree
    // must not be re-read and re-rendered underneath it. One read: the boot.
    const treeReads = (registry.fetchPageTree as never as { mock: { calls: unknown[][] } }).mock.calls;
    expect(treeReads.length).toBe(1);
  }, 20000);

  it('does not paint a slow save from the previous note into the open one', async () => {
    // A rename whose request is still in flight when the reader moves on. The
    // reply must land on the note it belongs to, not on the one now on screen.
    (registry.updateWorkspacePage as never as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (_org: string, id: string, input: { title?: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const base = id === 'page-b' ? beta : alpha;
        return { ...base, title: input.title ?? base.title, updatedAt: 300 } as never;
      });

    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();
    fireEvent.change(screen.getByTestId('pages-title'), { target: { value: 'Alpha renamed' } });
    await settle(900);
    clickInSidebar('Beta');
    await waitFor(() => expect(shownTitle()).toBe('Beta'), { timeout: 4000 });
    await settle(2500);
    expect(shownTitle()).toBe('Beta');
    // The reply carries Alpha's blocks. Stamping those ids onto the note now
    // on screen would make Beta's next save claim Alpha's rows.
    const block = screen.getByTestId('pages-editor').querySelector('[id^="block-"]');
    expect(block?.id).toBe('block-page-b-b1');
    expect(block?.textContent).toBe('Beta body');
  }, 25000);

  it('stays on the open note when the route drops its page id', async () => {
    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();
    clickInSidebar('Beta');
    await settle();
    expect(shownTitle()).toBe('Beta');

    // A bare /pages entry (back button, nav rail, closing a tab) must not
    // yank the reader onto the first note in the tree.
    window.history.pushState({}, '', '/pages');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle(600);
    expect(shownTitle()).toBe('Beta');
  }, 20000);

  it('shows text the agent rewrote in the open note', async () => {
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: { id: 'proj-1', name: 'x', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 },
      conversationId: 'conv-1',
    } as never);
    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();
    const body = () => screen.getByTestId('pages-editor').querySelector('[role="textbox"]');
    expect(body()?.textContent).toBe('Alpha body');

    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), { target: { value: 'Rewrite this' } });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    await screen.findByTestId('pages-agent-builder');

    // The run rewrites the paragraph. The block text lives in the DOM, not in
    // React's children, so it only updates if we push it there.
    alpha = { ...alpha, updatedAt: 500, blocks: [{ ...alpha.blocks[0]!, content: 'Rewritten by the agent' }] };
    tree = [{ page: alpha, children: [] }, { page: beta, children: [] }];
    await waitFor(() => expect(body()?.textContent).toBe('Rewritten by the agent'), { timeout: 4000 });
  }, 20000);

  it('does not re-fetch the note twice for one click', async () => {
    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();
    const before = (registry.fetchWorkspacePage as never as { mock: { calls: unknown[][] } }).mock.calls.length;
    clickInSidebar('Beta');
    await settle(600);
    const after = (registry.fetchWorkspacePage as never as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(after - before).toBe(1);
  }, 20000);

  it('leaves the reader where they are once they pick a note during an Ask AI run', async () => {
    vi.spyOn(projects, 'createProject').mockResolvedValue({
      project: { id: 'proj-1', name: 'x', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 },
      conversationId: 'conv-1',
    } as never);
    renderNotes();
    await waitFor(() => expect(screen.getByTestId('pages-title')).toBeTruthy());
    await settle();
    clickInSidebar('Beta');
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI' }), { target: { value: 'Build a wiki' } });
    fireEvent.submit(screen.getByTestId('pages-ask-ai'));
    await screen.findByTestId('pages-agent-builder');

    // The reader deliberately re-picks Beta from the tab bar while the run works.
    fireEvent.click(within(screen.getByTestId('pages-tab-page-b')).getByTitle('Beta'));
    await settle();
    expect(shownTitle()).toBe('Beta');

    // The agent then writes three more notes.
    for (const [id, title] of [['page-c', 'Gamma'], ['page-d', 'Delta'], ['page-e', 'Epsilon']] as const) {
      const created = pageDetail(id, title, `${title} body`);
      tree = [...tree, { page: created, children: [] }];
      await settle(1200);
      expect(shownTitle(), `agent note ${title} stole the view`).toBe('Beta');
    }
  }, 30000);
});
