import { describe, expect, it } from 'vitest';

import { sqliteJournalMode } from '../src/storage/sqlite-pragmas.js';

describe('sqliteJournalMode', () => {
  it('defaults to wal and honors OD_SQLITE_JOURNAL_MODE=delete', () => {
    expect(sqliteJournalMode({})).toBe('wal');
    expect(sqliteJournalMode({ OD_SQLITE_JOURNAL_MODE: 'delete' })).toBe('delete');
    expect(sqliteJournalMode({ OD_SQLITE_JOURNAL_MODE: 'DELETE' })).toBe('delete');
    expect(sqliteJournalMode({ OD_SQLITE_JOURNAL_MODE: 'weird' })).toBe('wal');
  });
});
