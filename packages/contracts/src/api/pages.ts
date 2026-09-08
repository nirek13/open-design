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
import { PAGE_TOOL_TYPES } from './page-tools.js';

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
  /** Dedicated image with optional caption (Notion `image`). */
  'image',
  /** Dedicated video with optional caption. */
  'video',
  /** Dedicated audio player. */
  'audio',
  /** File attachment card. */
  'file',
  /** Inline PDF viewer. */
  'pdf',
  /** Block equation (LaTeX). */
  'equation',
  /** Auto table of contents from headings on this page. */
  'table_of_contents',
  /** Ancestor trail for the current page. */
  'breadcrumb',
  /** Horizontal column layout. Children are `column` blocks. */
  'column_list',
  /** One column inside a `column_list`. */
  'column',
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
  /** Inline working tools (kanban, checklist, assigner, …). */
  ...PAGE_TOOL_TYPES,
] as const;

export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

/** Notion-style page appearance. Stored as JSON on the page row. */
export const PAGE_FONTS = ['default', 'serif', 'mono'] as const;
export type PageFont = (typeof PAGE_FONTS)[number];

export const PAGE_COLOR_IDS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type PageColorId = (typeof PAGE_COLOR_IDS)[number];

export interface PageStyle {
  font?: PageFont;
  smallText?: boolean;
  fullWidth?: boolean;
  locked?: boolean;
}

export const DEFAULT_PAGE_STYLE: Required<PageStyle> = {
  font: 'default',
  smallText: false,
  fullWidth: false,
  locked: false,
};

/**
 * Who in the organization can open a page.
 *
 * `public` — every active member. `private` — only the creator.
 * Not internet-public; pages never leave the organization.
 */
export const PAGE_VISIBILITIES = ['public', 'private'] as const;
export type PageVisibility = (typeof PAGE_VISIBILITIES)[number];
export const DEFAULT_PAGE_VISIBILITY: PageVisibility = 'public';

export function parsePageVisibility(value: unknown): PageVisibility {
  return value === 'private' ? 'private' : 'public';
}

export function isPageVisibility(value: unknown): value is PageVisibility {
  return value === 'public' || value === 'private';
}

export function parsePageStyle(value: unknown): PageStyle {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const font = PAGE_FONTS.includes(raw.font as PageFont) ? (raw.font as PageFont) : undefined;
  return {
    ...(font ? { font } : {}),
    ...(typeof raw.smallText === 'boolean' ? { smallText: raw.smallText } : {}),
    ...(typeof raw.fullWidth === 'boolean' ? { fullWidth: raw.fullWidth } : {}),
    ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
  };
}

export const PAGE_CODE_LANGUAGES = [
  'text',
  'javascript',
  'typescript',
  'python',
  'json',
  'html',
  'css',
  'sql',
  'bash',
  'markdown',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
] as const;

export type PageCodeLanguage = (typeof PAGE_CODE_LANGUAGES)[number];

export const PAGE_CALLOUT_ICONS = ['💡', '⚠️', '✅', '❌', '🔥', '💬', '📌', '⭐', '🧠', '📎', '📝', '🚀'] as const;

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
  { type: 'image', label: 'Image', hint: 'Upload or paste a picture', keywords: ['image', 'photo', 'picture', 'img', 'png', 'jpg'] },
  { type: 'video', label: 'Video', hint: 'YouTube, mp4, or a clip you created', keywords: ['video', 'youtube', 'mp4', 'movie'] },
  { type: 'audio', label: 'Audio', hint: 'Sound, voice note, or music', keywords: ['audio', 'sound', 'mp3', 'voice'] },
  { type: 'file', label: 'File', hint: 'Attach a downloadable file', keywords: ['file', 'attachment', 'download'] },
  { type: 'pdf', label: 'PDF', hint: 'Inline PDF preview', keywords: ['pdf', 'document'] },
  { type: 'equation', label: 'Block equation', hint: 'Display a math formula', keywords: ['equation', 'math', 'latex', 'tex', 'formula'] },
  {
    type: 'table_of_contents',
    label: 'Table of contents',
    hint: 'List of headings on this page',
    keywords: ['toc', 'contents', 'outline', 'headings'],
  },
  { type: 'breadcrumb', label: 'Breadcrumb', hint: 'Show the page path', keywords: ['breadcrumb', 'path', 'ancestors'] },
  {
    type: 'column_list',
    label: 'Columns',
    hint: 'Split the page into 2 or 3 columns',
    keywords: ['columns', 'column', 'layout', 'split', '2col', '3col'],
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
  { type: 'record', label: 'Record', hint: 'Embed one table row', keywords: ['record', 'row', 'invoice', 'deal'] },
  {
    type: 'board',
    label: 'Board',
    hint: 'Drag cards across columns',
    keywords: ['kanban', 'board', 'drag', 'sprint', 'trello', 'columns'],
  },
  {
    type: 'checklist',
    label: 'To-do list',
    hint: 'A checklist with progress',
    keywords: ['todo', 'checklist', 'tasks', 'list', 'progress'],
  },
  {
    type: 'assigner',
    label: 'Task assigner',
    hint: 'Give work an owner and a status',
    keywords: ['assign', 'owner', 'who', 'task', 'people', 'assignee'],
  },
  {
    type: 'poll',
    label: 'Poll',
    hint: 'Vote on options',
    keywords: ['poll', 'vote', 'survey', 'choose'],
  },
  {
    type: 'timeline',
    label: 'Timeline',
    hint: 'Milestones on a date line',
    keywords: ['timeline', 'milestone', 'roadmap', 'schedule', 'dates'],
  },
  {
    type: 'decision',
    label: 'Decision',
    hint: 'Capture a choice and why',
    keywords: ['decision', 'choose', 'adr', 'options', 'pick'],
  },
  {
    type: 'goals',
    label: 'Goals',
    hint: 'Track progress toward a target',
    keywords: ['goal', 'okr', 'progress', 'kpi', 'target'],
  },
  {
    type: 'spreadsheet',
    label: 'Spreadsheet',
    hint: 'Grid with formulas like =SUM(A1:A4)',
    keywords: ['spreadsheet', 'sheet', 'excel', 'formula', 'cells', 'numbers', 'calc'],
  },
  {
    type: 'budget',
    label: 'Budget',
    hint: 'Income and expenses with a running total',
    keywords: ['budget', 'money', 'expense', 'income', 'finance', 'spend', 'ledger'],
  },
  {
    type: 'calendar',
    label: 'Calendar',
    hint: 'A month of dated events',
    keywords: ['calendar', 'month', 'events', 'dates', 'agenda'],
  },
  {
    type: 'habit',
    label: 'Habit tracker',
    hint: 'Daily check-ins for habits',
    keywords: ['habit', 'streak', 'daily', 'tracker', 'routine'],
  },
  {
    type: 'countdown',
    label: 'Countdown',
    hint: 'Days until a date',
    keywords: ['countdown', 'days', 'until', 'deadline', 'launch'],
  },
  {
    type: 'schedule',
    label: 'Weekly schedule',
    hint: 'Plan the week by day and time',
    keywords: ['schedule', 'week', 'planner', 'timetable', 'slots'],
  },
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
  /** Font, width, lock — Notion's "Customize page". */
  style: PageStyle;
  /** Org-wide (`public`) or creator-only (`private`). */
  visibility: PageVisibility;
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
  style?: PageStyle;
  /** Defaults to the parent's visibility, or `public` at the root. */
  visibility?: PageVisibility;
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
  style?: PageStyle;
  visibility?: PageVisibility;
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
  visibility?: PageVisibility;
  blocks?: PageBlockInput[];
  children?: ScaffoldPageNode[];
}

/** Rebuild a tree, hoisting pages whose parent is missing from the set. */
export function buildPageTree(pages: WorkspacePage[]): PageTreeNode[] {
  const ids = new Set(pages.map((page) => page.id));
  const byParent = new Map<string | null, WorkspacePage[]>();
  for (const page of pages) {
    const parentId = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : null;
    const list = byParent.get(parentId) ?? [];
    list.push(page);
    byParent.set(parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }
  const walk = (parentId: string | null): PageTreeNode[] =>
    (byParent.get(parentId) ?? []).map((page) => ({ page, children: walk(page.id) }));
  return walk(null);
}

function flattenPageTree(nodes: PageTreeNode[]): WorkspacePage[] {
  const pages: WorkspacePage[] = [];
  const walk = (list: PageTreeNode[]) => {
    for (const node of list) {
      pages.push(node.page);
      walk(node.children);
    }
  };
  walk(nodes);
  return pages;
}

/** Split a mixed tree into Public and Private sidebar sections. */
export function partitionPageTree(nodes: PageTreeNode[]): {
  publicPages: PageTreeNode[];
  privatePages: PageTreeNode[];
} {
  const pages = flattenPageTree(nodes);
  return {
    publicPages: buildPageTree(pages.filter((page) => page.visibility !== 'private')),
    privatePages: buildPageTree(pages.filter((page) => page.visibility === 'private')),
  };
}

export interface ScaffoldPagesRequest {
  parentPageId?: string | null;
  pages: ScaffoldPageNode[];
}

export interface AppendPageBlocksRequest {
  blocks: PageBlockInput[];
}

export type PageEmbedKind =
  | 'page'
  | 'database'
  | 'record'
  | 'artifact'
  | 'bookmark'
  | 'embed'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'pdf';

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
