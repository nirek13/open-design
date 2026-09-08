// Interactive tools that live inside a page block (kanban, checklist,
// spreadsheet, budget, …).
//
// These are Substrate-specific — Notion's equivalent is a database with a
// board/list view. We keep the payload on the block itself so a page can
// carry a working tool without standing up a workspace table.

import { padSheet, sheetPlainText } from './page-spreadsheet.js';

export const PAGE_TOOL_TYPES = [
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
] as const;

export type PageToolType = (typeof PAGE_TOOL_TYPES)[number];

const TOOL_TYPE_SET = new Set<string>(PAGE_TOOL_TYPES);

export function isPageToolType(type: string): type is PageToolType {
  return TOOL_TYPE_SET.has(type);
}

export function newPageToolId(): string {
  return `t-${Math.random().toString(36).slice(2, 10)}`;
}

export interface BoardCard {
  id: string;
  title: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  cards: BoardCard[];
}

export interface BoardTool {
  kind: 'board';
  columns: BoardColumn[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ChecklistTool {
  kind: 'checklist';
  items: ChecklistItem[];
}

export const ASSIGNER_STATUSES = ['todo', 'doing', 'done'] as const;
export type AssignerStatus = (typeof ASSIGNER_STATUSES)[number];

export interface AssignerTask {
  id: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  status: AssignerStatus;
}

export interface AssignerTool {
  kind: 'assigner';
  tasks: AssignerTask[];
}

export interface PollOption {
  id: string;
  label: string;
  voterIds: string[];
}

export interface PollTool {
  kind: 'poll';
  question: string;
  options: PollOption[];
}

export interface TimelineItem {
  id: string;
  title: string;
  date: string;
  done: boolean;
}

export interface TimelineTool {
  kind: 'timeline';
  items: TimelineItem[];
}

export interface DecisionOption {
  id: string;
  label: string;
}

export interface DecisionTool {
  kind: 'decision';
  question: string;
  options: DecisionOption[];
  chosenId: string | null;
  notes: string;
}

export interface GoalItem {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string;
}

export interface GoalsTool {
  kind: 'goals';
  items: GoalItem[];
}

export interface SpreadsheetTool {
  kind: 'spreadsheet';
  cells: string[][];
}

export const BUDGET_KINDS = ['income', 'expense'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface BudgetItem {
  id: string;
  date: string;
  label: string;
  category: string;
  amount: number;
  flow: BudgetKind;
}

export interface BudgetTool {
  kind: 'budget';
  currency: string;
  items: BudgetItem[];
}

export interface CalendarEventItem {
  id: string;
  date: string;
  title: string;
}

export interface CalendarTool {
  kind: 'calendar';
  year: number;
  month: number;
  events: CalendarEventItem[];
}

export interface HabitItem {
  id: string;
  title: string;
  stamps: string[];
}

export interface HabitTool {
  kind: 'habit';
  days: number;
  habits: HabitItem[];
}

export interface CountdownItem {
  id: string;
  title: string;
  date: string;
}

export interface CountdownTool {
  kind: 'countdown';
  items: CountdownItem[];
}

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export interface ScheduleItem {
  id: string;
  day: WeekDay;
  start: string;
  end: string;
  title: string;
}

export interface ScheduleTool {
  kind: 'schedule';
  items: ScheduleItem[];
}

export type PageToolPayload =
  | BoardTool
  | ChecklistTool
  | AssignerTool
  | PollTool
  | TimelineTool
  | DecisionTool
  | GoalsTool
  | SpreadsheetTool
  | BudgetTool
  | CalendarTool
  | HabitTool
  | CountdownTool
  | ScheduleTool;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseBoard(raw: Record<string, unknown>): BoardTool {
  const columns = asList(raw.columns).map((entry) => {
    const col = asRecord(entry);
    return {
      id: asString(col.id) || newPageToolId(),
      title: asString(col.title, 'Untitled'),
      cards: asList(col.cards).map((card) => {
        const item = asRecord(card);
        return {
          id: asString(item.id) || newPageToolId(),
          title: asString(item.title),
        };
      }),
    };
  });
  return {
    kind: 'board',
    columns: columns.length > 0 ? columns : defaultBoard().columns,
  };
}

function parseChecklist(raw: Record<string, unknown>): ChecklistTool {
  const items = asList(raw.items).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      text: asString(item.text),
      checked: asBoolean(item.checked),
    };
  });
  return {
    kind: 'checklist',
    items: items.length > 0 ? items : defaultChecklist().items,
  };
}

function parseStatus(value: unknown): AssignerStatus {
  return ASSIGNER_STATUSES.includes(value as AssignerStatus) ? (value as AssignerStatus) : 'todo';
}

function parseAssigner(raw: Record<string, unknown>): AssignerTool {
  const tasks = asList(raw.tasks).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      title: asString(item.title),
      assigneeId: asString(item.assigneeId) || null,
      assigneeName: asString(item.assigneeName) || null,
      status: parseStatus(item.status),
    };
  });
  return {
    kind: 'assigner',
    tasks: tasks.length > 0 ? tasks : defaultAssigner().tasks,
  };
}

function parsePoll(raw: Record<string, unknown>): PollTool {
  const options = asList(raw.options).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      label: asString(item.label),
      voterIds: asList(item.voterIds).map((id) => asString(id)).filter(Boolean),
    };
  });
  return {
    kind: 'poll',
    question: asString(raw.question),
    options: options.length > 0 ? options : defaultPoll().options,
  };
}

function parseTimeline(raw: Record<string, unknown>): TimelineTool {
  const items = asList(raw.items).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      title: asString(item.title),
      date: asString(item.date),
      done: asBoolean(item.done),
    };
  });
  return {
    kind: 'timeline',
    items: items.length > 0 ? items : defaultTimeline().items,
  };
}

function parseDecision(raw: Record<string, unknown>): DecisionTool {
  const options = asList(raw.options).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      label: asString(item.label),
    };
  });
  return {
    kind: 'decision',
    question: asString(raw.question),
    options: options.length > 0 ? options : defaultDecision().options,
    chosenId: asString(raw.chosenId) || null,
    notes: asString(raw.notes),
  };
}

function goalProgressFromStatus(status: string, target: number): number {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    normalized === 'done'
    || normalized === 'complete'
    || normalized === 'completed'
    || normalized === 'achieved'
  ) {
    return target;
  }
  if (
    normalized === 'in_progress'
    || normalized === 'doing'
    || normalized === 'started'
  ) {
    return Math.round(target / 2);
  }
  return 0;
}

function parseGoals(raw: Record<string, unknown>): GoalsTool {
  const rows = asList(raw.items).length > 0 ? asList(raw.items) : asList(raw.goals);
  const items = rows.map((entry) => {
    const item = asRecord(entry);
    const target = Math.max(asNumber(item.target, 100), 1);
    const titled = asString(item.title) || asString(item.text) || asString(item.name);
    const current = Object.prototype.hasOwnProperty.call(item, 'current')
      ? Math.max(asNumber(item.current), 0)
      : goalProgressFromStatus(asString(item.status), target);
    return {
      id: asString(item.id) || newPageToolId(),
      title: titled,
      current,
      target,
      unit: asString(item.unit, '%'),
    };
  });
  return {
    kind: 'goals',
    items: items.length > 0 ? items : defaultGoals().items,
  };
}

function parseIsoDateParts(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function monthCells(year: number, month: number): Array<{ date: string; inMonth: boolean }> {
  const first = new Date(year, month - 1, 1);
  const start = new Date(year, month - 1, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return {
      date: formatIsoDate(day),
      inMonth: day.getMonth() === month - 1,
    };
  });
}

export function daysUntil(isoDate: string, now = new Date()): number | null {
  const parsed = parseIsoDateParts(isoDate);
  if (!parsed) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(parsed.y, parsed.m - 1, parsed.d).getTime();
  return Math.round((target - today) / 86_400_000);
}

export function habitDayRange(days: number, now = new Date()): string[] {
  const count = Math.min(Math.max(Math.round(days) || 7, 1), 31);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1));
  return Array.from({ length: count }, (_, i) =>
    formatIsoDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
  );
}

export function budgetTotals(tool: BudgetTool): { income: number; expense: number; balance: number } {
  let income = 0;
  let expense = 0;
  for (const item of tool.items) {
    if (item.flow === 'income') income += item.amount;
    else expense += item.amount;
  }
  return { income, expense, balance: income - expense };
}

function parseBudgetFlow(value: unknown): BudgetKind {
  if (value === 'income' || value === 'in') return 'income';
  return 'expense';
}

function parseWeekDay(value: unknown): WeekDay {
  return WEEK_DAYS.includes(value as WeekDay) ? (value as WeekDay) : 'mon';
}

function parseSpreadsheet(raw: Record<string, unknown>): SpreadsheetTool {
  const cellsRaw = asList(raw.cells);
  const cells = cellsRaw.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => asString(cell)),
  );
  const rows = Math.max(asNumber(raw.rows, cells.length), 1);
  const cols = Math.max(
    asNumber(raw.cols, cells.reduce((max, row) => Math.max(max, row.length), 0)),
    1,
  );
  return {
    kind: 'spreadsheet',
    cells: padSheet(cells.length > 0 ? cells : defaultSpreadsheet().cells, rows, cols),
  };
}

function parseBudget(raw: Record<string, unknown>): BudgetTool {
  const items = asList(raw.items).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      date: asString(item.date),
      label: asString(item.label) || asString(item.title) || asString(item.name),
      category: asString(item.category),
      amount: Math.max(asNumber(item.amount), 0),
      flow: parseBudgetFlow(item.flow ?? item.kind ?? item.type),
    };
  });
  return {
    kind: 'budget',
    currency: asString(raw.currency, '$') || '$',
    items: items.length > 0 ? items : defaultBudget().items,
  };
}

function parseCalendarTool(raw: Record<string, unknown>): CalendarTool {
  const now = new Date();
  const events = asList(raw.events).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      date: asString(item.date),
      title: asString(item.title) || asString(item.label),
    };
  });
  const year = asNumber(raw.year, now.getFullYear());
  const month = asNumber(raw.month, now.getMonth() + 1);
  return {
    kind: 'calendar',
    year: year >= 1970 && year <= 9999 ? Math.round(year) : now.getFullYear(),
    month: month >= 1 && month <= 12 ? Math.round(month) : now.getMonth() + 1,
    events,
  };
}

function parseHabit(raw: Record<string, unknown>): HabitTool {
  const habits = asList(raw.habits).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      title: asString(item.title) || asString(item.text),
      stamps: asList(item.stamps).map((stamp) => asString(stamp)).filter(Boolean),
    };
  });
  const days = Math.min(Math.max(Math.round(asNumber(raw.days, 7)) || 7, 1), 31);
  return {
    kind: 'habit',
    days,
    habits: habits.length > 0 ? habits : defaultHabit().habits,
  };
}

function parseCountdown(raw: Record<string, unknown>): CountdownTool {
  const items = asList(raw.items).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      title: asString(item.title) || asString(item.label),
      date: asString(item.date),
    };
  });
  return {
    kind: 'countdown',
    items: items.length > 0 ? items : defaultCountdown().items,
  };
}

function parseSchedule(raw: Record<string, unknown>): ScheduleTool {
  const items = asList(raw.items).map((entry) => {
    const item = asRecord(entry);
    return {
      id: asString(item.id) || newPageToolId(),
      day: parseWeekDay(item.day),
      start: asString(item.start),
      end: asString(item.end),
      title: asString(item.title) || asString(item.label),
    };
  });
  return {
    kind: 'schedule',
    items: items.length > 0 ? items : defaultSchedule().items,
  };
}

export function defaultBoard(): BoardTool {
  return {
    kind: 'board',
    columns: [
      { id: newPageToolId(), title: 'To do', cards: [] },
      { id: newPageToolId(), title: 'In progress', cards: [] },
      { id: newPageToolId(), title: 'Done', cards: [] },
    ],
  };
}

export function defaultChecklist(): ChecklistTool {
  return {
    kind: 'checklist',
    items: [
      { id: newPageToolId(), text: '', checked: false },
      { id: newPageToolId(), text: '', checked: false },
      { id: newPageToolId(), text: '', checked: false },
    ],
  };
}

export function defaultAssigner(): AssignerTool {
  return {
    kind: 'assigner',
    tasks: [{ id: newPageToolId(), title: '', assigneeId: null, assigneeName: null, status: 'todo' }],
  };
}

export function defaultPoll(): PollTool {
  return {
    kind: 'poll',
    question: '',
    options: [
      { id: newPageToolId(), label: '', voterIds: [] },
      { id: newPageToolId(), label: '', voterIds: [] },
    ],
  };
}

export function defaultTimeline(): TimelineTool {
  return {
    kind: 'timeline',
    items: [
      { id: newPageToolId(), title: '', date: '', done: false },
      { id: newPageToolId(), title: '', date: '', done: false },
    ],
  };
}

export function defaultDecision(): DecisionTool {
  return {
    kind: 'decision',
    question: '',
    options: [
      { id: newPageToolId(), label: '' },
      { id: newPageToolId(), label: '' },
    ],
    chosenId: null,
    notes: '',
  };
}

export function defaultGoals(): GoalsTool {
  return {
    kind: 'goals',
    items: [{ id: newPageToolId(), title: '', current: 0, target: 100, unit: '%' }],
  };
}

export function defaultSpreadsheet(): SpreadsheetTool {
  return {
    kind: 'spreadsheet',
    cells: padSheet([], 6, 4),
  };
}

export function defaultBudget(): BudgetTool {
  return {
    kind: 'budget',
    currency: '$',
    items: [
      { id: newPageToolId(), date: '', label: '', category: '', amount: 0, flow: 'income' },
      { id: newPageToolId(), date: '', label: '', category: '', amount: 0, flow: 'expense' },
    ],
  };
}

export function defaultCalendar(): CalendarTool {
  const now = new Date();
  return {
    kind: 'calendar',
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    events: [],
  };
}

export function defaultHabit(): HabitTool {
  return {
    kind: 'habit',
    days: 7,
    habits: [
      { id: newPageToolId(), title: '', stamps: [] },
      { id: newPageToolId(), title: '', stamps: [] },
    ],
  };
}

export function defaultCountdown(): CountdownTool {
  return {
    kind: 'countdown',
    items: [{ id: newPageToolId(), title: '', date: '' }],
  };
}

export function defaultSchedule(): ScheduleTool {
  return {
    kind: 'schedule',
    items: WEEK_DAYS.slice(0, 5).map((day) => ({
      id: newPageToolId(),
      day,
      start: '',
      end: '',
      title: '',
    })),
  };
}

export function defaultPageTool(type: PageToolType): PageToolPayload {
  switch (type) {
    case 'board':
      return defaultBoard();
    case 'checklist':
      return defaultChecklist();
    case 'assigner':
      return defaultAssigner();
    case 'poll':
      return defaultPoll();
    case 'timeline':
      return defaultTimeline();
    case 'decision':
      return defaultDecision();
    case 'goals':
      return defaultGoals();
    case 'spreadsheet':
      return defaultSpreadsheet();
    case 'budget':
      return defaultBudget();
    case 'calendar':
      return defaultCalendar();
    case 'habit':
      return defaultHabit();
    case 'countdown':
      return defaultCountdown();
    case 'schedule':
      return defaultSchedule();
  }
}

/** Read a tool payload from block content or draft props. Unknown shapes
 * fall back to a usable empty tool of `type` so the editor never crashes. */
export function parsePageTool(type: PageToolType, value: unknown): PageToolPayload {
  const raw = asRecord(value);
  const kind = isPageToolType(asString(raw.kind)) ? (raw.kind as PageToolType) : type;
  switch (kind) {
    case 'board':
      return parseBoard(raw);
    case 'checklist':
      return parseChecklist(raw);
    case 'assigner':
      return parseAssigner(raw);
    case 'poll':
      return parsePoll(raw);
    case 'timeline':
      return parseTimeline(raw);
    case 'decision':
      return parseDecision(raw);
    case 'goals':
      return parseGoals(raw);
    case 'spreadsheet':
      return parseSpreadsheet(raw);
    case 'budget':
      return parseBudget(raw);
    case 'calendar':
      return parseCalendarTool(raw);
    case 'habit':
      return parseHabit(raw);
    case 'countdown':
      return parseCountdown(raw);
    case 'schedule':
      return parseSchedule(raw);
  }
}

export function pageToolPlainText(payload: PageToolPayload): string {
  switch (payload.kind) {
    case 'board':
      return payload.columns
        .flatMap((column) => [column.title, ...column.cards.map((card) => card.title)])
        .filter(Boolean)
        .join(' ');
    case 'checklist':
      return payload.items.map((item) => item.text).filter(Boolean).join(' ');
    case 'assigner':
      return payload.tasks
        .flatMap((task) => [task.title, task.assigneeName ?? ''])
        .filter(Boolean)
        .join(' ');
    case 'poll':
      return [payload.question, ...payload.options.map((option) => option.label)].filter(Boolean).join(' ');
    case 'timeline':
      return payload.items.flatMap((item) => [item.title, item.date]).filter(Boolean).join(' ');
    case 'decision':
      return [payload.question, ...payload.options.map((option) => option.label), payload.notes]
        .filter(Boolean)
        .join(' ');
    case 'goals':
      return payload.items.map((item) => item.title).filter(Boolean).join(' ');
    case 'spreadsheet':
      return sheetPlainText(payload.cells);
    case 'budget':
      return payload.items
        .flatMap((item) => [item.label, item.category, item.date])
        .filter(Boolean)
        .join(' ');
    case 'calendar':
      return payload.events.flatMap((item) => [item.title, item.date]).filter(Boolean).join(' ');
    case 'habit':
      return payload.habits.map((item) => item.title).filter(Boolean).join(' ');
    case 'countdown':
      return payload.items.flatMap((item) => [item.title, item.date]).filter(Boolean).join(' ');
    case 'schedule':
      return payload.items.flatMap((item) => [item.title, item.day, item.start]).filter(Boolean).join(' ');
  }
}
