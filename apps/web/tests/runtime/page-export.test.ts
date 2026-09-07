import { describe, expect, it } from 'vitest';

import { blocksFromServer, blocksToServer, emptyBlock } from '../../src/components/pages/page-draft';
import { countPageWords, pageToMarkdown } from '../../src/runtime/page-export';
import { latexToDisplay, parsePageMarks } from '../../src/runtime/page-rich-text';

describe('page rich text', () => {
  it('parses Notion-style marks and page mentions', () => {
    const marks = parsePageMarks('**bold** *i* ~~s~~ __u__ `code` [docs](https://example.com) [@Handbook](page:abc)');
    expect(marks.map((mark) => mark.kind)).toEqual([
      'bold',
      'text',
      'italic',
      'text',
      'strike',
      'text',
      'underline',
      'text',
      'code',
      'text',
      'link',
      'text',
      'page',
    ]);
    expect(marks.find((mark) => mark.kind === 'page')?.href).toBe('abc');
  });

  it('renders common LaTeX into readable math', () => {
    expect(latexToDisplay('E = mc^2')).toContain('²');
    expect(latexToDisplay('\\alpha + \\beta')).toBe('α + β');
  });
});

describe('page markdown export', () => {
  it('exports headings, todos, and media', () => {
    const heading = emptyBlock('heading_1');
    heading.text = 'Welcome';
    const todo = emptyBlock('to_do');
    todo.text = 'Ship pages';
    todo.props.checked = true;
    const md = pageToMarkdown('Handbook', [heading, todo]);
    expect(md).toContain('# Handbook');
    expect(md).toContain('# Welcome');
    expect(md).toContain('- [x] Ship pages');
    expect(countPageWords('Handbook', [heading, todo])).toBeGreaterThan(2);
  });

  it('exports page tools as readable lists', () => {
    const list = emptyBlock('checklist');
    const items = (list.props.tool as { items: Array<{ text: string; checked: boolean }> }).items;
    items[0]!.text = 'Ship board';
    items[0]!.checked = true;
    const board = emptyBlock('board');
    const md = pageToMarkdown('Sprint', [list, board]);
    expect(md).toContain('- [x] Ship board');
    expect(md).toContain('### To do');
    expect(countPageWords('Sprint', [list])).toBeGreaterThan(2);
  });
});

describe('page tool draft roundtrip', () => {
  it('keeps a board payload when saving and loading', () => {
    const board = emptyBlock('board');
    const payload = board.props.tool as {
      columns: Array<{ title: string; cards: Array<{ id: string; title: string }> }>;
    };
    payload.columns[0]!.cards.push({ id: 'card-1', title: 'Write spec' });
    const saved = blocksToServer([board]);
    expect(saved[0]!.type).toBe('board');
    expect(saved[0]!.content).toMatchObject({ kind: 'board' });
    const columns = (
      saved[0]!.content as { columns: Array<{ title: string; cards: Array<{ id: string; title: string }> }> }
    ).columns;
    expect(columns[0]?.title).toBe('To do');
    expect(columns[0]?.cards).toEqual([{ id: 'card-1', title: 'Write spec' }]);
    const loaded = blocksFromServer([
      {
        id: 'b1',
        pageId: 'p1',
        parentBlockId: null,
        type: 'board',
        content: saved[0]!.content ?? null,
        props: {},
        position: 0,
        children: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(loaded[0]!.type).toBe('board');
    const loadedColumns = (loaded[0]!.props.tool as { columns: Array<{ title: string; cards: Array<{ title: string }> }> }).columns;
    expect(loadedColumns[0]?.title).toBe('To do');
    expect(loadedColumns[0]?.cards).toEqual([{ id: 'card-1', title: 'Write spec' }]);
  });
});
