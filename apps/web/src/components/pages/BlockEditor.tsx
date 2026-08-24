'use client';

// Notion-style block canvas for organization pages.
//
// Interaction model follows Notion's public editor:
// `/` opens a type picker; Enter splits / creates a sibling; empty Backspace
// deletes or turns the block back into a paragraph; Tab / Shift+Tab nest;
// markdown prefixes (`# `, `- `, `[] `, `> `, ```) convert the block.
// Nested children are first-class. Persist through the pages API.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  PAGE_BLOCK_CATALOG,
  type PageBlock,
  type PageBlockInput,
  type PageBlockType,
} from '@open-design/contracts';
import { Icon } from '../Icon';
import styles from './BlockEditor.module.css';
import { DatabaseEmbed, RecordEmbed } from './Embeds';
import { EmbedComposer, RichEmbed } from './RichEmbed';
import { looksLikeUrl } from '../../runtime/rich-embed';
import {
  isPageMakeKind,
  PAGE_MAKE_ACTIONS,
  pageMakeAction,
  type PageMakeKind,
} from '../../runtime/page-make';

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

interface SlashState {
  blockKey: string;
  query: string;
  index: number;
}

interface MenuState {
  blockKey: string;
}

interface DropState {
  key: string;
  edge: 'before' | 'after';
}

interface Props {
  blocks: DraftBlock[];
  onChange: (blocks: DraftBlock[]) => void;
  readOnly?: boolean;
  orgId?: string | null;
  pages?: PageIndexEntry[];
  onOpenPage?: (pageId: string) => void;
  /** Slash `/page` and the page picker can mint a real nested page. */
  onCreateSubpage?: () => Promise<{ id: string; title: string; icon: string | null } | null>;
  /** Slash Make app/picture/video/slides generates a unique file and embeds it. */
  onMake?: (kind: PageMakeKind, prompt: string) => void;
}

const ICONS: Partial<Record<PageBlockType, string>> = {
  paragraph: '¶',
  heading_1: 'H1',
  heading_2: 'H2',
  heading_3: 'H3',
  bulleted_list_item: '•',
  numbered_list_item: '1.',
  to_do: '☑',
  toggle: '▸',
  callout: '💡',
  quote: '❝',
  code: '</>',
  divider: '—',
  bookmark: '🔗',
  embed: '▣',
  table: '▦',
  database: '▤',
  artifact: '◇',
  page: '📄',
  record: '🧾',
};

const LIST_TYPES = new Set<PageBlockType>([
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
]);

const BASIC_TYPES = new Set<PageBlockType>([
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
]);

function newKey(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function blocksFromServer(blocks: PageBlock[]): DraftBlock[] {
  const walk = (list: PageBlock[]): DraftBlock[] =>
    list.map((block) => {
      const props = { ...block.props };
      let text = typeof block.content === 'string' ? block.content : '';
      if (block.type === 'table') {
        props.rows = typeof block.content === 'object' && block.content ? block.content : { rows: [['', ''], ['', '']] };
      }
      if (block.type === 'bookmark' && !props.url && text.trim()) {
        props.url = text.trim();
      }
      if (block.type === 'embed' && !props.url && text.trim()) {
        props.url = text.trim();
      }
      if ((block.type === 'database' || block.type === 'page' || block.type === 'record' || block.type === 'artifact') && text.trim()) {
        if (block.type === 'database' && !props.tableId) props.tableId = text.trim();
        if (block.type === 'page' && !props.pageId) props.pageId = text.trim();
        if (block.type === 'record' && !props.recordId) props.recordId = text.trim();
        if (block.type === 'artifact' && !props.path) props.path = text.trim();
      }
      return {
        key: block.id,
        id: block.id,
        type: block.type,
        text,
        props,
        children: walk(block.children),
        open: block.type === 'toggle' ? Boolean(props.open ?? true) : true,
      };
    });
  const next = walk(blocks);
  return next.length > 0 ? next : [emptyBlock('paragraph')];
}

export function blocksToServer(blocks: DraftBlock[]): PageBlockInput[] {
  return blocks.map((block, index) => {
    const props: Record<string, unknown> = { ...block.props };
    if (block.type === 'to_do' && props.checked === undefined) props.checked = false;
    if (block.type === 'toggle') props.open = Boolean(block.open);

    let content: unknown = block.text;
    if (block.type === 'divider') content = null;
    if (block.type === 'table') {
      content = tablePayload(block);
      delete props.rows;
    }
    if (block.type === 'bookmark' && !props.url && block.text.trim()) {
      props.url = block.text.trim();
    }
    if (block.type === 'embed' && !props.url && block.text.trim()) {
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

/** Keep client keys stable after a round-trip so the caret does not jump. */
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

export function emptyBlock(type: PageBlockType = 'paragraph'): DraftBlock {
  return {
    key: newKey(),
    type,
    text: '',
    props:
      type === 'to_do'
        ? { checked: false }
        : type === 'table'
          ? { rows: { rows: [['', ''], ['', '']] } }
          : {},
    children: [],
    open: true,
  };
}

function cloneBlock(block: DraftBlock): DraftBlock {
  return {
    ...block,
    key: newKey(),
    id: undefined,
    children: block.children.map(cloneBlock),
  };
}

function defaultProps(type: PageBlockType): Record<string, unknown> {
  if (type === 'to_do') return { checked: false };
  if (type === 'table') return { rows: { rows: [['', ''], ['', '']] } };
  return {};
}

function tablePayload(block: DraftBlock): { rows: string[][] } {
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

function tableRows(block: DraftBlock): string[][] {
  return tablePayload(block).rows;
}

function updateAt(list: DraftBlock[], key: string, patch: Partial<DraftBlock>): DraftBlock[] {
  return list.map((block) => {
    if (block.key === key) return { ...block, ...patch };
    if (block.children.length) {
      return { ...block, children: updateAt(block.children, key, patch) };
    }
    return block;
  });
}

function removeAt(list: DraftBlock[], key: string, keepEmpty = false): DraftBlock[] {
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

function insertAfter(list: DraftBlock[], key: string, inserted: DraftBlock): DraftBlock[] {
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

function insertBefore(list: DraftBlock[], key: string, inserted: DraftBlock): DraftBlock[] {
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

function findBlock(list: DraftBlock[], key: string): DraftBlock | null {
  for (const block of list) {
    if (block.key === key) return block;
    const nested = findBlock(block.children, key);
    if (nested) return nested;
  }
  return null;
}

function isDescendant(list: DraftBlock[], ancestorKey: string, targetKey: string): boolean {
  const ancestor = findBlock(list, ancestorKey);
  if (!ancestor) return false;
  return Boolean(findBlock(ancestor.children, targetKey));
}

interface Location {
  parentKey: string | null;
  siblings: DraftBlock[];
  index: number;
}

function locate(list: DraftBlock[], key: string, parentKey: string | null = null): Location | null {
  const index = list.findIndex((block) => block.key === key);
  if (index >= 0) return { parentKey, siblings: list, index };
  for (const block of list) {
    const found = locate(block.children, key, block.key);
    if (found) return found;
  }
  return null;
}

function replaceSiblings(
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

function indentAt(list: DraftBlock[], key: string): DraftBlock[] {
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

function outdentAt(list: DraftBlock[], key: string): DraftBlock[] {
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

function flattenKeys(list: DraftBlock[]): string[] {
  const keys: string[] = [];
  const walk = (nodes: DraftBlock[]) => {
    for (const node of nodes) {
      keys.push(node.key);
      if (node.type !== 'toggle' || node.open !== false) walk(node.children);
    }
  };
  walk(list);
  return keys;
}

function numberedIndex(siblings: DraftBlock[], key: string): number {
  let n = 0;
  for (const sibling of siblings) {
    if (sibling.type === 'numbered_list_item') n += 1;
    else n = 0;
    if (sibling.key === key) return Math.max(n, 1);
  }
  return 1;
}

type SlashItem =
  | {
      source: 'make';
      kind: PageMakeKind;
      label: string;
      hint: string;
      glyph: string;
    }
  | {
      source: 'block';
      type: PageBlockType;
      label: string;
      hint: string;
      glyph: string;
    };

function matchesSlashQuery(
  label: string,
  hint: string,
  keywords: readonly string[],
  extra: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${label} ${hint} ${keywords.join(' ')} ${extra}`.toLowerCase();
  return hay.includes(q);
}

function filterSlashItems(query: string): SlashItem[] {
  const makeItems: SlashItem[] = PAGE_MAKE_ACTIONS.filter((action) =>
    matchesSlashQuery(action.label, action.hint, action.keywords, action.kind, query),
  ).map((action) => ({
    source: 'make',
    kind: action.kind,
    label: action.label,
    hint: action.hint,
    glyph: action.glyph,
  }));
  const blocks: SlashItem[] = PAGE_BLOCK_CATALOG.filter((item) =>
    matchesSlashQuery(item.label, item.hint, item.keywords, item.type, query),
  ).map((item) => ({
    source: 'block',
    type: item.type,
    label: item.label,
    hint: item.hint,
    glyph: ICONS[item.type] ?? '¶',
  }));
  return [...makeItems, ...blocks];
}

export function applyMarkdownShortcut(text: string): { type: PageBlockType; text: string } | null {
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
  return null;
}

function placeholderFor(type: PageBlockType): string {
  switch (type) {
    case 'heading_1':
      return 'Heading 1';
    case 'heading_2':
      return 'Heading 2';
    case 'heading_3':
      return 'Heading 3';
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return 'List';
    case 'to_do':
      return 'To-do';
    case 'toggle':
      return 'Toggle';
    case 'callout':
      return 'Callout';
    case 'quote':
      return 'Empty quote';
    case 'code':
      return 'Code';
    case 'bookmark':
      return 'Paste a URL…';
    case 'embed':
      return 'Paste a URL, pick created work, or make a unique app, picture, video, or slides';
    case 'database':
      return 'Workspace table id…';
    case 'artifact':
      return 'Pick a created app, picture, video, or slides — or paste a path';
    case 'page':
      return 'Search or paste a page id…';
    case 'record':
      return 'Record id…';
    default:
      return "Type '/' for commands";
  }
}

function caretOffset(node: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return node.textContent?.length ?? 0;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(node);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function wrapSelection(node: HTMLElement, before: string, after: string): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = node.textContent ?? '';
  const start = caretOffset(node);
  const range = sel.getRangeAt(0);
  const endRange = range.cloneRange();
  const pre = document.createRange();
  pre.selectNodeContents(node);
  pre.setEnd(endRange.endContainer, endRange.endOffset);
  const end = pre.toString().length;
  const selected = text.slice(start, end);
  const next = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`;
  node.textContent = next;
  return next;
}

export function BlockEditor({
  blocks,
  onChange,
  readOnly,
  orgId,
  pages = [],
  onOpenPage,
  onCreateSubpage,
  onMake,
}: Props) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(blocks[0]?.key ?? null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const prevFocus = useRef<string | null>(null);

  const slashItems = useMemo(() => (slash ? filterSlashItems(slash.query) : []), [slash]);
  const makeSlash = slashItems.filter((item) => item.source === 'make');
  const basicSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' && BASIC_TYPES.has(item.type),
  );
  const otherSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' && !BASIC_TYPES.has(item.type),
  );

  useEffect(() => {
    if (!focusKey || focusKey === prevFocus.current) return;
    prevFocus.current = focusKey;
    const node = refs.current.get(focusKey);
    if (!node) return;
    node.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [focusKey]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (event.target as HTMLElement).closest?.('[data-block-menu]')) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menu]);

  const applyType = useCallback(
    (key: string, type: PageBlockType, nextText?: string, extraProps?: Record<string, unknown>) => {
      const current = findBlock(blocks, key);
      if (!current) return;
      let next = updateAt(blocks, key, {
        type,
        text: type === 'divider' ? '' : nextText !== undefined ? nextText : current.text,
        props: { ...defaultProps(type), ...extraProps },
      });
      if (type === 'divider') {
        const after = emptyBlock('paragraph');
        next = insertAfter(next, key, after);
        setFocusKey(after.key);
      } else {
        setFocusKey(key);
      }
      onChange(next);
      const node = refs.current.get(key);
      if (node && type !== 'divider') node.textContent = nextText !== undefined ? nextText : current.text;
    },
    [blocks, onChange],
  );

  const applySlash = useCallback(
    (item: SlashItem) => {
      if (!slash) return;
      const key = slash.blockKey;
      setSlash(null);
      if (item.source === 'make') {
        applyType(key, 'embed', '', { makeKind: item.kind });
        return;
      }
      const type = item.type;
      if (type === 'page' && onCreateSubpage) {
        void (async () => {
          const created = await onCreateSubpage();
          if (!created) {
            applyType(key, 'page', '');
            return;
          }
          applyType(key, 'page', created.title, {
            pageId: created.id,
            ...(created.icon ? { icon: created.icon } : {}),
          });
        })();
        return;
      }
      applyType(key, type, '');
    },
    [applyType, onCreateSubpage, slash],
  );

  const submitMake = (key: string, kind: PageMakeKind, prompt: string) => {
    const action = pageMakeAction(kind);
    applyType(key, 'callout', `Making a unique ${action.noun}: ${prompt}`);
    onMake?.(kind, prompt);
  };

  const onText = (key: string, text: string, node?: HTMLElement) => {
    const md = applyMarkdownShortcut(text);
    if (md) {
      applyType(key, md.type, md.text);
      if (node) node.textContent = md.text;
      setSlash(null);
      return;
    }
    const current = findBlock(blocks, key);
    const props = { ...(current?.props ?? {}) };
    if (current?.type === 'database' && text.trim()) props.tableId = text.trim();
    if (current?.type === 'record' && text.trim()) props.recordId = text.trim();
    if (current?.type === 'artifact' && text.trim()) props.path = text.trim();
    if (current?.type === 'bookmark' && text.trim()) props.url = text.trim();
    if (current?.type === 'embed' && text.trim()) props.url = text.trim();
    if (current?.type === 'page' && text.trim()) props.pageId = text.trim();
    onChange(updateAt(blocks, key, { text, props }));
    if (text.startsWith('/')) {
      setSlash({ blockKey: key, query: text.slice(1), index: 0 });
    } else if (slash?.blockKey === key) {
      setSlash(null);
    }
  };

  const onKeyDown = (block: DraftBlock, event: ReactKeyboardEvent<HTMLElement>) => {
    const node = event.currentTarget;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      const next = wrapSelection(node, '**', '**');
      if (next !== null) {
        event.preventDefault();
        onChange(updateAt(blocks, block.key, { text: next }));
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
      const next = wrapSelection(node, '*', '*');
      if (next !== null) {
        event.preventDefault();
        onChange(updateAt(blocks, block.key, { text: next }));
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      const next = wrapSelection(node, '`', '`');
      if (next !== null) {
        event.preventDefault();
        onChange(updateAt(blocks, block.key, { text: next }));
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && block.type === 'to_do') {
      event.preventDefault();
      onChange(
        updateAt(blocks, block.key, {
          props: { ...block.props, checked: !block.props.checked },
        }),
      );
      return;
    }

    if (slash && slashItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlash({ ...slash, index: (slash.index + 1) % slashItems.length });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlash({
          ...slash,
          index: (slash.index - 1 + slashItems.length) % slashItems.length,
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const pick = slashItems[slash.index] ?? slashItems[0];
        if (pick) applySlash(pick);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlash(null);
        return;
      }
    }

    if (event.key === 'Escape') {
      setMenu(null);
      setSlash(null);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      onChange(event.shiftKey ? outdentAt(blocks, block.key) : indentAt(blocks, block.key));
      setFocusKey(block.key);
      prevFocus.current = block.key;
      return;
    }

    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      const offset = caretOffset(node);
      const nextText = `${block.text.slice(0, offset)}\n${block.text.slice(offset)}`;
      node.textContent = nextText;
      onChange(updateAt(blocks, block.key, { text: nextText }));
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (LIST_TYPES.has(block.type) && block.text === '') {
        if (locate(blocks, block.key)?.parentKey) {
          onChange(outdentAt(blocks, block.key));
        } else {
          onChange(updateAt(blocks, block.key, { type: 'paragraph', props: {} }));
        }
        setFocusKey(block.key);
        prevFocus.current = block.key;
        return;
      }
      const offset = caretOffset(node);
      const before = block.text.slice(0, offset);
      const after = block.text.slice(offset);
      const created = emptyBlock(
        LIST_TYPES.has(block.type) || block.type === 'toggle' ? block.type : 'paragraph',
      );
      created.text = after;
      if (block.type === 'toggle' && offset >= block.text.length) {
        const child = emptyBlock('paragraph');
        onChange(
          updateAt(blocks, block.key, {
            open: true,
            children: [...block.children, child],
          }),
        );
        setFocusKey(child.key);
        return;
      }
      node.textContent = before;
      onChange(insertAfter(updateAt(blocks, block.key, { text: before }), block.key, created));
      setFocusKey(created.key);
      return;
    }

    if (event.key === 'Backspace') {
      const atStart = caretOffset(node) === 0;
      if (!atStart) return;
      event.preventDefault();
      if (block.type !== 'paragraph' && block.type !== 'divider' && block.text === '') {
        onChange(updateAt(blocks, block.key, { type: 'paragraph', props: {} }));
        return;
      }
      const keys = flattenKeys(blocks);
      const idx = keys.indexOf(block.key);
      const prev = idx > 0 ? keys[idx - 1] : null;
      if (prev && block.text !== '') {
        const previous = findBlock(blocks, prev);
        if (previous && previous.type !== 'divider') {
          const merged = previous.text + block.text;
          const without = removeAt(updateAt(blocks, prev, { text: merged }), block.key);
          onChange(without);
          setFocusKey(prev);
          return;
        }
      }
      if (block.text === '') {
        onChange(removeAt(blocks, block.key));
        if (prev) setFocusKey(prev);
      }
      return;
    }

    if (event.key === '/' && block.text === '') {
      setSlash({ blockKey: block.key, query: '', index: 0 });
    }
  };

  const dropBlock = (targetKey: string, edge: 'before' | 'after') => {
    if (!dragging || dragging === targetKey) return;
    if (isDescendant(blocks, dragging, targetKey)) return;
    const taken = findBlock(blocks, dragging);
    if (!taken) return;
    const stripped = removeAt(blocks, dragging, true);
    const next = edge === 'before' ? insertBefore(stripped, targetKey, taken) : insertAfter(stripped, targetKey, taken);
    onChange(next.length > 0 ? next : [emptyBlock()]);
    setDragging(null);
    setDrop(null);
  };

  const addBelow = (key: string) => {
    const created = emptyBlock('paragraph');
    onChange(insertAfter(blocks, key, created));
    setFocusKey(created.key);
    setSlash({ blockKey: created.key, query: '', index: 0 });
    setMenu(null);
  };

  const renderSlash = (blockKey: string) => {
    if (slash?.blockKey !== blockKey) return null;
    return (
      <div className={styles.slashMenu} role="listbox" data-testid="pages-slash">
        {slashItems.length === 0 ? (
          <div className={styles.slashEmpty}>No results</div>
        ) : (
          <>
            {makeSlash.length > 0 ? <div className={styles.slashTitle}>Make</div> : null}
            {makeSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {basicSlash.length > 0 ? <div className={styles.slashTitle}>Basic blocks</div> : null}
            {basicSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {otherSlash.length > 0 ? <div className={styles.slashTitle}>Advanced</div> : null}
            {otherSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
          </>
        )}
      </div>
    );
  };

  const renderSlashItem = (item: SlashItem, index: number) => (
    <button
      key={item.source === 'make' ? `make-${item.kind}` : item.type}
      type="button"
      role="option"
      aria-selected={index === slash?.index}
      className={`${styles.slashItem}${index === slash?.index ? ` ${styles.slashActive}` : ''}`}
      onMouseDown={(event) => {
        event.preventDefault();
        applySlash(item);
      }}
    >
      <span className={styles.slashGlyph}>{item.glyph}</span>
      <span className={styles.slashCopy}>
        <strong>{item.label}</strong>
        <span>{item.hint}</span>
      </span>
    </button>
  );

  const renderMenu = (block: DraftBlock) => {
    if (menu?.blockKey !== block.key) return null;
    return (
      <div className={styles.blockMenu} data-block-menu data-testid="pages-block-menu">
        <button type="button" className={styles.menuItem} onClick={() => addBelow(block.key)}>
          Insert below
        </button>
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => {
            onChange(insertAfter(blocks, block.key, cloneBlock(block)));
            setMenu(null);
          }}
        >
          Duplicate
        </button>
        <div className={styles.menuLabel}>Turn into</div>
        {PAGE_BLOCK_CATALOG.slice(0, 14).map((item) => (
          <button
            key={item.type}
            type="button"
            className={styles.menuItem}
            onClick={() => {
              applyType(block.key, item.type);
              setMenu(null);
            }}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className={`${styles.menuItem} ${styles.menuDanger}`}
          onClick={() => {
            onChange(removeAt(blocks, block.key));
            setMenu(null);
          }}
        >
          Delete
        </button>
      </div>
    );
  };

  const renderEmbed = (block: DraftBlock) => {
    if (block.type === 'database' && orgId && typeof block.props.tableId === 'string') {
      return (
        <div className={styles.embedSlot}>
          <DatabaseEmbed orgId={orgId} tableId={String(block.props.tableId)} />
        </div>
      );
    }
    if (block.type === 'record' && orgId && typeof block.props.recordId === 'string') {
      return (
        <div className={styles.embedSlot}>
          <RecordEmbed orgId={orgId} recordId={String(block.props.recordId)} />
        </div>
      );
    }
    if (block.type === 'embed') {
      const url = String(block.props.url ?? block.text ?? '').trim();
      if (url) {
        return (
          <div className={styles.embedSlot}>
            <RichEmbed
              url={url}
              onClear={
                readOnly
                  ? undefined
                  : () => applyType(block.key, 'embed', '', { url: undefined })
              }
            />
          </div>
        );
      }
      if (readOnly) return null;
      return (
        <div className={styles.embedSlot}>
          <EmbedComposer
            orgId={orgId}
            initialMakeKind={isPageMakeKind(block.props.makeKind) ? block.props.makeKind : null}
            onSubmit={(next) => applyType(block.key, 'embed', next, { url: next })}
            onMake={(kind, prompt) => submitMake(block.key, kind, prompt)}
          />
        </div>
      );
    }
    if (block.type === 'bookmark') {
      const url = String(block.props.url ?? block.text ?? '').trim();
      if (url) {
        return (
          <div className={styles.embedSlot}>
            <RichEmbed url={url} />
          </div>
        );
      }
    }
    if (block.type === 'artifact') {
      const path = String(block.props.path ?? block.text ?? '').trim();
      if (path && (looksLikeUrl(path) || path.startsWith('/') || path.startsWith('api/'))) {
        return (
          <div className={styles.embedSlot}>
            <RichEmbed
              url={path.startsWith('api/') ? `/${path}` : path}
              onClear={
                readOnly ? undefined : () => applyType(block.key, 'artifact', '', { path: undefined })
              }
            />
          </div>
        );
      }
      if (!path && !readOnly) {
        return (
          <div className={styles.embedSlot}>
            <EmbedComposer
              orgId={orgId}
              onSubmit={(next) => applyType(block.key, 'artifact', next, { path: next })}
              onMake={(kind, prompt) => submitMake(block.key, kind, prompt)}
            />
          </div>
        );
      }
    }
    if (block.type === 'page') {
      const pageId = String(block.props.pageId ?? block.text ?? '').trim();
      const linked = pages.find((page) => page.id === pageId);
      if (pageId) {
        return (
          <button
            type="button"
            className={styles.pageCard}
            onClick={() => onOpenPage?.(pageId)}
          >
            <span>{linked?.icon ?? '📄'}</span>
            <span>{linked?.title || pageId}</span>
          </button>
        );
      }
      return (
        <label className={styles.picker}>
          <span>Link a page</span>
          <select
            value=""
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              if (id === '__new__' && onCreateSubpage) {
                void (async () => {
                  const created = await onCreateSubpage();
                  if (!created) return;
                  onChange(
                    updateAt(blocks, block.key, {
                      props: { ...block.props, pageId: created.id },
                      text: created.title,
                    }),
                  );
                })();
                return;
              }
              onChange(updateAt(blocks, block.key, { props: { ...block.props, pageId: id }, text: '' }));
            }}
          >
            <option value="">Choose…</option>
            {onCreateSubpage ? <option value="__new__">+ New sub-page</option> : null}
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.icon ?? '📄'} {page.title || 'Untitled'}
              </option>
            ))}
          </select>
        </label>
      );
    }
    if (block.type === 'table') {
      const rows = tableRows(block);
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>
                      <input
                        className={styles.tableInput}
                        value={cell}
                        disabled={readOnly}
                        aria-label={`Row ${ri + 1} column ${ci + 1}`}
                        onChange={(event) => {
                          const next = rows.map((r) => [...r]);
                          const target = next[ri];
                          if (target) target[ci] = event.target.value;
                          onChange(
                            updateAt(blocks, block.key, {
                              props: { ...block.props, rows: { rows: next } },
                            }),
                          );
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {readOnly ? null : (
            <div className={styles.tableActions}>
              <button
                type="button"
                onClick={() => {
                  const cols = Math.max(rows[0]?.length ?? 2, 1);
                  onChange(
                    updateAt(blocks, block.key, {
                      props: { ...block.props, rows: { rows: [...rows, Array.from({ length: cols }, () => '')] } },
                    }),
                  );
                }}
              >
                + Row
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = rows.map((row) => [...row, '']);
                  onChange(
                    updateAt(blocks, block.key, {
                      props: { ...block.props, rows: { rows: next.length ? next : [['', '']] } },
                    }),
                  );
                }}
              >
                + Column
              </button>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  const showText = (block: DraftBlock) => {
    if (block.type === 'divider') return false;
    if (block.type === 'table') return false;
    if (block.type === 'database' && block.props.tableId) return false;
    if (block.type === 'record' && block.props.recordId) return false;
    if (block.type === 'page' && (block.props.pageId || pages.length > 0)) return false;
    if (block.type === 'embed') return false;
    if (block.type === 'artifact') {
      const path = String(block.props.path ?? block.text ?? '').trim();
      if (!path) return false;
      if (looksLikeUrl(path) || path.startsWith('/') || path.startsWith('api/')) return false;
    }
    if (block.type === 'bookmark' && (block.props.url || looksLikeUrl(block.text))) return false;
    return true;
  };

  const renderBlock = (block: DraftBlock, siblings: DraftBlock[], depth: number): ReactNode => {
    const checked = Boolean(block.props.checked);
    const dropping = drop?.key === block.key;

    return (
      <div
        key={block.key}
        className={styles.block}
        data-type={block.type}
        data-drop={dropping ? drop.edge : undefined}
        style={{ paddingInlineStart: depth * 24 }}
        onDragOver={(event) => {
          if (!dragging || dragging === block.key) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          setDrop({ key: block.key, edge });
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (drop) dropBlock(block.key, drop.edge);
        }}
      >
        <div className={styles.gutter}>
          <button
            type="button"
            className={styles.plus}
            title="Click to insert below"
            disabled={readOnly}
            onClick={() => addBelow(block.key)}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className={styles.handle}
            title="Drag"
            draggable={!readOnly}
            disabled={readOnly}
            onClick={() => setMenu(menu?.blockKey === block.key ? null : { blockKey: block.key })}
            onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => {
              event.dataTransfer.effectAllowed = 'move';
              setDragging(block.key);
              setMenu(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDrop(null);
            }}
          >
            <Icon name="grip-vertical" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {block.type === 'to_do' ? (
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={checked}
              disabled={readOnly}
              onChange={(event) =>
                onChange(
                  updateAt(blocks, block.key, {
                    props: { ...block.props, checked: event.target.checked },
                  }),
                )
              }
            />
          ) : null}
          {block.type === 'toggle' ? (
            <button
              type="button"
              className={styles.toggleCaret}
              aria-expanded={block.open !== false}
              onClick={() =>
                onChange(updateAt(blocks, block.key, { open: !(block.open !== false) }))
              }
            >
              {block.open === false ? '▸' : '▾'}
            </button>
          ) : null}
          {block.type === 'bulleted_list_item' ? <span className={styles.bullet}>•</span> : null}
          {block.type === 'numbered_list_item' ? (
            <span className={styles.bullet}>{numberedIndex(siblings, block.key)}.</span>
          ) : null}
          {block.type === 'callout' ? <span className={styles.calloutIcon}>💡</span> : null}

          {block.type === 'divider' ? <hr className={styles.divider} /> : null}
          {renderEmbed(block)}

          {showText(block) ? (
            <div
              ref={(el) => {
                if (el) {
                  refs.current.set(block.key, el);
                  if (document.activeElement !== el && el.textContent !== block.text) {
                    el.textContent = block.text;
                  }
                } else {
                  refs.current.delete(block.key);
                }
              }}
              className={`${styles.text}${checked ? ` ${styles.checked}` : ''}`}
              contentEditable={!readOnly}
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              data-placeholder={placeholderFor(block.type)}
              onInput={(event) => onText(block.key, event.currentTarget.textContent ?? '', event.currentTarget)}
              onKeyDown={(event) => onKeyDown(block, event)}
              onPaste={(event) => {
                const pasted = event.clipboardData?.getData('text/plain')?.trim() ?? '';
                if (!looksLikeUrl(pasted)) return;
                if (block.type === 'paragraph' && !block.text.trim()) {
                  event.preventDefault();
                  applyType(block.key, 'embed', pasted, { url: pasted });
                  return;
                }
                if (block.type === 'embed' || block.type === 'bookmark') {
                  event.preventDefault();
                  applyType(block.key, block.type, pasted, { url: pasted });
                }
              }}
              onFocus={() => setFocusKey(block.key)}
            />
          ) : null}

          {renderSlash(block.key)}
          {renderMenu(block)}

          {(block.type !== 'toggle' || block.open !== false) &&
            block.children.map((child) => renderBlock(child, block.children, depth + 1))}
        </div>
      </div>
    );
  };

  const appendTrailing = () => {
    const last = blocks[blocks.length - 1];
    if (last?.type === 'paragraph' && last.text === '' && last.children.length === 0) {
      setFocusKey(last.key);
      return;
    }
    const created = emptyBlock('paragraph');
    onChange([...blocks, created]);
    setFocusKey(created.key);
  };

  return (
    <div className={styles.editor} data-testid="pages-editor">
      {blocks.map((block) => renderBlock(block, blocks, 0))}
      {readOnly ? null : (
        <button type="button" className={styles.trailing} onClick={appendTrailing} aria-label="Add a block">
          {' '}
        </button>
      )}
    </div>
  );
}
