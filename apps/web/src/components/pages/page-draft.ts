import type { PageBlock, PageBlockInput, PageBlockType } from '@open-design/contracts';
import { MEDIA_BLOCK_TYPES } from '../../runtime/page-rich-text';

export interface DraftBlock {
  /** Stable client key (server id when known). */
  key: string;
  id?: string;
  type: PageBlockType;
  text: string;
  props: Record<string, unknown>;
  children: DraftBlock[];
  open?: boolean;
}

export interface PageIndexEntry {
  id: string;
  title: string;
  icon: string | null;
}

function newKey(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function emptyBlock(type: PageBlockType = 'paragraph'): DraftBlock {
  const block: DraftBlock = {
    key: newKey(),
    type,
    text: '',
    props: defaultProps(type),
    children: [],
    open: true,
  };
  if (type === 'column_list') {
    block.children = [emptyBlock('column'), emptyBlock('column')];
  }
  if (type === 'column') {
    block.children = [emptyBlock('paragraph')];
  }
  return block;
}

export function defaultProps(type: PageBlockType): Record<string, unknown> {
  if (type === 'to_do') return { checked: false };
  if (type === 'table') return { rows: { rows: [['', ''], ['', '']] } };
  if (type === 'callout') return { icon: '💡', color: 'default' };
  if (type === 'code') return { language: 'text' };
  if (type === 'column_list') return { columns: 2 };
  return {};
}

export function cloneBlock(block: DraftBlock): DraftBlock {
  return {
    ...block,
    key: newKey(),
    id: undefined,
    children: block.children.map(cloneBlock),
  };
}

export function blocksFromServer(blocks: PageBlock[]): DraftBlock[] {
  const walk = (list: PageBlock[]): DraftBlock[] =>
    list.map((block) => {
      const props = { ...block.props };
      let text = typeof block.content === 'string' ? block.content : '';
      if (block.type === 'table') {
        props.rows =
          typeof block.content === 'object' && block.content
            ? block.content
            : { rows: [['', ''], ['', '']] };
      }
      if (MEDIA_BLOCK_TYPES.has(block.type) && !props.url && text.trim()) {
        props.url = text.trim();
      }
      if (
        (block.type === 'database' ||
          block.type === 'page' ||
          block.type === 'record' ||
          block.type === 'artifact') &&
        text.trim()
      ) {
        if (block.type === 'database' && !props.tableId) props.tableId = text.trim();
        if (block.type === 'page' && !props.pageId) props.pageId = text.trim();
        if (block.type === 'record' && !props.recordId) props.recordId = text.trim();
        if (block.type === 'artifact' && !props.path) props.path = text.trim();
      }
      const toggleable = block.type === 'toggle' || Boolean(props.toggle);
      return {
        key: block.id,
        id: block.id,
        type: block.type,
        text,
        props,
        children: walk(block.children),
        open: toggleable ? Boolean(props.open ?? true) : true,
      };
    });
  const next = walk(blocks);
  return next.length > 0 ? next : [emptyBlock('paragraph')];
}

export function blocksToServer(blocks: DraftBlock[]): PageBlockInput[] {
  return blocks.map((block, index) => {
    const props: Record<string, unknown> = { ...block.props };
    if (block.type === 'to_do' && props.checked === undefined) props.checked = false;
    if (block.type === 'toggle' || props.toggle) props.open = Boolean(block.open);

    let content: unknown = block.text;
    if (block.type === 'divider' || block.type === 'table_of_contents' || block.type === 'breadcrumb') {
      content = null;
    }
    if (block.type === 'table') {
      content = tablePayload(block);
      delete props.rows;
    }
    if (MEDIA_BLOCK_TYPES.has(block.type) && !props.url && block.text.trim()) {
      props.url = block.text.trim();
    }
    if (block.type === 'artifact' && block.text.trim()) {
      props.path = String(props.path ?? block.text.trim());
      content = props.path;
    }
    if (block.type === 'database' && block.text.trim() && !props.tableId) {
      props.tableId = block.text.trim();
    }
    if (block.type === 'record' && block.text.trim() && !props.recordId) {
      props.recordId = block.text.trim();
    }
    if (block.type === 'page' && block.text.trim() && !props.pageId) {
      props.pageId = block.text.trim();
    }

    return {
      ...(block.id ? { id: block.id } : {}),
      type: block.type,
      content: content as PageBlockInput['content'],
      props: props as PageBlockInput['props'],
      position: index,
      children: blocksToServer(block.children),
    };
  });
}

export function stampServerIds(local: DraftBlock[], saved: PageBlock[]): DraftBlock[] {
  return local.map((block, index) => {
    const match = saved[index];
    if (!match) return block;
    return {
      ...block,
      id: match.id,
      children: stampServerIds(block.children, match.children),
    };
  });
}

export function tablePayload(block: DraftBlock): { rows: string[][] } {
  const raw = block.props.rows;
  const nested = asRecord(raw).rows;
  if (Array.isArray(nested)) {
    return { rows: nested.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [''])) };
  }
  if (Array.isArray(raw)) {
    return { rows: (raw as unknown[]).map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [''])) };
  }
  return { rows: [['', ''], ['', '']] };
}

export function tableRows(block: DraftBlock): string[][] {
  return tablePayload(block).rows;
}

export function updateAt(list: DraftBlock[], key: string, patch: Partial<DraftBlock>): DraftBlock[] {
  return list.map((block) => {
    if (block.key === key) return { ...block, ...patch };
    if (block.children.length) {
      return { ...block, children: updateAt(block.children, key, patch) };
    }
    return block;
  });
}

export function removeAt(list: DraftBlock[], key: string, keepEmpty = false): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const block of list) {
    if (block.key === key) continue;
    out.push({
      ...block,
      children: block.children.length ? removeAt(block.children, key, true) : block.children,
    });
  }
  if (keepEmpty) return out;
  return out.length > 0 ? out : [emptyBlock()];
}

export function insertAfter(list: DraftBlock[], key: string, inserted: DraftBlock): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const block of list) {
    if (block.key === key) {
      out.push(block, inserted);
      continue;
    }
    out.push({
      ...block,
      children: block.children.length ? insertAfter(block.children, key, inserted) : block.children,
    });
  }
  return out;
}

export function insertBefore(list: DraftBlock[], key: string, inserted: DraftBlock): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const block of list) {
    if (block.key === key) {
      out.push(inserted, block);
      continue;
    }
    out.push({
      ...block,
      children: insertBefore(block.children, key, inserted),
    });
  }
  return out;
}

export function findBlock(list: DraftBlock[], key: string): DraftBlock | null {
  for (const block of list) {
    if (block.key === key) return block;
    const nested = findBlock(block.children, key);
    if (nested) return nested;
  }
  return null;
}

export function isDescendant(list: DraftBlock[], ancestorKey: string, targetKey: string): boolean {
  const ancestor = findBlock(list, ancestorKey);
  if (!ancestor) return false;
  return Boolean(findBlock(ancestor.children, targetKey));
}

export interface BlockLocation {
  parentKey: string | null;
  siblings: DraftBlock[];
  index: number;
}

export function locate(list: DraftBlock[], key: string, parentKey: string | null = null): BlockLocation | null {
  const index = list.findIndex((block) => block.key === key);
  if (index >= 0) return { parentKey, siblings: list, index };
  for (const block of list) {
    const found = locate(block.children, key, block.key);
    if (found) return found;
  }
  return null;
}

export function replaceSiblings(
  list: DraftBlock[],
  parentKey: string | null,
  fn: (siblings: DraftBlock[]) => DraftBlock[],
): DraftBlock[] {
  if (parentKey === null) return fn(list);
  return list.map((block) => {
    if (block.key === parentKey) return { ...block, children: fn(block.children) };
    return { ...block, children: replaceSiblings(block.children, parentKey, fn) };
  });
}

export function indentAt(list: DraftBlock[], key: string): DraftBlock[] {
  const loc = locate(list, key);
  if (!loc || loc.index <= 0) return list;
  const prev = loc.siblings[loc.index - 1];
  const item = loc.siblings[loc.index];
  if (!prev || !item) return list;
  const nextSiblings = loc.siblings.filter((_, i) => i !== loc.index);
  nextSiblings[loc.index - 1] = {
    ...prev,
    open: true,
    children: [...prev.children, item],
  };
  return replaceSiblings(list, loc.parentKey, () => nextSiblings);
}

export function outdentAt(list: DraftBlock[], key: string): DraftBlock[] {
  const loc = locate(list, key);
  if (!loc?.parentKey) return list;
  const parentLoc = locate(list, loc.parentKey);
  if (!parentLoc) return list;
  const item = loc.siblings[loc.index];
  if (!item) return list;
  const remaining = loc.siblings.filter((_, i) => i !== loc.index);
  const parent = parentLoc.siblings[parentLoc.index];
  if (!parent) return list;
  const nextGrand = [...parentLoc.siblings];
  nextGrand[parentLoc.index] = { ...parent, children: remaining };
  nextGrand.splice(parentLoc.index + 1, 0, item);
  return replaceSiblings(list, parentLoc.parentKey, () => nextGrand);
}

export function flattenKeys(list: DraftBlock[]): string[] {
  const keys: string[] = [];
  const walk = (nodes: DraftBlock[]) => {
    for (const node of nodes) {
      keys.push(node.key);
      const toggleable = node.type === 'toggle' || Boolean(node.props.toggle);
      if (!toggleable || node.open !== false) walk(node.children);
    }
  };
  walk(list);
  return keys;
}

export function numberedIndex(siblings: DraftBlock[], key: string): number {
  let n = 0;
  for (const sibling of siblings) {
    if (sibling.type === 'numbered_list_item') n += 1;
    else n = 0;
    if (sibling.key === key) return Math.max(n, 1);
  }
  return 1;
}

export function collectHeadings(list: DraftBlock[]): Array<{ key: string; type: PageBlockType; text: string }> {
  const out: Array<{ key: string; type: PageBlockType; text: string }> = [];
  const walk = (nodes: DraftBlock[]) => {
    for (const node of nodes) {
      if (node.type === 'heading_1' || node.type === 'heading_2' || node.type === 'heading_3') {
        out.push({ key: node.key, type: node.type, text: node.text.trim() || 'Untitled' });
      }
      walk(node.children);
    }
  };
  walk(list);
  return out;
}

export function applyMarkdownShortcut(text: string): { type: PageBlockType; text: string; props?: Record<string, unknown> } | null {
  if (text === '# ') return { type: 'heading_1', text: '' };
  if (text === '## ') return { type: 'heading_2', text: '' };
  if (text === '### ') return { type: 'heading_3', text: '' };
  if (text === '- ' || text === '* ') return { type: 'bulleted_list_item', text: '' };
  if (text === '1. ' || text === '1) ') return { type: 'numbered_list_item', text: '' };
  if (text === '[] ' || text === '[ ] ' || text === '[x] ') {
    return { type: 'to_do', text: '' };
  }
  if (text === '> ') return { type: 'quote', text: '' };
  if (text === '```') return { type: 'code', text: '' };
  if (text === '---' || text === '***') return { type: 'divider', text: '' };
  if (text === '$$ ') return { type: 'equation', text: '' };
  return null;
}

export const LIST_TYPES = new Set<PageBlockType>([
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
]);

export const BASIC_TYPES = new Set<PageBlockType>([
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
  'equation',
]);

export const MEDIA_TYPES = new Set<PageBlockType>([
  'bookmark',
  'embed',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
]);

export function columnListWithCount(count: 2 | 3): DraftBlock {
  const list = emptyBlock('column_list');
  list.props.columns = count;
  list.children = Array.from({ length: count }, () => emptyBlock('column'));
  return list;
}

export function toggleHeading(level: 1 | 2 | 3): DraftBlock {
  const type = (`heading_${level}` as PageBlockType);
  const block = emptyBlock(type);
  block.props.toggle = true;
  return block;
}

export type PageTemplateId = 'blank' | 'meeting' | 'doc' | 'tasks';

export function pageTemplateBlocks(id: PageTemplateId): DraftBlock[] {
  if (id === 'meeting') {
    return [
      emptyBlockWith('heading_1', 'Meeting notes'),
      emptyBlockWith('callout', 'Date · attendees · goal'),
      emptyBlockWith('heading_2', 'Agenda'),
      emptyBlockWith('bulleted_list_item', ''),
      emptyBlockWith('heading_2', 'Notes'),
      emptyBlockWith('paragraph', ''),
      emptyBlockWith('heading_2', 'Action items'),
      emptyBlockWith('to_do', ''),
    ];
  }
  if (id === 'doc') {
    return [
      emptyBlockWith('heading_1', ''),
      emptyBlockWith('paragraph', ''),
      emptyBlockWith('heading_2', ''),
      emptyBlockWith('paragraph', ''),
    ];
  }
  if (id === 'tasks') {
    return [
      emptyBlockWith('heading_1', 'Tasks'),
      emptyBlockWith('to_do', ''),
      emptyBlockWith('to_do', ''),
      emptyBlockWith('to_do', ''),
    ];
  }
  return [emptyBlock('paragraph')];
}

function emptyBlockWith(type: PageBlockType, text: string): DraftBlock {
  const block = emptyBlock(type);
  block.text = text;
  return block;
}
