import { describe, expect, it } from 'vitest';

import {
  defaultPageTool,
  isPageToolType,
  parsePageTool,
  PAGE_TOOL_TYPES,
  pageToolPlainText,
} from '../src/api/page-tools.js';

describe('page tools', () => {
  it('names every inline tool once', () => {
    expect(PAGE_TOOL_TYPES).toEqual([
      'board',
      'checklist',
      'assigner',
      'poll',
      'timeline',
      'decision',
      'goals',
    ]);
    expect(isPageToolType('board')).toBe(true);
    expect(isPageToolType('paragraph')).toBe(false);
  });

  it('seeds a usable empty payload for each tool', () => {
    const board = defaultPageTool('board');
    expect(board.kind).toBe('board');
    if (board.kind === 'board') {
      expect(board.columns.map((column) => column.title)).toEqual(['To do', 'In progress', 'Done']);
    }
    const list = defaultPageTool('checklist');
    expect(list.kind).toBe('checklist');
    if (list.kind === 'checklist') expect(list.items).toHaveLength(3);
  });

  it('repairs garbage payloads instead of throwing', () => {
    const board = parsePageTool('board', { kind: 'board', columns: 'nope' });
    expect(board.kind).toBe('board');
    if (board.kind === 'board') expect(board.columns).toHaveLength(3);

    const poll = parsePageTool('poll', {
      kind: 'poll',
      question: 'Ship Friday?',
      options: [{ label: 'Yes', voterIds: ['u1'] }, { label: 12 }],
    });
    expect(poll.kind).toBe('poll');
    if (poll.kind === 'poll') {
      expect(poll.question).toBe('Ship Friday?');
      expect(poll.options[0]?.voterIds).toEqual(['u1']);
      expect(poll.options[1]?.label).toBe('');
    }
  });

  it('accepts agent goals payloads that use a goals array and status', () => {
    const tool = parsePageTool('goals', {
      kind: 'goals',
      goals: [
        { id: 'g1', title: 'Ship pages agent', status: 'not_started' },
        { id: 'g2', title: 'Hire designer', status: 'in_progress' },
        { id: 'g3', title: 'Launch beta', status: 'done' },
      ],
    });
    expect(tool.kind).toBe('goals');
    if (tool.kind !== 'goals') return;
    expect(tool.items.map((item) => item.title)).toEqual([
      'Ship pages agent',
      'Hire designer',
      'Launch beta',
    ]);
    expect(tool.items.map((item) => item.current)).toEqual([0, 50, 100]);
    expect(tool.items.map((item) => item.target)).toEqual([100, 100, 100]);
  });

  it('flattens tool text for search and markdown', () => {
    const text = pageToolPlainText({
      kind: 'assigner',
      tasks: [
        { id: '1', title: 'Write brief', assigneeId: 'u1', assigneeName: 'Ada', status: 'doing' },
      ],
    });
    expect(text).toContain('Write brief');
    expect(text).toContain('Ada');
  });
});
