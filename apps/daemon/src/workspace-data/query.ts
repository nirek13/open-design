// Typed record queries compiled to parameterized SQL over
// json_extract(data_json, ...). Field references are whitelisted against the
// table schema (plus the daemon-owned id/created_at/updated_at columns), so
// no caller-controlled string ever reaches SQL as an identifier — values are
// always bound parameters.

import type Database from 'better-sqlite3';
import type {
  JsonValue,
  QueryWorkspaceRecordsRequest,
  WorkspaceRecord,
  WorkspaceRecordFilter,
  WorkspaceTable,
} from '@open-design/contracts';
import { workspaceValidationError } from './errors.js';
import { normalizeRecordRow } from './records.js';

type SqliteDb = Database.Database;

const RECORD_COLS = `
  id, table_id AS tableId, data_json AS dataJson, revision,
  created_by_kind AS createdByKind, created_by_id AS createdById,
  created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
`;

const BUILTIN_FIELD_EXPRS: Record<string, string> = {
  id: 'id',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is-null', 'not-null']);

interface QueryCursor {
  /** Sort value of the last row (null when the sort expression was NULL). */
  v: JsonValue | null;
  id: string;
}

function decodeCursor(cursor: string): QueryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.id === 'string') return { v: parsed.v ?? null, id: parsed.id };
  } catch {
    // fall through
  }
  throw workspaceValidationError([{ path: 'cursor', message: 'invalid cursor' }]);
}

function encodeCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function fieldExpr(table: WorkspaceTable, name: string): string | null {
  if (BUILTIN_FIELD_EXPRS[name]) return BUILTIN_FIELD_EXPRS[name];
  const field = table.fields.find((candidate) => candidate.name === name);
  // Field names matched WORKSPACE_NAME_PATTERN at schema time, so the JSON
  // path interpolation cannot escape the literal.
  return field ? `json_extract(data_json, '$.${field.name}')` : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function compileFilter(
  table: WorkspaceTable,
  filter: WorkspaceRecordFilter,
  index: number,
  params: unknown[],
): string {
  const path = `filters[${index}]`;
  if (!filter || typeof filter.field !== 'string' || !FILTER_OPS.has(filter.op)) {
    throw workspaceValidationError([{ path, message: 'filter must have a field and a valid op' }]);
  }
  const expr = fieldExpr(table, filter.field);
  if (!expr) {
    throw workspaceValidationError([{ path: `${path}.field`, message: `unknown field '${filter.field}'` }]);
  }
  switch (filter.op) {
    case 'is-null':
      return `${expr} IS NULL`;
    case 'not-null':
      return `${expr} IS NOT NULL`;
    case 'in': {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
        throw workspaceValidationError([{ path: `${path}.value`, message: 'in requires a non-empty array (max 100)' }]);
      }
      for (const item of filter.value) params.push(item);
      return `${expr} IN (${filter.value.map(() => '?').join(', ')})`;
    }
    case 'contains': {
      if (typeof filter.value !== 'string') {
        throw workspaceValidationError([{ path: `${path}.value`, message: 'contains requires a string value' }]);
      }
      params.push(`%${escapeLike(filter.value)}%`);
      return `${expr} LIKE ? ESCAPE '\\'`;
    }
    default: {
      if (filter.value === undefined || filter.value === null || typeof filter.value === 'object') {
        throw workspaceValidationError([{ path: `${path}.value`, message: `${filter.op} requires a scalar value` }]);
      }
      const sqlOp = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
      params.push(filter.value);
      return `${expr} ${sqlOp} ?`;
    }
  }
}

export interface RecordsPage {
  records: WorkspaceRecord[];
  nextCursor: string | null;
}

export function queryRecords(
  db: SqliteDb,
  table: WorkspaceTable,
  request: QueryWorkspaceRecordsRequest = {},
): RecordsPage {
  const limit = Math.min(200, Math.max(1, request.limit ?? 50));
  const params: unknown[] = [table.id];
  const where: string[] = ['table_id = ?'];
  if (!request.includeDeleted) where.push('deleted_at IS NULL');
  (request.filters ?? []).forEach((filter, index) => {
    where.push(compileFilter(table, filter, index, params));
  });

  const sortField = request.sort?.field ?? 'created_at';
  const direction = request.sort?.direction === 'desc' ? 'DESC' : 'ASC';
  const sortExpr = fieldExpr(table, sortField);
  if (!sortExpr) {
    throw workspaceValidationError([{ path: 'sort.field', message: `unknown field '${sortField}'` }]);
  }

  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    // Keyset pagination over (sortExpr, id). SQLite orders NULLs first in ASC
    // and last in DESC, so the null/non-null boundary needs explicit clauses.
    if (direction === 'ASC') {
      if (cursor.v === null) {
        where.push(`((${sortExpr} IS NULL AND id > ?) OR ${sortExpr} IS NOT NULL)`);
        params.push(cursor.id);
      } else {
        where.push(`(${sortExpr} > ? OR (${sortExpr} = ? AND id > ?))`);
        params.push(cursor.v, cursor.v, cursor.id);
      }
    } else if (cursor.v === null) {
      where.push(`(${sortExpr} IS NULL AND id > ?)`);
      params.push(cursor.id);
    } else {
      where.push(`(${sortExpr} < ? OR (${sortExpr} = ? AND id > ?) OR ${sortExpr} IS NULL)`);
      params.push(cursor.v, cursor.v, cursor.id);
    }
  }

  const rows = db
    .prepare(
      `SELECT ${RECORD_COLS}, ${sortExpr} AS sortValue FROM od_records
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortExpr} ${direction}, id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, any>>;

  const records = rows.map((row) => {
    const { sortValue, ...rest } = row;
    void sortValue;
    return normalizeRecordRow(rest);
  });
  const lastRow = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && lastRow
      ? encodeCursor({ v: (lastRow.sortValue ?? null) as JsonValue | null, id: lastRow.id })
      : null;
  return { records, nextCursor };
}
