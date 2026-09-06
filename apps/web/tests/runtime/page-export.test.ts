import { describe, expect, it } from 'vitest';

import { emptyBlock } from '../../src/components/pages/page-draft';
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
});
