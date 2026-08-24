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
});
