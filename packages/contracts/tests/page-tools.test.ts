import { describe, expect, it } from 'vitest';

import { columnLetters, evaluateSheet, parseCellAddress, SHEET_ERROR } from '../src/api/page-spreadsheet.js';
import {
  budgetTotals,
  daysUntil,
  defaultPageTool,
  isPageToolType,
  PAGE_TOOL_TYPES,
  parsePageTool,
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
      'spreadsheet',
      'budget',
      'calendar',
      'habit',
      'countdown',
      'schedule',
    ]);
    expect(isPageToolType('spreadsheet')).toBe(true);
    expect(isPageToolType('budget')).toBe(true);
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

    const sheet = defaultPageTool('spreadsheet');
    expect(sheet.kind).toBe('spreadsheet');
    if (sheet.kind === 'spreadsheet') {
      expect(sheet.cells).toHaveLength(6);
      expect(sheet.cells[0]).toHaveLength(4);
    }
    const budget = defaultPageTool('budget');
    expect(budget.kind).toBe('budget');
    if (budget.kind === 'budget') {
      expect(budget.items).toHaveLength(2);
      expect(budget.currency).toBe('$');
    }
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

    const sheet = parsePageTool('spreadsheet', { kind: 'spreadsheet', cells: 'nope' });
    expect(sheet.kind).toBe('spreadsheet');
    if (sheet.kind === 'spreadsheet') expect(sheet.cells.length).toBeGreaterThan(0);
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

  it('sums budget income against expenses', () => {
    const tool = parsePageTool('budget', {
      kind: 'budget',
      currency: '£',
      items: [
        { id: '1', label: 'Salary', amount: 4000, flow: 'income' },
        { id: '2', label: 'Rent', amount: 1500, kind: 'expense' },
        { id: '3', label: 'Groceries', amount: 200, type: 'expense' },
      ],
    });
    expect(tool.kind).toBe('budget');
    if (tool.kind !== 'budget') return;
    expect(tool.currency).toBe('£');
    expect(budgetTotals(tool)).toEqual({ income: 4000, expense: 1700, balance: 2300 });
  });

  it('counts days until a countdown date', () => {
    expect(daysUntil('2026-09-10', new Date(2026, 8, 7))).toBe(3);
    expect(daysUntil('2026-09-07', new Date(2026, 8, 7))).toBe(0);
    expect(daysUntil('nope')).toBeNull();
  });
});

describe('spreadsheet formulas', () => {
  it('maps A1-style addresses', () => {
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(26)).toBe('AA');
    expect(parseCellAddress('B3')).toEqual({ row: 2, col: 1 });
  });

  it('adds cells and ranges', () => {
    const out = evaluateSheet([
      ['2', '3', '=A1+B1'],
      ['4', '', '=SUM(A1:A2)'],
      ['', '', '=AVERAGE(A1:B1)'],
    ]);
    expect(out[0]?.[2]).toBe('5');
    expect(out[1]?.[2]).toBe('6');
    expect(out[2]?.[2]).toBe('2.5');
  });

  it('flags cycles and divide-by-zero', () => {
    const cycle = evaluateSheet([['=A1']]);
    expect(cycle[0]?.[0]).toBe(SHEET_ERROR.cycle);
    const div = evaluateSheet([['1', '0', '=A1/B1']]);
    expect(div[0]?.[2]).toBe(SHEET_ERROR.div);
  });
});
