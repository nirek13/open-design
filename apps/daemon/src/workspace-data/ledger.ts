// Double-entry accounting.
//
// The rules this module exists to enforce, none of which are negotiable by
// anything upstream:
//
//   - An entry posts only if debits equal credits, per currency.
//   - A posted entry is never edited or deleted. Corrections are reversing
//     entries that link back to what they correct.
//   - Nothing posts into a closed period.
//   - Amounts are integer minor units. A float never reaches an amount.
//
// The database enforces the immutability half with triggers as well, so a
// future refactor cannot quietly turn the guarantee into a convention.

import { randomUUID } from 'node:crypto';
import {
  LEDGER_ACCOUNT_TYPES,
  isDebitNormal,
  type CreateJournalEntryRequest,
  type CreateLedgerAccountRequest,
  type JournalEntry,
  type JournalLine,
  type JournalLineInput,
  type JournalSource,
  type LedgerAccount,
  type LedgerAccountType,
  type LedgerPeriod,
  type TrialBalance,
  type TrialBalanceRow,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const ACCOUNT_COLS = `
  id, code, name, type, currency, archived_at AS "archivedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const ENTRY_COLS = `
  id, number, date, memo, currency, status, source_json AS "sourceJson",
  reversed_by_entry_id AS "reversedByEntryId", reverses_entry_id AS "reversesEntryId",
  posted_at AS "postedAt", posted_by AS "postedBy", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function assertDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw workspaceValidationError([{ path, message: 'expected a YYYY-MM-DD date' }]);
  }
  return value;
}

/** Amounts are integer minor units — cents, not dollars. A float here is
 * always a bug in the caller, and accepting one would let rounding error into
 * the books permanently. */
function assertAmount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw workspaceValidationError([
      { path, message: 'expected integer minor units (e.g. 1050 for 10.50)' },
    ]);
  }
  if (value <= 0) {
    throw workspaceValidationError([
      { path, message: 'amount must be positive; use the direction to express sign' },
    ]);
  }
  return value;
}

// --- Accounts -------------------------------------------------------------

export async function createLedgerAccount(
  db: SqlExecutor,
  orgId: string,
  input: CreateLedgerAccountRequest,
): Promise<LedgerAccount> {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!code) throw workspaceValidationError([{ path: 'code', message: 'code is required' }]);
  if (!name) throw workspaceValidationError([{ path: 'name', message: 'name is required' }]);
  if (!LEDGER_ACCOUNT_TYPES.includes(input.type)) {
    throw workspaceValidationError([
      { path: 'type', message: `type must be one of: ${LEDGER_ACCOUNT_TYPES.join(', ')}` },
    ]);
  }
  const existing = await db.get(
    'SELECT id FROM od_ledger_accounts WHERE workspace_id = ? AND code = ? AND archived_at IS NULL',
    [orgId, code],
  );
  if (existing) {
    throw new WorkspaceDataError('CONFLICT', 409, `account code ${code} already exists`);
  }
  const now = Date.now();
  const id = `acct-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_ledger_accounts
       (id, workspace_id, code, name, type, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, code, name, input.type, input.currency ?? 'USD', now, now],
  );
  return getLedgerAccount(db, orgId, id);
}

export async function getLedgerAccount(
  db: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<LedgerAccount> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${ACCOUNT_COLS} FROM od_ledger_accounts WHERE id = ? AND workspace_id = ?`,
    [accountId, orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('LEDGER_ACCOUNT_NOT_FOUND', 404, `account ${accountId} not found`);
  }
  return { ...(row as LedgerAccount), orgId, archivedAt: nullableNum(row.archivedAt), createdAt: num(row.createdAt), updatedAt: num(row.updatedAt) };
}

export async function listLedgerAccounts(db: SqlExecutor, orgId: string): Promise<LedgerAccount[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT ${ACCOUNT_COLS} FROM od_ledger_accounts
      WHERE workspace_id = ? AND archived_at IS NULL ORDER BY code ASC`,
    [orgId],
  );
  return rows.map((row) => ({
    ...(row as LedgerAccount),
    orgId,
    archivedAt: nullableNum(row.archivedAt),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  }));
}

async function resolveAccount(
  db: SqlExecutor,
  orgId: string,
  input: JournalLineInput,
  path: string,
): Promise<LedgerAccount> {
  if (input.accountId) return getLedgerAccount(db, orgId, input.accountId);
  if (input.accountCode) {
    const row = await db.get<{ id: string }>(
      'SELECT id FROM od_ledger_accounts WHERE workspace_id = ? AND code = ? AND archived_at IS NULL',
      [orgId, input.accountCode],
    );
    if (!row) {
      throw new WorkspaceDataError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        404,
        `no account with code ${input.accountCode}`,
      );
    }
    return getLedgerAccount(db, orgId, row.id);
  }
  throw workspaceValidationError([{ path, message: 'each line needs accountId or accountCode' }]);
}

// --- Periods --------------------------------------------------------------

export async function listLedgerPeriods(db: SqlExecutor, orgId: string): Promise<LedgerPeriod[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT id, start_date AS "startDate", end_date AS "endDate", status,
            closed_at AS "closedAt", closed_by AS "closedBy", created_at AS "createdAt"
       FROM od_ledger_periods WHERE workspace_id = ? ORDER BY start_date DESC`,
    [orgId],
  );
  return rows.map((row) => ({
    ...(row as LedgerPeriod),
    orgId,
    closedAt: nullableNum(row.closedAt),
    createdAt: num(row.createdAt),
  }));
}

/** Refuse a posting whose date falls inside a closed period. This is what
 * makes a reported figure final — once a month is closed, its numbers cannot
 * move underneath whoever already read them. */
async function assertPeriodOpen(db: SqlExecutor, orgId: string, date: string): Promise<void> {
  const row = await db.get<{ id: string; startDate: string; endDate: string }>(
    `SELECT id, start_date AS "startDate", end_date AS "endDate" FROM od_ledger_periods
      WHERE workspace_id = ? AND status = 'closed' AND start_date <= ? AND end_date >= ?`,
    [orgId, date, date],
  );
  if (row) {
    throw new WorkspaceDataError(
      'LEDGER_PERIOD_CLOSED',
      409,
      `${date} falls in a closed period (${row.startDate} to ${row.endDate}); post to an open period or reopen it`,
    );
  }
}

export async function closeLedgerPeriod(
  db: SqlExecutor,
  orgId: string,
  input: { startDate: string; endDate: string; closedBy: string },
): Promise<LedgerPeriod> {
  const startDate = assertDate(input.startDate, 'startDate');
  const endDate = assertDate(input.endDate, 'endDate');
  if (endDate < startDate) {
    throw workspaceValidationError([{ path: 'endDate', message: 'endDate must not precede startDate' }]);
  }
  const draftsInRange = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM od_journal_entries
      WHERE workspace_id = ? AND status = 'draft' AND date >= ? AND date <= ?`,
    [orgId, startDate, endDate],
  );
  if (num(draftsInRange?.n ?? 0) > 0) {
    throw new WorkspaceDataError(
      'CONFLICT',
      409,
      `${num(draftsInRange!.n)} draft entries fall in this period; post or discard them before closing`,
    );
  }
  const now = Date.now();
  const id = `per-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_ledger_periods
       (id, workspace_id, start_date, end_date, status, closed_at, closed_by, created_at)
     VALUES (?, ?, ?, ?, 'closed', ?, ?, ?)`,
    [id, orgId, startDate, endDate, now, input.closedBy, now],
  );
  return (await listLedgerPeriods(db, orgId)).find((period) => period.id === id)!;
}

// --- Entries --------------------------------------------------------------

async function loadLines(db: SqlExecutor, entryId: string): Promise<JournalLine[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT l.id, l.entry_id AS "entryId", l.account_id AS "accountId",
            a.code AS "accountCode", a.name AS "accountName",
            l.direction, l.amount, l.memo, l.position
       FROM od_journal_lines l JOIN od_ledger_accounts a ON a.id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.position ASC`,
    [entryId],
  );
  return rows.map((row) => ({ ...(row as JournalLine), amount: num(row.amount), position: num(row.position) }));
}

function parseSource(raw: unknown): JournalSource {
  if (typeof raw !== 'string') return { kind: 'manual' };
  try {
    return JSON.parse(raw) as JournalSource;
  } catch {
    return { kind: 'manual' };
  }
}

export async function getJournalEntry(
  db: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<JournalEntry> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${ENTRY_COLS} FROM od_journal_entries WHERE id = ? AND workspace_id = ?`,
    [entryId, orgId],
  );
  if (!row) {
    throw new WorkspaceDataError('LEDGER_ENTRY_NOT_FOUND', 404, `entry ${entryId} not found`);
  }
  const { sourceJson, ...rest } = row;
  return {
    ...(rest as JournalEntry),
    orgId,
    number: nullableNum(row.number),
    source: parseSource(sourceJson),
    postedAt: nullableNum(row.postedAt),
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
    lines: await loadLines(db, entryId),
  };
}

export interface ListEntriesOptions {
  status?: 'draft' | 'posted' | 'reversed';
  limit?: number;
  /** Only entries produced by this document. */
  sourceRecordId?: string;
}

export async function listJournalEntries(
  db: SqlExecutor,
  orgId: string,
  options: ListEntriesOptions = {},
): Promise<JournalEntry[]> {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [orgId];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.sourceRecordId) {
    // Source is stored as JSON; a LIKE on the record id is enough to find the
    // entries a document produced without adding a second index.
    where.push('source_json LIKE ?');
    params.push(`%${options.sourceRecordId}%`);
  }
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const rows = await db.all<Record<string, any>>(
    `SELECT ${ENTRY_COLS} FROM od_journal_entries
      WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ?`,
    [...params, limit],
  );
  const entries: JournalEntry[] = [];
  for (const row of rows) {
    const { sourceJson, ...rest } = row;
    entries.push({
      ...(rest as JournalEntry),
      orgId,
      number: nullableNum(row.number),
      source: parseSource(sourceJson),
      postedAt: nullableNum(row.postedAt),
      createdAt: num(row.createdAt),
      updatedAt: num(row.updatedAt),
      lines: await loadLines(db, row.id),
    });
  }
  return entries;
}

export interface BalanceCheck {
  debit: number;
  credit: number;
  balanced: boolean;
}

export function checkBalance(lines: Array<{ direction: string; amount: number }>): BalanceCheck {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (line.direction === 'debit') debit += line.amount;
    else credit += line.amount;
  }
  return { debit, credit, balanced: debit === credit };
}

/** Create and post an entry in one step. There is no way to post an entry
 * that has not been through this function, which is where balance, period,
 * and amount checks live. */
export async function postJournalEntry(
  db: SqlExecutor,
  orgId: string,
  postedBy: string,
  input: CreateJournalEntryRequest,
): Promise<JournalEntry> {
  const date = assertDate(input.date, 'date');
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw workspaceValidationError([
      { path: 'lines', message: 'a journal entry needs at least two lines' },
    ]);
  }
  await assertPeriodOpen(db, orgId, date);

  const resolved: Array<{ account: LedgerAccount; direction: 'debit' | 'credit'; amount: number; memo: string | null }> = [];
  for (const [index, line] of input.lines.entries()) {
    const path = `lines[${index}]`;
    if (line.direction !== 'debit' && line.direction !== 'credit') {
      throw workspaceValidationError([{ path: `${path}.direction`, message: "direction must be 'debit' or 'credit'" }]);
    }
    const account = await resolveAccount(db, orgId, line, path);
    resolved.push({
      account,
      direction: line.direction,
      amount: assertAmount(line.amount, `${path}.amount`),
      memo: line.memo?.trim() || null,
    });
  }

  const currency = input.currency ?? resolved[0]!.account.currency;
  const mismatched = resolved.find((line) => line.account.currency !== currency);
  if (mismatched) {
    throw workspaceValidationError([
      {
        path: 'currency',
        message: `account ${mismatched.account.code} is in ${mismatched.account.currency}, not ${currency}; an entry cannot mix currencies`,
      },
    ]);
  }

  const balance = checkBalance(resolved);
  if (!balance.balanced) {
    throw new WorkspaceDataError(
      'LEDGER_UNBALANCED',
      422,
      `debits (${balance.debit}) do not equal credits (${balance.credit})`,
      { debit: balance.debit, credit: balance.credit },
    );
  }

  const now = Date.now();
  const id = `je-${randomUUID()}`;
  await db.transaction(async (tx) => {
    const maxRow = await tx.get<{ n: number | string | null }>(
      'SELECT MAX(number) AS n FROM od_journal_entries WHERE workspace_id = ?',
      [orgId],
    );
    const nextNumber = num(maxRow?.n ?? 0) + 1;
    await tx.run(
      `INSERT INTO od_journal_entries
         (id, workspace_id, number, date, memo, currency, status, source_json,
          posted_at, posted_by, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        orgId,
        nextNumber,
        date,
        input.memo?.trim() || null,
        currency,
        JSON.stringify(input.source ?? { kind: 'manual' }),
        now,
        postedBy,
        postedBy,
        now,
        now,
      ],
    );
    for (const [position, line] of resolved.entries()) {
      await tx.run(
        `INSERT INTO od_journal_lines (id, entry_id, account_id, direction, amount, memo, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`jl-${randomUUID()}`, id, line.account.id, line.direction, line.amount, line.memo, position],
      );
    }
  });
  return getJournalEntry(db, orgId, id);
}

/** Correct a posted entry by posting its mirror image. The original stays
 * exactly as it was — that is the point — and the two link to each other so
 * anyone reading the books can see what happened and why. */
export async function reverseJournalEntry(
  db: SqlExecutor,
  orgId: string,
  entryId: string,
  postedBy: string,
  options: { date?: string; memo?: string } = {},
): Promise<{ original: JournalEntry; reversal: JournalEntry }> {
  const original = await getJournalEntry(db, orgId, entryId);
  if (original.status !== 'posted') {
    throw new WorkspaceDataError(
      'PROPOSAL_STATE_INVALID',
      409,
      `only a posted entry can be reversed; this one is ${original.status}`,
    );
  }
  const date = options.date ? assertDate(options.date, 'date') : original.date;
  await assertPeriodOpen(db, orgId, date);

  const reversal = await postJournalEntry(db, orgId, postedBy, {
    date,
    memo: options.memo?.trim() || `Reversal of entry ${original.number ?? original.id}`,
    currency: original.currency,
    source: original.source,
    lines: original.lines.map((line) => ({
      accountId: line.accountId,
      direction: line.direction === 'debit' ? 'credit' : 'debit',
      amount: line.amount,
      ...(line.memo ? { memo: line.memo } : {}),
    })),
  });

  // The trigger permits exactly this transition on a posted entry.
  await db.run(
    "UPDATE od_journal_entries SET status = 'reversed', reversed_by_entry_id = ?, updated_at = ? WHERE id = ?",
    [reversal.id, Date.now(), original.id],
  );
  await db.run('UPDATE od_journal_entries SET reverses_entry_id = ? WHERE id = ?', [
    original.id,
    reversal.id,
  ]);

  return {
    original: await getJournalEntry(db, orgId, original.id),
    reversal: await getJournalEntry(db, orgId, reversal.id),
  };
}

// --- Reporting ------------------------------------------------------------

export async function trialBalance(
  db: SqlExecutor,
  orgId: string,
  options: { asOf?: string; currency?: string } = {},
): Promise<TrialBalance> {
  const asOf = options.asOf ? assertDate(options.asOf, 'asOf') : new Date().toISOString().slice(0, 10);
  const currency = options.currency ?? 'USD';
  const rows = await db.all<Record<string, any>>(
    `SELECT a.id AS "accountId", a.code, a.name, a.type,
            COALESCE(SUM(CASE WHEN l.direction = 'debit'  THEN l.amount ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE 0 END), 0) AS credit
       FROM od_ledger_accounts a
       LEFT JOIN od_journal_lines l ON l.account_id = a.id
       LEFT JOIN od_journal_entries e ON e.id = l.entry_id
            AND e.status = 'posted' AND e.date <= ?
      WHERE a.workspace_id = ? AND a.archived_at IS NULL AND a.currency = ?
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code ASC`,
    [asOf, orgId, currency],
  );

  let totalDebit = 0;
  let totalCredit = 0;
  const out: TrialBalanceRow[] = rows.map((row) => {
    const debit = num(row.debit);
    const credit = num(row.credit);
    totalDebit += debit;
    totalCredit += credit;
    const type = row.type as LedgerAccountType;
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type,
      debit,
      credit,
      // Report each account in its own normal direction so a healthy revenue
      // account reads positive rather than confusingly negative.
      balance: isDebitNormal(type) ? debit - credit : credit - debit,
    };
  });

  return {
    currency,
    asOf,
    rows: out,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

/** Create the starting chart of accounts. Idempotent: codes that already
 * exist are left alone, so calling it twice is harmless. */
export async function seedChartOfAccounts(
  db: SqlExecutor,
  orgId: string,
  accounts: ReadonlyArray<{ code: string; name: string; type: LedgerAccountType }>,
  currency = 'USD',
): Promise<number> {
  let created = 0;
  for (const account of accounts) {
    const existing = await db.get(
      'SELECT id FROM od_ledger_accounts WHERE workspace_id = ? AND code = ?',
      [orgId, account.code],
    );
    if (existing) continue;
    await createLedgerAccount(db, orgId, { ...account, currency });
    created += 1;
  }
  return created;
}
