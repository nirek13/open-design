import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  archivePage,
  appendPageBlocks,
  createPage,
  duplicatePage,
  embedInPage,
  getPage,
  getPageTree,
  listPages,
  scaffoldPages,
  searchPages,
  setPageBlocks,
  updatePage,
  upsertPageFromAgent,
} from '../src/workspace-data/pages.js';
import { createTable } from '../src/workspace-data/schema.js';

describe('organization pages', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pages-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  it('creates a page with a default paragraph and nests children', async () => {
    const root = await createPage(db(), orgId, 'member-1', { title: 'Handbook' });
    expect(root.title).toBe('Handbook');
    expect(root.blocks).toHaveLength(1);
    expect(root.blocks[0]!.type).toBe('paragraph');

    const child = await createPage(db(), orgId, 'member-1', {
      title: 'Onboarding',
      parentPageId: root.id,
      blocks: [
        { type: 'heading_1', content: 'Day one' },
        { type: 'to_do', content: 'Read the handbook', props: { checked: false } },
      ],
    });
    expect(child.parentPageId).toBe(root.id);
    expect(child.blocks.map((b) => b.type)).toEqual(['heading_1', 'to_do']);

    const tree = await getPageTree(db(), orgId);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.page.id).toBe(root.id);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.page.title).toBe('Onboarding');
  });

  it('replaces blocks including database embeds', async () => {
    const table = createTable(
      manager.openWorkspace(orgId),
      {
        name: 'launch_tasks',
        displayName: 'Launch tasks',
        fields: [{ name: 'title', displayName: 'Title', type: 'text' }],
      },
      { kind: 'user', memberId: 'member-1' },
    );
    const page = await createPage(db(), orgId, 'member-1', { title: 'Launch' });
    const updated = await setPageBlocks(db(), orgId, page.id, {
      blocks: [
        { type: 'heading_2', content: 'Tracker' },
        { type: 'database', content: '', props: { tableId: table.id } },
        {
          type: 'artifact',
          content: 'dashboard.html',
          props: { path: 'dashboard.html' },
        },
      ],
    });
    expect(updated.blocks).toHaveLength(3);
    expect(updated.blocks[1]!.props.tableId).toBe(table.id);
    expect(updated.blocks[2]!.props.path).toBe('dashboard.html');
  });

  it('rejects unknown block types and cycle parents', async () => {
    const a = await createPage(db(), orgId, 'member-1', { title: 'A' });
    const b = await createPage(db(), orgId, 'member-1', { title: 'B', parentPageId: a.id });
    await expect(
      setPageBlocks(db(), orgId, a.id, {
        blocks: [{ type: 'magic' as any, content: 'nope' }],
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VALIDATION_FAILED' });

    await expect(updatePage(db(), orgId, a.id, { parentPageId: b.id })).rejects.toMatchObject({
      code: 'PAGE_PARENT_INVALID',
    });
  });

  it('archives pages out of the default list and upserts from agents', async () => {
    const page = await createPage(db(), orgId, 'run-1', { title: 'Draft' });
    await archivePage(db(), orgId, page.id);
    expect(await listPages(db(), orgId)).toHaveLength(0);

    const again = await upsertPageFromAgent(db(), orgId, 'run-2', {
      title: 'Agent brief',
      blocks: [{ type: 'callout', content: 'Ship pages MVP' }],
    });
    expect(again.title).toBe('Agent brief');
    const refreshed = await upsertPageFromAgent(db(), orgId, 'run-2', {
      pageId: again.id,
      title: 'Agent brief v2',
      blocks: [{ type: 'paragraph', content: 'Updated' }],
    });
    expect(refreshed.title).toBe('Agent brief v2');
    expect((await getPage(db(), orgId, again.id)).blocks[0]!.content).toBe('Updated');
  });

  it('embeds a child page on the parent and supports search, append, scaffold, duplicate', async () => {
    const root = await createPage(db(), orgId, 'member-1', {
      title: 'Handbook',
      blocks: [{ type: 'heading_1', content: 'Company handbook' }],
    });
    const child = await createPage(db(), orgId, 'member-1', {
      title: 'Onboarding',
      parentPageId: root.id,
      blocks: [{ type: 'paragraph', content: 'Day one checklist' }],
    });
    const parent = await getPage(db(), orgId, root.id);
    expect(parent.blocks.some((block) => block.type === 'page' && block.props.pageId === child.id)).toBe(true);

    const hits = await searchPages(db(), orgId, 'checklist');
    expect(hits.map((hit) => hit.page.id)).toContain(child.id);

    const appended = await appendPageBlocks(db(), orgId, child.id, {
      blocks: [{ type: 'callout', content: 'Bring a laptop' }],
    });
    expect(appended.blocks.map((block) => block.type)).toEqual(['paragraph', 'callout']);

    const withBookmark = await embedInPage(db(), orgId, child.id, {
      type: 'bookmark',
      url: 'https://example.com/handbook',
    });
    expect(withBookmark.blocks.at(-1)?.type).toBe('bookmark');
    expect(withBookmark.blocks.at(-1)?.props.url).toBe('https://example.com/handbook');

    const withLive = await embedInPage(db(), orgId, child.id, {
      type: 'embed',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(withLive.blocks.at(-1)?.type).toBe('embed');
    expect(withLive.blocks.at(-1)?.props.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const withLocal = await embedInPage(db(), orgId, child.id, {
      type: 'embed',
      url: '/api/projects/proj-wiki/raw/hero.png',
    });
    expect(withLocal.blocks.at(-1)?.type).toBe('embed');
    expect(withLocal.blocks.at(-1)?.props.url).toBe('/api/projects/proj-wiki/raw/hero.png');
    const again = await embedInPage(db(), orgId, child.id, {
      type: 'embed',
      url: '/api/projects/proj-wiki/raw/hero.png',
    });
    expect(again.blocks.filter((block) => block.type === 'embed')).toHaveLength(
      withLocal.blocks.filter((block) => block.type === 'embed').length,
    );

    const nested = await scaffoldPages(db(), orgId, 'member-1', {
      parentPageId: root.id,
      pages: [
        {
          title: 'Policies',
          icon: '📜',
          children: [{ title: 'Time off', blocks: [{ type: 'paragraph', content: 'PTO lives here' }] }],
        },
      ],
    });
    expect(nested.pages.map((page) => page.title)).toEqual(['Policies', 'Time off']);
    const policies = await getPage(db(), orgId, nested.pages[0]!.id);
    expect(policies.blocks.some((block) => block.type === 'page')).toBe(true);

    const copy = await duplicatePage(db(), orgId, 'member-1', policies.id, { recursive: true });
    expect(copy.title).toBe('Policies (copy)');
    const tree = await getPageTree(db(), orgId);
    const handbook = tree.find((node) => node.page.id === root.id);
    const copied = handbook?.children.find((node) => node.page.id === copy.id);
    expect(copied?.children.map((node) => node.page.title)).toEqual(['Time off']);
  });

  it('can create a nested page without linking it on the parent', async () => {
    const root = await createPage(db(), orgId, 'member-1', { title: 'Quiet parent' });
    await createPage(db(), orgId, 'member-1', {
      title: 'Hidden child',
      parentPageId: root.id,
      linkOnParent: false,
    });
    const parent = await getPage(db(), orgId, root.id);
    expect(parent.blocks.some((block) => block.type === 'page')).toBe(false);
  });

  it('persists page appearance and Notion media/layout blocks', async () => {
    const page = await createPage(db(), orgId, 'member-1', {
      title: 'Design notes',
      style: { font: 'serif', fullWidth: true, smallText: true },
      blocks: [
        { type: 'heading_1', content: 'Welcome' },
        { type: 'equation', content: 'E = mc^2' },
        { type: 'table_of_contents', content: null },
        { type: 'image', content: 'https://example.com/hero.png', props: { url: 'https://example.com/hero.png' } },
        {
          type: 'column_list',
          content: '',
          children: [
            { type: 'column', content: '', children: [{ type: 'paragraph', content: 'Left' }] },
            { type: 'column', content: '', children: [{ type: 'paragraph', content: 'Right' }] },
          ],
        },
      ],
    });
    expect(page.style).toEqual({ font: 'serif', fullWidth: true, smallText: true });
    expect(page.blocks.map((block) => block.type)).toEqual([
      'heading_1',
      'equation',
      'table_of_contents',
      'image',
      'column_list',
    ]);
    expect(page.blocks[4]!.children).toHaveLength(2);
    const updated = await updatePage(db(), orgId, page.id, { style: { locked: true, font: 'mono' } });
    expect(updated.style).toEqual({ locked: true, font: 'mono' });
  });

  it('persists inline page tools like a board and checklist', async () => {
    const page = await createPage(db(), orgId, 'member-1', {
      title: 'Sprint',
      blocks: [
        {
          type: 'board',
          content: {
            kind: 'board',
            columns: [
              {
                id: 'col-todo',
                title: 'To do',
                cards: [{ id: 'card-1', title: 'Write spec' }],
              },
              { id: 'col-doing', title: 'In progress', cards: [] },
            ],
          },
        },
        {
          type: 'checklist',
          content: {
            kind: 'checklist',
            items: [{ id: 'i1', text: 'Ship', checked: false }],
          },
        },
        {
          type: 'assigner',
          content: {
            kind: 'assigner',
            tasks: [
              {
                id: 't1',
                title: 'Review',
                assigneeId: 'user-ada',
                assigneeName: 'Ada',
                status: 'doing',
              },
            ],
          },
        },
      ],
    });
    expect(page.blocks.map((block) => block.type)).toEqual(['board', 'checklist', 'assigner']);
    expect(page.blocks[0]!.content).toMatchObject({
      kind: 'board',
      columns: [
        { title: 'To do', cards: [{ title: 'Write spec' }] },
        { title: 'In progress', cards: [] },
      ],
    });
    expect(page.blocks[1]!.content).toMatchObject({
      kind: 'checklist',
      items: [{ text: 'Ship', checked: false }],
    });
    expect(page.blocks[2]!.content).toMatchObject({
      kind: 'assigner',
      tasks: [{ title: 'Review', assigneeName: 'Ada', status: 'doing' }],
    });
  });

  it('persists spreadsheet and budget page tools', async () => {
    const page = await createPage(db(), orgId, 'member-1', {
      title: 'Finance',
      blocks: [
        {
          type: 'spreadsheet',
          content: {
            kind: 'spreadsheet',
            cells: [
              ['Rent', '1200'],
              ['Total', '=B1'],
            ],
          },
        },
        {
          type: 'budget',
          content: {
            kind: 'budget',
            currency: '$',
            items: [
              {
                id: 'i1',
                date: '2026-09-01',
                label: 'Salary',
                category: 'Income',
                amount: 4000,
                flow: 'income',
              },
            ],
          },
        },
      ],
    });
    expect(page.blocks.map((block) => block.type)).toEqual(['spreadsheet', 'budget']);
    expect(page.blocks[0]!.content).toMatchObject({
      kind: 'spreadsheet',
      cells: [
        ['Rent', '1200'],
        ['Total', '=B1'],
      ],
    });
    expect(page.blocks[1]!.content).toMatchObject({
      kind: 'budget',
      items: [{ label: 'Salary', amount: 4000, flow: 'income' }],
    });
  });

  it('hides private pages from other members and lets the creator flip visibility', async () => {
    const shared = await createPage(db(), orgId, 'member-1', {
      title: 'Handbook',
      visibility: 'public',
    });
    const secret = await createPage(db(), orgId, 'member-1', {
      title: 'Salary notes',
      visibility: 'private',
    });
    expect(shared.visibility).toBe('public');
    expect(secret.visibility).toBe('private');

    const forOwner = await listPages(db(), orgId, { viewerId: 'member-1' });
    expect(forOwner.map((page) => page.title).sort()).toEqual(['Handbook', 'Salary notes']);

    const forCoworker = await listPages(db(), orgId, { viewerId: 'member-2' });
    expect(forCoworker.map((page) => page.title)).toEqual(['Handbook']);

    await expect(getPage(db(), orgId, secret.id, 'member-2')).rejects.toMatchObject({
      code: 'PAGE_NOT_FOUND',
    });
    await expect(
      searchPages(db(), orgId, 'Salary', 25, 'member-2'),
    ).resolves.toEqual([]);
    expect((await searchPages(db(), orgId, 'Salary', 25, 'member-1')).map((hit) => hit.page.id)).toEqual([
      secret.id,
    ]);

    await expect(
      updatePage(db(), orgId, shared.id, { visibility: 'private' }, 'member-2'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VALIDATION_FAILED' });

    const hidden = await updatePage(db(), orgId, shared.id, { visibility: 'private' }, 'member-1');
    expect(hidden.visibility).toBe('private');
    expect(await listPages(db(), orgId, { viewerId: 'member-2' })).toHaveLength(0);

    const child = await createPage(db(), orgId, 'member-1', {
      title: 'Draft appendix',
      parentPageId: secret.id,
    });
    expect(child.visibility).toBe('private');
  });
});
