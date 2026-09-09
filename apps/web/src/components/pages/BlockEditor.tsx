'use client';

// Notion-style block canvas for organization pages.
//
// Interaction model follows Notion's public editor:
// `/` opens a type picker; Enter splits / creates a sibling; empty Backspace
// deletes or turns the block back into a paragraph; Tab / Shift+Tab nest;
// markdown prefixes (`# `, `- `, `[] `, `> `, ```, `$$ `) convert the block.
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
  PAGE_CALLOUT_ICONS,
  PAGE_CODE_LANGUAGES,
  PAGE_COLOR_IDS,
  type PageBlockType,
  type PageColorId,
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
import {
  insertPageMention,
  latexToDisplay,
  MEDIA_BLOCK_TYPES,
} from '../../runtime/page-rich-text';
import { pageColorStyle, PAGE_COLOR_SWATCHES } from '../../runtime/page-style';
import {
  applyMarkdownShortcut,
  BASIC_TYPES,
  blocksFromServer,
  blocksToServer,
  cloneBlock,
  collectHeadings,
  columnListWithCount,
  defaultProps,
  emptyBlock,
  findBlock,
  flattenKeys,
  indentAt,
  insertAfter,
  insertBefore,
  isDescendant,
  LIST_TYPES,
  locate,
  MEDIA_TYPES,
  numberedIndex,
  outdentAt,
  removeAt,
  stampServerIds,
  tableRows,
  TOOL_TYPES,
  updateAt,
  type DraftBlock,
  type PageIndexEntry,
} from './page-draft';
import { PageTool } from './PageTools';

export type { DraftBlock, PageIndexEntry };
export {
  applyMarkdownShortcut,
  blocksFromServer,
  blocksToServer,
  emptyBlock,
  stampServerIds,
};

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
  image: '🖼',
  video: '▶',
  audio: '♫',
  file: '📎',
  pdf: 'PDF',
  equation: '∑',
  table_of_contents: '☰',
  breadcrumb: '›',
  column_list: '▥',
  column: '▯',
  table: '▦',
  database: '▤',
  artifact: '◇',
  page: '📄',
  record: '🧾',
  board: '▤',
  checklist: '☐',
  assigner: '👤',
  poll: '◔',
  timeline: '↦',
  decision: '⚖',
  goals: '◎',
  spreadsheet: '⊞',
  budget: '$',
  calendar: '▦',
  habit: '✓',
  countdown: '⏳',
  schedule: '📅',
};

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
  crumbs?: PageIndexEntry[];
}

type ExtraSlashId = 'columns-2' | 'columns-3' | 'toggle-h1' | 'toggle-h2' | 'toggle-h3';

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
    }
  | {
      source: 'extra';
      id: ExtraSlashId;
      label: string;
      hint: string;
      glyph: string;
    };

const EXTRA_SLASH: Array<{
  id: ExtraSlashId;
  label: string;
  hint: string;
  glyph: string;
  keywords: readonly string[];
}> = [
  { id: 'columns-2', label: '2 columns', hint: 'Split into two columns', glyph: '▥', keywords: ['columns', '2', 'layout'] },
  { id: 'columns-3', label: '3 columns', hint: 'Split into three columns', glyph: '▥', keywords: ['columns', '3', 'layout'] },
  { id: 'toggle-h1', label: 'Toggle heading 1', hint: 'Collapsible large heading', glyph: 'H1', keywords: ['toggle', 'heading', 'h1'] },
  { id: 'toggle-h2', label: 'Toggle heading 2', hint: 'Collapsible medium heading', glyph: 'H2', keywords: ['toggle', 'heading', 'h2'] },
  { id: 'toggle-h3', label: 'Toggle heading 3', hint: 'Collapsible small heading', glyph: 'H3', keywords: ['toggle', 'heading', 'h3'] },
];

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
  const extras: SlashItem[] = EXTRA_SLASH.filter((item) =>
    matchesSlashQuery(item.label, item.hint, item.keywords, item.id, query),
  ).map((item) => ({
    source: 'extra',
    id: item.id,
    label: item.label,
    hint: item.hint,
    glyph: item.glyph,
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
  return [...makeItems, ...extras, ...blocks];
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
    case 'image':
      return 'Paste an image URL or drop a picture';
    case 'video':
      return 'Paste a video URL';
    case 'audio':
      return 'Paste an audio URL';
    case 'file':
      return 'Paste a file URL';
    case 'pdf':
      return 'Paste a PDF URL';
    case 'equation':
      return 'E = mc^2';
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
  crumbs = [],
}: Props) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [mention, setMention] = useState<{ blockKey: string; query: string; index: number } | null>(null);
  const [format, setFormat] = useState<{ key: string; top: number; left: number } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const refSetters = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const prevFocus = useRef<string | null>(null);
  const textOf = useRef(new Map<string, string>());

  // One stable callback per block. `textOf` carries the text the callback
  // should write so the identity never has to change.
  const bindBlock = useCallback((key: string) => {
    const existing = refSetters.current.get(key);
    if (existing) return existing;
    const setter = (el: HTMLElement | null) => {
      if (!el) {
        refs.current.delete(key);
        return;
      }
      refs.current.set(key, el);
      const text = textOf.current.get(key) ?? '';
      if (document.activeElement !== el && el.textContent !== text) {
        el.textContent = text;
      }
    };
    refSetters.current.set(key, setter);
    return setter;
  }, []);

  const slashItems = useMemo(() => (slash ? filterSlashItems(slash.query) : []), [slash]);
  const makeSlash = slashItems.filter((item) => item.source === 'make');
  const extraSlash = slashItems.filter((item) => item.source === 'extra');
  const basicSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' && BASIC_TYPES.has(item.type),
  );
  const mediaSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' && MEDIA_TYPES.has(item.type),
  );
  const toolSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' && TOOL_TYPES.has(item.type),
  );
  const otherSlash = slashItems.filter(
    (item): item is Extract<SlashItem, { source: 'block' }> =>
      item.source === 'block' &&
      !BASIC_TYPES.has(item.type) &&
      !MEDIA_TYPES.has(item.type) &&
      !TOOL_TYPES.has(item.type),
  );
  const mentionItems = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return pages.filter((page) => !q || page.title.toLowerCase().includes(q) || page.id.includes(q)).slice(0, 8);
  }, [mention, pages]);

  // The block text is written into the DOM imperatively — React never renders
  // children into a contentEditable — so anything that changes it from outside
  // (an agent writing to the page, a block turning into another type) has to be
  // pushed to the node after the render that carried it. Never touch the node
  // the caret is in.
  useEffect(() => {
    for (const [key, node] of refs.current) {
      const text = textOf.current.get(key);
      if (text === undefined || document.activeElement === node) continue;
      if (node.textContent !== text) node.textContent = text;
    }
  });

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
      const structural = type === 'divider' || type === 'table_of_contents' || type === 'breadcrumb' || type === 'column_list';
      let next = updateAt(blocks, key, {
        type,
        text: structural && type !== 'column_list' ? '' : nextText !== undefined ? nextText : current.text,
        props: { ...defaultProps(type), ...extraProps },
        children:
          type === 'column_list'
            ? columnListWithCount((extraProps?.columns as 2 | 3 | undefined) === 3 ? 3 : 2).children
            : current.children,
      });
      if (structural && type !== 'column_list') {
        const after = emptyBlock('paragraph');
        next = insertAfter(next, key, after);
        setFocusKey(after.key);
      } else {
        setFocusKey(key);
      }
      onChange(next);
      const node = refs.current.get(key);
      if (node && !structural) node.textContent = nextText !== undefined ? nextText : current.text;
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
      if (item.source === 'extra') {
        if (item.id === 'columns-2') applyType(key, 'column_list', '', { columns: 2 });
        else if (item.id === 'columns-3') applyType(key, 'column_list', '', { columns: 3 });
        else if (item.id === 'toggle-h1') applyType(key, 'heading_1', '', { toggle: true });
        else if (item.id === 'toggle-h2') applyType(key, 'heading_2', '', { toggle: true });
        else applyType(key, 'heading_3', '', { toggle: true });
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

  const applyMention = (key: string, page: PageIndexEntry) => {
    const current = findBlock(blocks, key);
    if (!current) return;
    const node = refs.current.get(key);
    const at = /(?:^|\s)@([^\s]*)$/.exec(current.text);
    const start = at ? current.text.length - (at[0].startsWith(' ') ? at[0].length - 1 : at[0].length) : current.text.length;
    const next = insertPageMention(current.text, start, current.text.length, page.title || 'Untitled', page.id);
    onChange(updateAt(blocks, key, { text: next }));
    if (node) node.textContent = next;
    setMention(null);
    setFocusKey(key);
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
    if (current && MEDIA_BLOCK_TYPES.has(current.type) && text.trim()) props.url = text.trim();
    onChange(updateAt(blocks, key, { text, props }));
    if (text.startsWith('/')) {
      setSlash({ blockKey: key, query: text.slice(1), index: 0 });
      setMention(null);
    } else if (slash?.blockKey === key) {
      setSlash(null);
    }
    const at = /(?:^|\s)@([^\s]*)$/.exec(text);
    if (at && pages.length > 0) {
      setMention({ blockKey: key, query: at[1] ?? '', index: 0 });
    } else if (mention?.blockKey === key) {
      setMention(null);
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
      const next = wrapSelection(node, '__', '__');
      if (next !== null) {
        event.preventDefault();
        onChange(updateAt(blocks, block.key, { text: next }));
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') {
      const next = wrapSelection(node, '~~', '~~');
      if (next !== null) {
        event.preventDefault();
        onChange(updateAt(blocks, block.key, { text: next }));
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      const href = window.prompt('Link URL');
      if (!href) return;
      const next = wrapSelection(node, '[', `](${href.trim()})`);
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

    if (mention && mentionItems.length > 0 && mention.blockKey === block.key) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMention({ ...mention, index: (mention.index + 1) % mentionItems.length });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMention({
          ...mention,
          index: (mention.index - 1 + mentionItems.length) % mentionItems.length,
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const pick = mentionItems[mention.index] ?? mentionItems[0];
        if (pick) applyMention(block.key, pick);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
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
            {extraSlash.length > 0 ? <div className={styles.slashTitle}>Turn into</div> : null}
            {extraSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {basicSlash.length > 0 ? <div className={styles.slashTitle}>Basic blocks</div> : null}
            {basicSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {mediaSlash.length > 0 ? <div className={styles.slashTitle}>Media</div> : null}
            {mediaSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {toolSlash.length > 0 ? <div className={styles.slashTitle}>Tools</div> : null}
            {toolSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
            {otherSlash.length > 0 ? <div className={styles.slashTitle}>Advanced</div> : null}
            {otherSlash.map((item) => renderSlashItem(item, slashItems.indexOf(item)))}
          </>
        )}
      </div>
    );
  };

  const renderSlashItem = (item: SlashItem, index: number) => (
    <button
      key={item.source === 'make' ? `make-${item.kind}` : item.source === 'extra' ? item.id : item.type}
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
    const setColor = (field: 'color' | 'background', value: PageColorId) => {
      onChange(updateAt(blocks, block.key, { props: { ...block.props, [field]: value } }));
      setMenu(null);
    };
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
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => {
            const id = block.id ?? block.key;
            void navigator.clipboard?.writeText(`${window.location.href}#block-${id}`);
            setMenu(null);
          }}
        >
          Copy link to block
        </button>
        <div className={styles.menuLabel}>Color</div>
        <div className={styles.colorRow}>
          {PAGE_COLOR_IDS.map((id) => (
            <button
              key={`c-${id}`}
              type="button"
              className={styles.colorDot}
              title={PAGE_COLOR_SWATCHES[id].label}
              style={{ background: PAGE_COLOR_SWATCHES[id].text || 'var(--text, #1a1916)' }}
              aria-label={`Text ${PAGE_COLOR_SWATCHES[id].label}`}
              onClick={() => setColor('color', id)}
            />
          ))}
        </div>
        <div className={styles.menuLabel}>Background</div>
        <div className={styles.colorRow}>
          {PAGE_COLOR_IDS.map((id) => (
            <button
              key={`b-${id}`}
              type="button"
              className={styles.colorDot}
              title={PAGE_COLOR_SWATCHES[id].label}
              style={{ background: PAGE_COLOR_SWATCHES[id].bg || 'transparent', border: '1px solid var(--border, #e1e5eb)' }}
              aria-label={`Background ${PAGE_COLOR_SWATCHES[id].label}`}
              onClick={() => setColor('background', id)}
            />
          ))}
        </div>
        <div className={styles.menuLabel}>Turn into</div>
        {PAGE_BLOCK_CATALOG.filter((item) => item.type !== 'column').slice(0, 16).map((item) => (
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
    if (block.type === 'equation') {
      const latex = block.text.trim();
      return (
        <div className={styles.equation} data-testid="pages-equation">
          <div className={styles.equationDisplay}>{latex ? latexToDisplay(latex) : '∑'}</div>
          {readOnly ? null : (
            <input
              className={styles.caption}
              value={block.text}
              placeholder="LaTeX, e.g. E = mc^2"
              aria-label="Equation"
              onChange={(event) => onChange(updateAt(blocks, block.key, { text: event.target.value }))}
            />
          )}
        </div>
      );
    }
    if (block.type === 'table_of_contents') {
      const headings = collectHeadings(blocks);
      return (
        <nav className={styles.toc} data-testid="pages-toc" aria-label="Table of contents">
          {headings.length === 0 ? (
            <p className={styles.tocEmpty}>Headings on this page will appear here.</p>
          ) : (
            headings.map((heading) => (
              <button
                key={heading.key}
                type="button"
                className={styles.tocItem}
                data-level={heading.type}
                onClick={() => setFocusKey(heading.key)}
              >
                {heading.text}
              </button>
            ))
          )}
        </nav>
      );
    }
    if (block.type === 'breadcrumb') {
      const trail = crumbs.length > 0 ? crumbs : pages.slice(0, 1);
      return (
        <nav className={styles.inlineCrumbs} data-testid="pages-breadcrumb" aria-label="Page path">
          {trail.map((item, index) => (
            <span key={item.id}>
              {index > 0 ? <span className={styles.crumbSep}>/</span> : null}
              <button type="button" className={styles.crumbLink} onClick={() => onOpenPage?.(item.id)}>
                {item.icon ?? '📄'} {item.title || 'Untitled'}
              </button>
            </span>
          ))}
        </nav>
      );
    }
    if (MEDIA_BLOCK_TYPES.has(block.type) && block.type !== 'embed' && block.type !== 'bookmark') {
      const url = String(block.props.url ?? block.text ?? '').trim();
      if (url) {
        return (
          <div className={styles.embedSlot}>
            <RichEmbed
              url={url}
              onClear={readOnly ? undefined : () => applyType(block.key, block.type, '', { url: undefined })}
            />
            {readOnly ? (
              block.props.caption ? <p className={styles.captionText}>{String(block.props.caption)}</p> : null
            ) : (
              <input
                className={styles.caption}
                value={String(block.props.caption ?? '')}
                placeholder="Caption"
                aria-label="Caption"
                onChange={(event) =>
                  onChange(
                    updateAt(blocks, block.key, {
                      props: { ...block.props, caption: event.target.value },
                    }),
                  )
                }
              />
            )}
          </div>
        );
      }
      if (!readOnly) {
        return (
          <div className={styles.embedSlot}>
            <EmbedComposer
              orgId={orgId}
              onSubmit={(next) => applyType(block.key, block.type, next, { url: next })}
              onMake={(kind, prompt) => submitMake(block.key, kind, prompt)}
            />
          </div>
        );
      }
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
    if (TOOL_TYPES.has(block.type)) {
      return (
        <PageTool
          block={block}
          readOnly={readOnly}
          orgId={orgId}
          onChange={(patch) => onChange(updateAt(blocks, block.key, patch))}
        />
      );
    }
    return null;
  };

  const showText = (block: DraftBlock) => {
    if (
      block.type === 'divider' ||
      block.type === 'table' ||
      block.type === 'column_list' ||
      block.type === 'column' ||
      block.type === 'table_of_contents' ||
      block.type === 'breadcrumb' ||
      block.type === 'equation' ||
      TOOL_TYPES.has(block.type)
    ) {
      return false;
    }
    if (block.type === 'database' && block.props.tableId) return false;
    if (block.type === 'record' && block.props.recordId) return false;
    if (block.type === 'page' && (block.props.pageId || pages.length > 0)) return false;
    if (MEDIA_BLOCK_TYPES.has(block.type)) return false;
    if (block.type === 'embed') return false;
    if (block.type === 'artifact') {
      const path = String(block.props.path ?? block.text ?? '').trim();
      if (!path) return false;
      if (looksLikeUrl(path) || path.startsWith('/') || path.startsWith('api/')) return false;
    }
    return true;
  };

  const soleEmptyBlock =
    blocks.length === 1 && !blocks[0]?.text && blocks[0]?.children.length === 0
      ? blocks[0]?.key
      : null;

  const renderBlock = (block: DraftBlock, siblings: DraftBlock[], depth: number): ReactNode => {
    const checked = Boolean(block.props.checked);
    const dropping = drop?.key === block.key;
    const toggleable = block.type === 'toggle' || Boolean(block.props.toggle);
    const colorStyle = pageColorStyle(
      typeof block.props.color === 'string' ? block.props.color : null,
      typeof block.props.background === 'string' ? block.props.background : null,
    );
    const isColumnList = block.type === 'column_list';
    const isColumn = block.type === 'column';

    return (
      <div
        key={block.key}
        id={block.id ? `block-${block.id}` : undefined}
        className={styles.block}
        data-type={block.type}
        data-drop={dropping ? drop.edge : undefined}
        style={{
          paddingInlineStart: isColumn || isColumnList ? 0 : depth * 24,
          ...colorStyle,
          borderRadius: colorStyle.background ? 6 : undefined,
        }}
        onDragOver={(event) => {
          if (!dragging || dragging === block.key) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          setDrop((current) =>
            current?.key === block.key && current.edge === edge ? current : { key: block.key, edge },
          );
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
          {toggleable ? (
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
          {block.type === 'callout' ? (
            <button
              type="button"
              className={styles.calloutIcon}
              title="Change icon"
              disabled={readOnly}
              onClick={() => {
                const current = String(block.props.icon ?? '💡');
                const idx = PAGE_CALLOUT_ICONS.indexOf(current as (typeof PAGE_CALLOUT_ICONS)[number]);
                const next = PAGE_CALLOUT_ICONS[(idx + 1) % PAGE_CALLOUT_ICONS.length] ?? '💡';
                onChange(updateAt(blocks, block.key, { props: { ...block.props, icon: next } }));
              }}
            >
              {String(block.props.icon ?? '💡')}
            </button>
          ) : null}

          {block.type === 'code' && !readOnly ? (
            <select
              className={styles.lang}
              value={String(block.props.language ?? 'text')}
              aria-label="Code language"
              onChange={(event) =>
                onChange(updateAt(blocks, block.key, { props: { ...block.props, language: event.target.value } }))
              }
            >
              {PAGE_CODE_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          ) : null}

          {block.type === 'divider' ? <hr className={styles.divider} /> : null}
          {renderEmbed(block)}

          {showText(block) ? (
            <div
              ref={bindBlock(block.key)}
              className={`${styles.text}${checked ? ` ${styles.checked}` : ''}`}
              contentEditable={!readOnly}
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              data-placeholder={placeholderFor(block.type)}
              data-lonely={block.key === soleEmptyBlock ? 'true' : undefined}
              onInput={(event) => onText(block.key, event.currentTarget.textContent ?? '', event.currentTarget)}
              onKeyDown={(event) => onKeyDown(block, event)}
              onPaste={(event) => {
                const file = event.clipboardData?.files?.[0];
                if (file && file.type.startsWith('image/')) {
                  event.preventDefault();
                  const reader = new FileReader();
                  reader.onload = () => {
                    applyType(block.key, 'image', String(reader.result), { url: String(reader.result) });
                  };
                  reader.readAsDataURL(file);
                  return;
                }
                const pasted = event.clipboardData?.getData('text/plain')?.trim() ?? '';
                if (!looksLikeUrl(pasted)) return;
                if (block.type === 'paragraph' && !block.text.trim()) {
                  event.preventDefault();
                  applyType(block.key, 'embed', pasted, { url: pasted });
                  return;
                }
                if (MEDIA_BLOCK_TYPES.has(block.type)) {
                  event.preventDefault();
                  applyType(block.key, block.type, pasted, { url: pasted });
                }
              }}
              onFocus={() => setFocusKey(block.key)}
              onMouseUp={(event) => {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed) {
                  setFormat(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setFormat({ key: block.key, top: rect.top - 8, left: rect.left + 24 });
              }}
            />
          ) : null}

          {mention?.blockKey === block.key && mentionItems.length > 0 ? (
            <div className={styles.slashMenu} role="listbox" data-testid="pages-mention">
              {mentionItems.map((page, index) => (
                <button
                  key={page.id}
                  type="button"
                  role="option"
                  aria-selected={index === mention.index}
                  className={`${styles.slashItem}${index === mention.index ? ` ${styles.slashActive}` : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(block.key, page);
                  }}
                >
                  <span className={styles.slashGlyph}>{page.icon ?? '📄'}</span>
                  <span className={styles.slashCopy}>
                    <strong>{page.title || 'Untitled'}</strong>
                    <span>Mention page</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {renderSlash(block.key)}
          {renderMenu(block)}

          {isColumnList ? (
            <div className={styles.columns} data-count={Math.max(block.children.length, 2)}>
              {block.children.map((child) => renderBlock(child, block.children, 0))}
            </div>
          ) : (toggleable ? block.open !== false : true)
            ? block.children.map((child) => renderBlock(child, block.children, isColumn ? 0 : depth + 1))
            : null}
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

  // Text the per-block ref callbacks write into their node, refreshed each
  // render so those callbacks can keep a stable identity. Rebuilding the map
  // also drops entries for blocks that no longer exist.
  textOf.current.clear();
  const indexText = (list: DraftBlock[]) => {
    for (const block of list) {
      textOf.current.set(block.key, block.text);
      indexText(block.children);
    }
  };
  indexText(blocks);
  for (const key of refSetters.current.keys()) {
    if (!textOf.current.has(key)) refSetters.current.delete(key);
  }

  return (
    <div className={styles.editor} data-testid="pages-editor">
      {format && !readOnly ? (
        <div className={styles.formatBar} data-testid="pages-format" style={{ top: format.top, left: format.left }}>
          {([
            ['B', '**', '**', 'Bold'],
            ['I', '*', '*', 'Italic'],
            ['U', '__', '__', 'Underline'],
            ['S', '~~', '~~', 'Strikethrough'],
            ['<>', '`', '`', 'Code'],
          ] as const).map(([label, before, after, title]) => (
            <button
              key={title}
              type="button"
              title={title}
              onMouseDown={(event) => {
                event.preventDefault();
                const node = refs.current.get(format.key);
                if (!node) return;
                const next = wrapSelection(node, before, after);
                if (next !== null) onChange(updateAt(blocks, format.key, { text: next }));
                setFormat(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {blocks.map((block) => renderBlock(block, blocks, 0))}
      {readOnly ? null : (
        <button type="button" className={styles.trailing} onClick={appendTrailing} aria-label="Add a block">
          {' '}
        </button>
      )}
    </div>
  );
}
