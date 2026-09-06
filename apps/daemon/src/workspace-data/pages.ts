// Organization pages: nested notes with a typed block tree.
//
// Soft documents — members and agents write directly. A page can embed a
// workspace table (`database` block) or point at a design artifact without
// owning either; those stay in their own stores.

import { randomUUID } from 'node:crypto';
import {
  PAGE_BLOCK_TYPES,
  parsePageStyle,
  type AppendPageBlocksRequest,
  type CreatePageRequest,
  type DuplicatePageRequest,
  type EmbedPageBlockRequest,
  type PageBlock,
  type PageBlockInput,
  type PageBlockType,
  type PageTreeNode,
  type ScaffoldPageNode,
  type ScaffoldPagesRequest,
  type SearchPagesHit,
  type SetPageBlocksRequest,
  type UpdatePageRequest,
  type WorkspacePage,
  type WorkspacePageDetail,
} from '@open-design/contracts';
import type { JsonValue } from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const BLOCK_TYPE_SET = new Set<string>(PAGE_BLOCK_TYPES);

const PAGE_COLS = `
  id, workspace_id AS "orgId", parent_page_id AS "parentPageId", title, icon, cover,
  linked_record_id AS "linkedRecordId", linked_table_id AS "linkedTableId",
  style_json AS "styleJson",
  position, created_by AS "createdBy", created_at AS "createdAt",
  updated_at AS "updatedAt", archived_at AS "archivedAt"
`;

const BLOCK_COLS = `
  id, page_id AS "pageId", parent_block_id AS "parentBlockId", type,
  content_json AS "contentJson", props_json AS "propsJson", position,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

interface PageRow {
  id: string;
  orgId: string;
  parentPageId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  linkedRecordId: string | null;
  linkedTableId: string | null;
  styleJson: string | null;
  position: number | string;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
  archivedAt: number | string | null;
}

interface BlockRow {
  id: string;
  pageId: string;
  parentBlockId: string | null;
  type: string;
  contentJson: string;
  propsJson: string;
  position: number | string;
  createdAt: number | string;
  updatedAt: number | string;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function parseJson(raw: unknown, fallback: JsonValue): JsonValue {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback;
  }
}

function pageNotFound(ref: string): WorkspaceDataError {
  return new WorkspaceDataError('PAGE_NOT_FOUND', 404, `no page '${ref}'`);
}

function normalizePage(row: PageRow): WorkspacePage {
  return {
    id: row.id,
    orgId: row.orgId,
    parentPageId: row.parentPageId,
    title: row.title,
    icon: row.icon,
    cover: row.cover,
    linkedRecordId: row.linkedRecordId ?? null,
    linkedTableId: row.linkedTableId ?? null,
    style: parsePageStyle(parseJson(row.styleJson, {})),
    position: num(row.position),
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
    archivedAt: nullableNum(row.archivedAt),
  };
}

function normalizeBlockFlat(row: BlockRow): Omit<PageBlock, 'children'> {
  const props = parseJson(row.propsJson, {});
  return {
    id: row.id,
    pageId: row.pageId,
    parentBlockId: row.parentBlockId,
    type: row.type as PageBlockType,
    content: parseJson(row.contentJson, ''),
    props: props && typeof props === 'object' && !Array.isArray(props)
      ? (props as Record<string, JsonValue>)
      : {},
    position: num(row.position),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

function buildBlockTree(rows: BlockRow[]): PageBlock[] {
  const byParent = new Map<string | null, BlockRow[]>();
  for (const row of rows) {
    const key = row.parentBlockId;
    const list = byParent.get(key) ?? [];
    list.push(row);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => num(a.position) - num(b.position));
  }
  const walk = (parentId: string | null): PageBlock[] => {
    const kids = byParent.get(parentId) ?? [];
    return kids.map((row) => ({
      ...normalizeBlockFlat(row),
      children: walk(row.id),
    }));
  };
  return walk(null);
}

function assertBlockType(type: string): asserts type is PageBlockType {
  if (!BLOCK_TYPE_SET.has(type)) {
    throw workspaceValidationError([
      { path: 'type', message: `must be one of: ${PAGE_BLOCK_TYPES.join(', ')}` },
    ]);
  }
}

function validateBlockInput(input: PageBlockInput, path: string): void {
  assertBlockType(input.type);
  if (input.type === 'database') {
    const tableId = input.props?.tableId;
    if (typeof tableId !== 'string' || !tableId.trim()) {
      throw new WorkspaceDataError(
        'PAGE_BLOCK_INVALID',
        400,
        `${path}: database block needs props.tableId`,
      );
    }
  }
  if (input.type === 'artifact') {
    const filePath = input.props?.path ?? input.content;
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new WorkspaceDataError(
        'PAGE_BLOCK_INVALID',
        400,
        `${path}: artifact block needs props.path (or content string)`,
      );
    }
  }
  if (input.type === 'page') {
    const pageId = input.props?.pageId;
    if (typeof pageId !== 'string' || !pageId.trim()) {
      throw new WorkspaceDataError(
        'PAGE_BLOCK_INVALID',
        400,
        `${path}: page block needs props.pageId`,
      );
    }
  }
  if (input.type === 'record') {
    const recordId = input.props?.recordId;
    if (typeof recordId !== 'string' || !recordId.trim()) {
      throw new WorkspaceDataError(
        'PAGE_BLOCK_INVALID',
        400,
        `${path}: record block needs props.recordId`,
      );
    }
  }
  for (let i = 0; i < (input.children?.length ?? 0); i++) {
    validateBlockInput(input.children![i]!, `${path}.children[${i}]`);
  }
}

async function loadPageRow(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<PageRow> {
  const row = await db.get<PageRow>(
    `SELECT ${PAGE_COLS} FROM od_pages WHERE id = ? AND workspace_id = ?`,
    [pageId, orgId],
  );
  if (!row) throw pageNotFound(pageId);
  if (!opts.includeArchived && row.archivedAt != null) throw pageNotFound(pageId);
  return row;
}

async function assertParentOk(
  db: SqlExecutor,
  orgId: string,
  parentPageId: string | null | undefined,
  selfId?: string,
): Promise<string | null> {
  if (parentPageId == null || parentPageId === '') return null;
  if (selfId && parentPageId === selfId) {
    throw new WorkspaceDataError('PAGE_PARENT_INVALID', 400, 'a page cannot be its own parent');
  }
  const parent = await loadPageRow(db, orgId, parentPageId);
  // Prevent cycles: walk ancestors.
  if (selfId) {
    let cursor: string | null = parent.parentPageId;
    const seen = new Set<string>([parentPageId]);
    while (cursor) {
      if (cursor === selfId) {
        throw new WorkspaceDataError('PAGE_PARENT_INVALID', 400, 'parent would create a cycle');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next = await db.get<PageRow>(
        `SELECT ${PAGE_COLS} FROM od_pages WHERE id = ? AND workspace_id = ?`,
        [cursor, orgId],
      );
      cursor = next?.parentPageId ?? null;
    }
  }
  return parent.id;
}

async function nextPagePosition(
  db: SqlExecutor,
  orgId: string,
  parentPageId: string | null,
): Promise<number> {
  const row = await db.get<{ maxPos: number | string | null }>(
    `SELECT MAX(position) AS "maxPos" FROM od_pages
     WHERE workspace_id = ? AND archived_at IS NULL
       AND ${parentPageId == null ? 'parent_page_id IS NULL' : 'parent_page_id = ?'}`,
    parentPageId == null ? [orgId] : [orgId, parentPageId],
  );
  return row?.maxPos == null ? 0 : num(row.maxPos) + 1;
}

async function insertBlockTree(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  inputs: PageBlockInput[],
  parentBlockId: string | null,
  now: number,
): Promise<void> {
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    validateBlockInput(input, `blocks[${i}]`);
    const id = input.id && input.id.trim() ? input.id.trim() : randomUUID();
    const content =
      input.content === undefined
        ? input.type === 'divider'
          ? null
          : input.type === 'table'
            ? { rows: [[''], ['']] }
            : ''
        : input.content;
    const props = input.props ?? {};
    if (input.type === 'to_do' && props.checked === undefined) {
      (props as Record<string, JsonValue>).checked = false;
    }
    await db.run(
      `INSERT INTO od_blocks (
         id, page_id, workspace_id, parent_block_id, type,
         content_json, props_json, position, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        pageId,
        orgId,
        parentBlockId,
        input.type,
        JSON.stringify(content),
        JSON.stringify(props),
        input.position ?? i,
        now,
        now,
      ],
    );
    if (input.children?.length) {
      await insertBlockTree(db, orgId, pageId, input.children, id, now);
    }
  }
}

export async function listPages(
  db: SqlExecutor,
  orgId: string,
  query: { parentPageId?: string | 'root'; includeArchived?: boolean } = {},
): Promise<WorkspacePage[]> {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [orgId];
  if (!query.includeArchived) clauses.push('archived_at IS NULL');
  if (query.parentPageId === 'root') {
    clauses.push('parent_page_id IS NULL');
  } else if (query.parentPageId) {
    clauses.push('parent_page_id = ?');
    params.push(query.parentPageId);
  }
  const rows = await db.all<PageRow>(
    `SELECT ${PAGE_COLS} FROM od_pages
     WHERE ${clauses.join(' AND ')}
     ORDER BY position ASC, created_at ASC`,
    params,
  );
  return rows.map(normalizePage);
}

export async function getPageTree(db: SqlExecutor, orgId: string): Promise<PageTreeNode[]> {
  const pages = await listPages(db, orgId);
  const byParent = new Map<string | null, WorkspacePage[]>();
  for (const page of pages) {
    const key = page.parentPageId;
    const list = byParent.get(key) ?? [];
    list.push(page);
    byParent.set(key, list);
  }
  const walk = (parentId: string | null): PageTreeNode[] => {
    const kids = byParent.get(parentId) ?? [];
    return kids.map((page) => ({ page, children: walk(page.id) }));
  };
  return walk(null);
}

export async function getPage(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
): Promise<WorkspacePageDetail> {
  const page = normalizePage(await loadPageRow(db, orgId, pageId));
  const rows = await db.all<BlockRow>(
    `SELECT ${BLOCK_COLS} FROM od_blocks WHERE page_id = ? AND workspace_id = ?
     ORDER BY position ASC, created_at ASC`,
    [pageId, orgId],
  );
  return { ...page, blocks: buildBlockTree(rows) };
}

export async function createPage(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: CreatePageRequest,
): Promise<WorkspacePageDetail> {
  const now = Date.now();
  const parentPageId = await assertParentOk(db, orgId, input.parentPageId);
  const id = randomUUID();
  const title = (input.title ?? 'Untitled').trim() || 'Untitled';
  const position = await nextPagePosition(db, orgId, parentPageId);
  await db.run(
    `INSERT INTO od_pages (
       id, workspace_id, parent_page_id, title, icon, cover,
       linked_record_id, linked_table_id, style_json, position,
       created_by, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      orgId,
      parentPageId,
      title,
      input.icon ?? null,
      input.cover ?? null,
      input.linkedRecordId ?? null,
      input.linkedTableId ?? null,
      JSON.stringify(input.style ?? {}),
      position,
      createdBy,
      now,
      now,
    ],
  );
  const blocks =
    input.blocks && input.blocks.length > 0
      ? input.blocks
      : [{ type: 'paragraph' as const, content: '' }];
  await insertBlockTree(db, orgId, id, blocks, null, now);
  if (parentPageId && input.linkOnParent !== false) {
    await appendPageBlocks(db, orgId, parentPageId, {
      blocks: [
        {
          type: 'page',
          content: title,
          props: { pageId: id },
        },
      ],
    });
  }
  return getPage(db, orgId, id);
}

export async function updatePage(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  input: UpdatePageRequest,
): Promise<WorkspacePageDetail> {
  await loadPageRow(db, orgId, pageId);
  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (input.title !== undefined) {
    sets.push('title = ?');
    params.push(input.title.trim() || 'Untitled');
  }
  if (input.icon !== undefined) {
    sets.push('icon = ?');
    params.push(input.icon);
  }
  if (input.cover !== undefined) {
    sets.push('cover = ?');
    params.push(input.cover);
  }
  if (input.linkedRecordId !== undefined) {
    sets.push('linked_record_id = ?');
    params.push(input.linkedRecordId);
  }
  if (input.linkedTableId !== undefined) {
    sets.push('linked_table_id = ?');
    params.push(input.linkedTableId);
  }
  if (input.position !== undefined) {
    sets.push('position = ?');
    params.push(input.position);
  }
  if (input.parentPageId !== undefined) {
    const parent = await assertParentOk(db, orgId, input.parentPageId, pageId);
    sets.push('parent_page_id = ?');
    params.push(parent);
  }
  if (input.style !== undefined) {
    sets.push('style_json = ?');
    params.push(JSON.stringify(input.style ?? {}));
  }

  params.push(pageId, orgId);
  await db.run(
    `UPDATE od_pages SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
    params,
  );
  return getPage(db, orgId, pageId);
}

export async function setPageBlocks(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  input: SetPageBlocksRequest,
): Promise<WorkspacePageDetail> {
  await loadPageRow(db, orgId, pageId);
  if (!Array.isArray(input.blocks)) {
    throw workspaceValidationError([{ path: 'blocks', message: 'required array' }]);
  }
  for (let i = 0; i < input.blocks.length; i++) {
    validateBlockInput(input.blocks[i]!, `blocks[${i}]`);
  }
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM od_blocks WHERE page_id = ? AND workspace_id = ?`, [pageId, orgId]);
    const blocks = input.blocks.length > 0 ? input.blocks : [{ type: 'paragraph' as const, content: '' }];
    await insertBlockTree(tx, orgId, pageId, blocks, null, now);
    await tx.run(`UPDATE od_pages SET updated_at = ? WHERE id = ? AND workspace_id = ?`, [
      now,
      pageId,
      orgId,
    ]);
  });
  return getPage(db, orgId, pageId);
}

export async function appendPageBlocks(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  input: AppendPageBlocksRequest,
): Promise<WorkspacePageDetail> {
  const existing = await getPage(db, orgId, pageId);
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw workspaceValidationError([{ path: 'blocks', message: 'required non-empty array' }]);
  }
  for (let i = 0; i < input.blocks.length; i++) {
    validateBlockInput(input.blocks[i]!, `blocks[${i}]`);
  }
  const now = Date.now();
  const start = existing.blocks.length;
  const positioned = input.blocks.map((block, index) => ({
    ...block,
    position: start + index,
  }));
  await insertBlockTree(db, orgId, pageId, positioned, null, now);
  await db.run(`UPDATE od_pages SET updated_at = ? WHERE id = ? AND workspace_id = ?`, [
    now,
    pageId,
    orgId,
  ]);
  return getPage(db, orgId, pageId);
}

function cloneBlockInputs(blocks: PageBlock[]): PageBlockInput[] {
  return blocks
    .filter((block) => block.type !== 'page')
    .map((block, index) => ({
      type: block.type,
      content: block.content,
      props: { ...block.props },
      position: index,
      children: cloneBlockInputs(block.children),
    }));
}

function embedToBlock(input: EmbedPageBlockRequest): PageBlockInput {
  switch (input.type) {
    case 'page': {
      const target = input.targetPageId?.trim();
      if (!target) {
        throw workspaceValidationError([{ path: 'targetPageId', message: 'required for page embeds' }]);
      }
      return { type: 'page', content: target, props: { pageId: target } };
    }
    case 'database': {
      const tableId = input.tableId?.trim();
      if (!tableId) {
        throw workspaceValidationError([{ path: 'tableId', message: 'required for database embeds' }]);
      }
      return { type: 'database', content: '', props: { tableId } };
    }
    case 'record': {
      const recordId = input.recordId?.trim();
      if (!recordId) {
        throw workspaceValidationError([{ path: 'recordId', message: 'required for record embeds' }]);
      }
      return { type: 'record', content: recordId, props: { recordId } };
    }
    case 'artifact': {
      const filePath = input.path?.trim();
      if (!filePath) {
        throw workspaceValidationError([{ path: 'path', message: 'required for artifact embeds' }]);
      }
      return { type: 'artifact', content: filePath, props: { path: filePath } };
    }
    case 'bookmark': {
      const url = input.url?.trim();
      if (!url) {
        throw workspaceValidationError([{ path: 'url', message: 'required for bookmark embeds' }]);
      }
      return { type: 'bookmark', content: url, props: { url } };
    }
    case 'embed': {
      const url = input.url?.trim() || input.path?.trim();
      if (!url) {
        throw workspaceValidationError([{ path: 'url', message: 'required for live embeds' }]);
      }
      return { type: 'embed', content: url, props: { url } };
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf': {
      const url = input.url?.trim() || input.path?.trim();
      if (!url) {
        throw workspaceValidationError([{ path: 'url', message: `required for ${input.type} embeds` }]);
      }
      return { type: input.type, content: url, props: { url } };
    }
    default:
      throw workspaceValidationError([{ path: 'type', message: 'unsupported embed type' }]);
  }
}

export async function embedInPage(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
  input: EmbedPageBlockRequest,
): Promise<WorkspacePageDetail> {
  return appendPageBlocks(db, orgId, pageId, { blocks: [embedToBlock(input)] });
}

export async function searchPages(
  db: SqlExecutor,
  orgId: string,
  query: string,
  limit = 25,
): Promise<SearchPagesHit[]> {
  const needle = query.trim();
  if (!needle) return [];
  const like = `%${needle.toLowerCase()}%`;
  const cap = Math.min(Math.max(limit, 1), 100);
  const rows = await db.all<PageRow & { snippet: string | null }>(
    `SELECT ${PAGE_COLS},
            (
              SELECT SUBSTR(b.content_json, 1, 180)
              FROM od_blocks b
              WHERE b.page_id = od_pages.id AND b.workspace_id = od_pages.workspace_id
                AND LOWER(b.content_json) LIKE ?
              LIMIT 1
            ) AS snippet
     FROM od_pages
     WHERE workspace_id = ? AND archived_at IS NULL
       AND (
         LOWER(title) LIKE ?
         OR id IN (
           SELECT page_id FROM od_blocks
           WHERE workspace_id = ? AND LOWER(content_json) LIKE ?
         )
       )
     ORDER BY updated_at DESC
     LIMIT ?`,
    [like, orgId, like, orgId, like, cap],
  );
  return rows.map((row) => ({
    page: normalizePage(row),
    snippet: typeof row.snippet === 'string' ? row.snippet : null,
  }));
}

export async function duplicatePage(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  pageId: string,
  input: DuplicatePageRequest = {},
): Promise<WorkspacePageDetail> {
  const source = await getPage(db, orgId, pageId);
  const copy = await createPage(db, orgId, createdBy, {
    title: `${source.title} (copy)`,
    parentPageId: source.parentPageId,
    icon: source.icon,
    cover: source.cover,
    style: source.style,
    blocks: cloneBlockInputs(source.blocks),
    linkOnParent: true,
  });
  if (input.recursive) {
    const tree = await getPageTree(db, orgId);
    const node = findTreeNode(tree, pageId);
    for (const child of node?.children ?? []) {
      await duplicateSubtree(db, orgId, createdBy, child, copy.id);
    }
  }
  return getPage(db, orgId, copy.id);
}

function findTreeNode(nodes: PageTreeNode[], pageId: string): PageTreeNode | null {
  for (const node of nodes) {
    if (node.page.id === pageId) return node;
    const nested = findTreeNode(node.children, pageId);
    if (nested) return nested;
  }
  return null;
}

async function duplicateSubtree(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  node: PageTreeNode,
  parentPageId: string,
): Promise<void> {
  const source = await getPage(db, orgId, node.page.id);
  const copy = await createPage(db, orgId, createdBy, {
    title: source.title,
    parentPageId,
    icon: source.icon,
    cover: source.cover,
    style: source.style,
    blocks: cloneBlockInputs(source.blocks),
    linkOnParent: true,
  });
  for (const child of node.children) {
    await duplicateSubtree(db, orgId, createdBy, child, copy.id);
  }
}

export async function scaffoldPages(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: ScaffoldPagesRequest,
): Promise<{ pages: WorkspacePageDetail[]; tree: PageTreeNode[] }> {
  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw workspaceValidationError([{ path: 'pages', message: 'required non-empty array' }]);
  }
  const parentPageId = await assertParentOk(db, orgId, input.parentPageId ?? null);
  const created: WorkspacePageDetail[] = [];
  const walk = async (nodes: ScaffoldPageNode[], parent: string | null): Promise<void> => {
    for (const node of nodes) {
      const title = (node.title ?? '').trim() || 'Untitled';
      const page = await createPage(db, orgId, createdBy, {
        title,
        icon: node.icon ?? null,
        cover: node.cover ?? null,
        parentPageId: parent,
        blocks: node.blocks && node.blocks.length > 0 ? node.blocks : [{ type: 'paragraph', content: '' }],
        linkOnParent: Boolean(parent),
      });
      created.push(page);
      if (node.children?.length) await walk(node.children, page.id);
    }
  };
  await walk(input.pages, parentPageId);
  return { pages: created, tree: await getPageTree(db, orgId) };
}

export async function archivePage(
  db: SqlExecutor,
  orgId: string,
  pageId: string,
): Promise<WorkspacePage> {
  await loadPageRow(db, orgId, pageId);
  const now = Date.now();
  await db.run(
    `UPDATE od_pages SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [now, now, pageId, orgId],
  );
  return normalizePage(await loadPageRow(db, orgId, pageId, { includeArchived: true }));
}

export async function findPageByLinkedRecord(
  db: SqlExecutor,
  orgId: string,
  recordId: string,
): Promise<WorkspacePage | null> {
  const row = await db.get<PageRow>(
    `SELECT ${PAGE_COLS} FROM od_pages
     WHERE workspace_id = ? AND linked_record_id = ? AND archived_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [orgId, recordId],
  );
  return row ? normalizePage(row) : null;
}

/** Open or create the notes page for a table record. */
export async function ensurePageForRecord(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: {
    recordId: string;
    tableId: string;
    title: string;
    tableName?: string;
  },
): Promise<WorkspacePageDetail> {
  const existing = await findPageByLinkedRecord(db, orgId, input.recordId);
  if (existing) return getPage(db, orgId, existing.id);
  return createPage(db, orgId, createdBy, {
    title: input.title,
    icon: '🧾',
    linkedRecordId: input.recordId,
    linkedTableId: input.tableId,
    blocks: [
      { type: 'heading_1', content: input.title },
      {
        type: 'record',
        content: input.title,
        props: { recordId: input.recordId, tableId: input.tableId },
      },
      {
        type: 'callout',
        content: input.tableName
          ? `Notes for this ${input.tableName} record. Edit freely — the table row stays the source of truth for fields.`
          : 'Notes for this record. Edit freely — the table row stays the source of truth for fields.',
      },
      { type: 'paragraph', content: '' },
    ],
  });
}

/** Agent-friendly: create or replace a page by id when provided. */
export async function upsertPageFromAgent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: CreatePageRequest & { pageId?: string },
): Promise<WorkspacePageDetail> {
  if (input.pageId) {
    const existing = await db.get<PageRow>(
      `SELECT ${PAGE_COLS} FROM od_pages WHERE id = ? AND workspace_id = ?`,
      [input.pageId, orgId],
    );
    if (existing && existing.archivedAt == null) {
      const patch: UpdatePageRequest = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.parentPageId !== undefined) patch.parentPageId = input.parentPageId;
      if (input.icon !== undefined) patch.icon = input.icon;
      if (input.cover !== undefined) patch.cover = input.cover;
      if (input.style !== undefined) patch.style = input.style;
      if (Object.keys(patch).length > 0) {
        await updatePage(db, orgId, input.pageId, patch);
      }
      if (input.blocks) {
        return setPageBlocks(db, orgId, input.pageId, { blocks: input.blocks });
      }
      return getPage(db, orgId, input.pageId);
    }
  }
  return createPage(db, orgId, createdBy, input);
}
