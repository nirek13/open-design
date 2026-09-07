// Interactive tools that live inside a page block (kanban, checklist, …).
//
// These are Substrate-specific — Notion's equivalent is a database with a
// board/list view. We keep the payload on the block itself so a page can
// carry a working tool without standing up a workspace table.

export const PAGE_TOOL_TYPES = [
  'board',
  'checklist',
  'assigner',
  'poll',
  'timeline',
  'decision',
  'goals',
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

export type PageToolPayload =
  | BoardTool
  | ChecklistTool
  | AssignerTool
  | PollTool
  | TimelineTool
  | DecisionTool
  | GoalsTool;

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
  }
}
