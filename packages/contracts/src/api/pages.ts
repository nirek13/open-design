// Organization pages: Notion-shaped notes with a block tree.
//
// Pages are soft documents (like workspace tables, unlike the ledger). They
// nest, hold typed blocks, and can embed a live workspace table or point at a
// design artifact. Agents and people share the same DTOs and HTTP surface.
//
// Block kinds follow Notion's public block vocabulary where it maps cleanly
// (see https://developers.notion.com/reference/block). Substrate-specific
// kinds (`database`, `artifact`) bridge into org tables and design files.

import type { JsonValue } from '../common.js';

/** Block kinds the editor and agent may emit. Unknown kinds are rejected at
 * the write boundary so a typo cannot poison the tree. */
export const PAGE_BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'callout',
  'quote',
  'code',
  'divider',
  'bookmark',
  /** Live iframe/media embed of any URL, slide, app, or design preview. */
  'embed',
  /** Small inline grid owned by the page (not a workspace table). */
  'table',
  /** Live embed of an organization workspace table (+ optional saved view). */
  'database',
  /** Link to a project design file the agent or person built. */
  'artifact',
  /** Pointer to another page (shown as a link / child card). */
  'page',
  /** Live card for one ERP / workspace record. */
  'record',
] as const;

export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

/** Slash-menu catalogue: label + hint for the Notion-style `/` picker. */
export const PAGE_BLOCK_CATALOG: ReadonlyArray<{
  type: PageBlockType;
  label: string;
  hint: string;
  keywords: readonly string[];
}> = [
  { type: 'paragraph', label: 'Text', hint: 'Plain body text', keywords: ['text', 'paragraph', 'p'] },
  { type: 'heading_1', label: 'Heading 1', hint: 'Large section title', keywords: ['h1', 'title', 'heading'] },
  { type: 'heading_2', label: 'Heading 2', hint: 'Medium section title', keywords: ['h2', 'heading'] },
  { type: 'heading_3', label: 'Heading 3', hint: 'Small section title', keywords: ['h3', 'heading'] },
  { type: 'bulleted_list_item', label: 'Bulleted list', hint: 'Simple list', keywords: ['bullet', 'ul', 'list'] },
  { type: 'numbered_list_item', label: 'Numbered list', hint: '1, 2, 3…', keywords: ['number', 'ol', 'list'] },
  { type: 'to_do', label: 'To-do', hint: 'Track a task with a checkbox', keywords: ['todo', 'task', 'check'] },
  { type: 'toggle', label: 'Toggle', hint: 'Hide nested content behind a disclosure', keywords: ['toggle', 'collapse', 'disclosure'] },
  { type: 'callout', label: 'Callout', hint: 'Highlighted note', keywords: ['callout', 'info', 'note'] },
  { type: 'quote', label: 'Quote', hint: 'Capture a quotation', keywords: ['quote', 'blockquote'] },
  { type: 'code', label: 'Code', hint: 'Code snippet', keywords: ['code', 'pre'] },
  { type: 'divider', label: 'Divider', hint: 'Visual break', keywords: ['divider', 'hr', 'line'] },
  { type: 'bookmark', label: 'Bookmark', hint: 'Save a link with a preview card', keywords: ['bookmark', 'link', 'url'] },
  {
    type: 'embed',
    label: 'Embed',
    hint: 'Live YouTube, Figma, or anything you created — apps, pictures, videos, slides',
    keywords: [
      'embed',
      'iframe',
      'youtube',
      'figma',
      'notion',
      'video',
      'slides',
      'docs',
      'app',
      'pdf',
      'picture',
      'photo',
      'image',
      'mp4',
      'deck',
    ],
  },
  { type: 'table', label: 'Simple table', hint: 'Inline grid on this page', keywords: ['table', 'grid'] },
  { type: 'database', label: 'Database', hint: 'Embed an org workspace table', keywords: ['database', 'data', 'workspace'] },
  {
    type: 'artifact',
    label: 'Design file',
    hint: 'Embed an app, picture, video, or slides you created',
    keywords: ['artifact', 'design', 'html', 'app', 'image', 'video', 'slides', 'deck', 'picture'],
  },
  { type: 'page', label: 'Sub-page', hint: 'Create or embed a nested page', keywords: ['page', 'subpage', 'wiki', 'child'] },
  { type: 'record', label: 'ERP record', hint: 'Embed one business record', keywords: ['record', 'erp', 'invoice', 'deal'] },
];

export interface WorkspacePage {
  id: string;
  orgId: string;
  parentPageId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  /** Optional ERP/workspace record this page documents. */
  linkedRecordId: string | null;
  linkedTableId: string | null;
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** A page plus its ordered top-level blocks (children nested). */
export interface WorkspacePageDetail extends WorkspacePage {
  blocks: PageBlock[];
}

export interface PageBlock {
  id: string;
  pageId: string;
  parentBlockId: string | null;
  type: PageBlockType;
  /** Primary text / rich payload. Shape depends on `type`. */
  content: JsonValue;
  /** Type-specific options (checked, language, tableId, …). */
  props: Record<string, JsonValue>;
  position: number;
  children: PageBlock[];
  createdAt: number;
  updatedAt: number;
}

/** Flat write shape agents prefer — parent/children expressed by ids. */
export interface PageBlockInput {
  id?: string;
  parentBlockId?: string | null;
  type: PageBlockType;
  content?: JsonValue;
  props?: Record<string, JsonValue>;
  position?: number;
  children?: PageBlockInput[];
}

export interface CreatePageRequest {
  title?: string;
  parentPageId?: string | null;
  icon?: string | null;
  cover?: string | null;
  linkedRecordId?: string | null;
  linkedTableId?: string | null;
  /** Optional initial block tree. Empty page gets one empty paragraph. */
  blocks?: PageBlockInput[];
  /**
   * When creating a child page, also append a `page` embed on the parent
   * (Notion's "page in a page"). Default true.
   */
  linkOnParent?: boolean;
}

export interface UpdatePageRequest {
  title?: string;
  parentPageId?: string | null;
  icon?: string | null;
  cover?: string | null;
  linkedRecordId?: string | null;
  linkedTableId?: string | null;
  position?: number;
}

export interface SetPageBlocksRequest {
  blocks: PageBlockInput[];
}

export interface ListPagesQuery {
  /** When set, only direct children of this page. `root` = top-level. */
  parentPageId?: string | 'root';
  includeArchived?: boolean;
}

/** Sidebar tree node — title + nesting, no block bodies. */
export interface PageTreeNode {
  page: WorkspacePage;
  children: PageTreeNode[];
}

/** Nested wiki node the agent (or a person) can scaffold in one call. */
export interface ScaffoldPageNode {
  title: string;
  icon?: string | null;
  cover?: string | null;
  blocks?: PageBlockInput[];
  children?: ScaffoldPageNode[];
}

export interface ScaffoldPagesRequest {
  parentPageId?: string | null;
  pages: ScaffoldPageNode[];
}

export interface AppendPageBlocksRequest {
  blocks: PageBlockInput[];
}

export type PageEmbedKind = 'page' | 'database' | 'record' | 'artifact' | 'bookmark' | 'embed';

export interface EmbedPageBlockRequest {
  type: PageEmbedKind;
  /** Page to embed when `type` is `page`. */
  targetPageId?: string;
  tableId?: string;
  recordId?: string;
  path?: string;
  url?: string;
}

export interface DuplicatePageRequest {
  recursive?: boolean;
}

export interface SearchPagesQuery {
  query: string;
  limit?: number;
}

export interface SearchPagesHit {
  page: WorkspacePage;
  snippet: string | null;
}
