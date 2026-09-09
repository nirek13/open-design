import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  createChannel,
  editMessage,
  deleteMessage,
  postMessage,
  searchMessages,
} from '../src/workspace-data/chat.js';

describe('chat search', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-search-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);
  const me = 'wsm-me';

  async function seed() {
    const general = await createChannel(db(), orgId, me, { displayName: 'General' });
    const deals = await createChannel(db(), orgId, me, { displayName: 'Deals' });
    await postMessage(db(), orgId, general.slug, me, { body: 'the invoice is overdue' });
    await postMessage(db(), orgId, general.slug, 'wsm-ada', { body: 'shipping the release today' });
    await postMessage(db(), orgId, deals.slug, 'wsm-ada', { body: 'invoice INV-1042 signed' });
    return { general, deals };
  }

  it('builds the full-text index on SQLite', async () => {
    // The migration creates od_chat_fts inside a try/catch so a SQLite without
    // FTS5 still migrates. better-sqlite3 ships with it, so if this ever fails
    // the bundled engine changed and search has silently dropped to a scan.
    const row = await db().get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'od_chat_fts'",
    );
    expect(row?.name).toBe('od_chat_fts');
  });

  it('finds a word anywhere in the body', async () => {
    await seed();
    const hits = await searchMessages(db(), orgId, me, 'invoice');
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.message.body.includes('invoice'))).toBe(true);
  });

  it('completes on a prefix, so results appear while you are still typing', async () => {
    await seed();
    const hits = await searchMessages(db(), orgId, me, 'ship');
    expect(hits.some((hit) => hit.message.body.includes('shipping'))).toBe(true);
  });

  it('requires every term rather than any of them', async () => {
    await seed();
    expect(await searchMessages(db(), orgId, me, 'invoice overdue')).toHaveLength(1);
    expect(await searchMessages(db(), orgId, me, 'invoice nonexistent')).toHaveLength(0);
  });

  it('does not throw on punctuation a search box will certainly receive', async () => {
    // A raw FTS5 query is a small language of its own — `NEAR`, `*`, `:`, an
    // unbalanced quote are all syntax. A search box that shows the person a
    // parse error is broken, so every term is quoted.
    await seed();
    for (const query of ['"', 'a AND', 'NEAR(', 'x*', 'a:b', '((']) {
      await expect(searchMessages(db(), orgId, me, query)).resolves.toBeInstanceOf(Array);
    }
  });

  it('keeps the index in step with edits and deletes', async () => {
    const { general } = await seed();
    const message = await postMessage(db(), orgId, general.slug, me, { body: 'aardvark' });
    expect(await searchMessages(db(), orgId, me, 'aardvark')).toHaveLength(1);

    await editMessage(db(), orgId, message.id, me, 'banana');
    expect(await searchMessages(db(), orgId, me, 'aardvark')).toHaveLength(0);
    expect(await searchMessages(db(), orgId, me, 'banana')).toHaveLength(1);

    // Delete is a soft delete, so the row stays in the index and the WHERE
    // clause is what excludes it. Worth pinning: an index that disagrees with
    // the table shows deleted messages in search.
    await deleteMessage(db(), orgId, message.id, me);
    expect(await searchMessages(db(), orgId, me, 'banana')).toHaveLength(0);
  });

  it('honours the in: and from: modifiers alongside the text', async () => {
    const { deals } = await seed();
    const scoped = await searchMessages(db(), orgId, me, `invoice in:${deals.slug}`);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.channelSlug).toBe(deals.slug);

    const byAda = await searchMessages(db(), orgId, me, 'invoice', undefined, 'wsm-ada');
    expect(byAda).toHaveLength(1);
    expect(byAda[0]?.message.authorMemberId).toBe('wsm-ada');
  });

  it('never returns a private channel the caller is not in', async () => {
    // A search result is a read. Leaking one here would defeat the rule that a
    // private channel is invisible rather than merely closed.
    const secret = await createChannel(db(), orgId, 'wsm-ada', {
      displayName: 'Board comp',
      visibility: 'private',
    });
    await postMessage(db(), orgId, secret.slug, 'wsm-ada', { body: 'invoice for the board' });
    expect(await searchMessages(db(), orgId, me, 'invoice')).toHaveLength(0);
    expect(await searchMessages(db(), orgId, 'wsm-ada', 'invoice')).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', async () => {
    await seed();
    expect(await searchMessages(db(), orgId, me, '   ')).toHaveLength(0);
  });
});
