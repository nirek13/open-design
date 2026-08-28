import type Database from 'better-sqlite3';

const JOURNAL_MODES = new Set(['delete', 'truncate', 'memory', 'off', 'wal']);

/** SQLite journal mode for this process. WAL is the local default; hosted
 * EFS/NFS must use DELETE — WAL + two Fargate tasks on one volume is how
 * `database disk image is malformed` showed up in production. */
export function sqliteJournalMode(env: NodeJS.ProcessEnv = process.env): string {
  const requested = String(env.OD_SQLITE_JOURNAL_MODE ?? 'wal').trim().toLowerCase();
  return JOURNAL_MODES.has(requested) ? requested : 'wal';
}

export function applySqliteRuntimePragmas(db: Database.Database, env: NodeJS.ProcessEnv = process.env): void {
  db.pragma(`journal_mode = ${sqliteJournalMode(env)}`);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}
