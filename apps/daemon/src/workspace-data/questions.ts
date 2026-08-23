// Questions about your data, saved so the answer stays current.
//
// Someone asks "how much is overdue?" once. The question is stored as the
// query it resolved to — not as text to re-interpret — so re-running it a
// month later gives the same shape of answer against new data. Pinning one
// puts that live answer on the home screen.

import { randomUUID } from 'node:crypto';
import type {
  CreateSavedQuestionRequest,
  SavedQuestion,
  SavedQuestionAnswer,
  WidgetKind,
  WorkspaceRecordFilter,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import { resolveTable } from './schema.js';
import { queryRecords } from './query.js';
import type { SqlExecutor } from '../storage/sql.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

const QUESTION_COLS = `
  id, question, table_ref AS "tableRef", filters_json AS "filtersJson",
  aggregate_json AS "aggregateJson", kind, pinned_position AS "pinnedPosition",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const AGGREGATE_OPS = new Set(['count', 'sum', 'avg', 'min', 'max']);

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalize(row: Record<string, any>, orgId: string): SavedQuestion {
  return {
    id: row.id,
    orgId,
    question: row.question,
    tableRef: row.tableRef,
    filters: parseJson<unknown[]>(row.filtersJson, []),
    aggregate: parseJson<SavedQuestion['aggregate']>(row.aggregateJson, null),
    kind: row.kind as WidgetKind,
    pinnedPosition: row.pinnedPosition === null || row.pinnedPosition === undefined ? null : num(row.pinnedPosition),
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

export async function createSavedQuestion(
  db: SqlExecutor,
  recordsDb: RecordsDb,
  orgId: string,
  createdBy: string,
  input: CreateSavedQuestionRequest,
): Promise<SavedQuestion> {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question) {
    throw workspaceValidationError([{ path: 'question', message: 'question is required' }]);
  }
  // Resolve the table now so a saved question can never point at nothing.
  const table = resolveTable(recordsDb, input.tableRef);
  if (input.aggregate) {
    if (!AGGREGATE_OPS.has(input.aggregate.op)) {
      throw workspaceValidationError([
        { path: 'aggregate.op', message: `op must be one of: ${[...AGGREGATE_OPS].join(', ')}` },
      ]);
    }
    if (input.aggregate.op !== 'count') {
      const field = input.aggregate.field;
      if (!field || !table.fields.some((candidate) => candidate.name === field)) {
        throw workspaceValidationError([
          { path: 'aggregate.field', message: `'${field ?? ''}' is not a field on ${table.name}` },
        ]);
      }
    }
  }

  const now = Date.now();
  const id = `q-${randomUUID()}`;
  let position: number | null = null;
  if (input.pin) {
    const row = await db.get<{ n: number | string | null }>(
      'SELECT MAX(pinned_position) AS n FROM od_saved_questions WHERE workspace_id = ?',
      [orgId],
    );
    position = num(row?.n ?? -1) + 1;
  }
  await db.run(
    `INSERT INTO od_saved_questions
       (id, workspace_id, question, table_ref, filters_json, aggregate_json, kind,
        pinned_position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      question,
      table.name,
      JSON.stringify(input.filters ?? []),
      input.aggregate ? JSON.stringify(input.aggregate) : null,
      input.kind ?? (input.aggregate ? 'metric' : 'list'),
      position,
      createdBy,
      now,
      now,
    ],
  );
  return getSavedQuestion(db, orgId, id);
}

export async function getSavedQuestion(
  db: SqlExecutor,
  orgId: string,
  id: string,
): Promise<SavedQuestion> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${QUESTION_COLS} FROM od_saved_questions WHERE id = ? AND workspace_id = ?`,
    [id, orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('SAVED_QUESTION_NOT_FOUND', 404, `question ${id} not found`);
  }
  return normalize(row, orgId);
}

export async function listSavedQuestions(
  db: SqlExecutor,
  orgId: string,
  options: { pinnedOnly?: boolean } = {},
): Promise<SavedQuestion[]> {
  const where = options.pinnedOnly
    ? 'workspace_id = ? AND pinned_position IS NOT NULL'
    : 'workspace_id = ?';
  const rows = await db.all<Record<string, any>>(
    `SELECT ${QUESTION_COLS} FROM od_saved_questions WHERE ${where}
      ORDER BY pinned_position ASC NULLS LAST, created_at DESC`,
    [orgId],
  );
  return rows.map((row) => normalize(row, orgId));
}

export async function setQuestionPinned(
  db: SqlExecutor,
  orgId: string,
  id: string,
  pinned: boolean,
): Promise<SavedQuestion> {
  await getSavedQuestion(db, orgId, id);
  let position: number | null = null;
  if (pinned) {
    const row = await db.get<{ n: number | string | null }>(
      'SELECT MAX(pinned_position) AS n FROM od_saved_questions WHERE workspace_id = ?',
      [orgId],
    );
    position = num(row?.n ?? -1) + 1;
  }
  await db.run('UPDATE od_saved_questions SET pinned_position = ?, updated_at = ? WHERE id = ?', [
    position,
    Date.now(),
    id,
  ]);
  return getSavedQuestion(db, orgId, id);
}

export async function deleteSavedQuestion(db: SqlExecutor, orgId: string, id: string): Promise<void> {
  await getSavedQuestion(db, orgId, id);
  await db.run('DELETE FROM od_saved_questions WHERE id = ?', [id]);
}

/** Run a saved question against current data. */
export function answerQuestion(
  recordsDb: RecordsDb,
  question: SavedQuestion,
): SavedQuestionAnswer {
  const table = resolveTable(recordsDb, question.tableRef);
  const { records } = queryRecords(recordsDb, table, {
    filters: question.filters as WorkspaceRecordFilter[],
    limit: 200,
  });

  let value: number | null = null;
  if (question.aggregate) {
    const { op, field } = question.aggregate;
    if (op === 'count') {
      value = records.length;
    } else {
      const numbers = records
        .map((record) => record.data[field!])
        .filter((candidate): candidate is number => typeof candidate === 'number');
      if (numbers.length === 0) {
        // An empty set has no average or minimum; zero would be a lie, so
        // report nothing and let the UI say "no data".
        value = op === 'sum' ? 0 : null;
      } else if (op === 'sum') value = numbers.reduce((sum, n) => sum + n, 0);
      else if (op === 'avg') value = Math.round(numbers.reduce((sum, n) => sum + n, 0) / numbers.length);
      else if (op === 'min') value = Math.min(...numbers);
      else value = Math.max(...numbers);
    }
  }

  return {
    question,
    value,
    rows: question.kind === 'metric' ? [] : records.slice(0, 20).map((record) => ({ id: record.id, ...record.data })),
    count: records.length,
    answeredAt: Date.now(),
  };
}

export async function homeWidgets(
  db: SqlExecutor,
  recordsDb: RecordsDb,
  orgId: string,
): Promise<SavedQuestionAnswer[]> {
  const pinned = await listSavedQuestions(db, orgId, { pinnedOnly: true });
  const answers: SavedQuestionAnswer[] = [];
  for (const question of pinned) {
    try {
      answers.push(answerQuestion(recordsDb, question));
    } catch {
      // A widget whose table was archived should not take down the home
      // screen; drop it from the list instead.
    }
  }
  return answers;
}
