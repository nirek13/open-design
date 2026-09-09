import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHAT_EVENT_RETENTION_MS } from '@open-design/contracts';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { createChannel, postMessage } from '../src/workspace-data/chat.js';
import {
  appendChatEvent,
  currentChatSeq,
  pruneChatEvents,
  replayChatEvents,
} from '../src/workspace-data/chat-events.js';

describe('the chat event log', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-events-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  async function aMessage(body = 'hello') {
    const channel = await createChannel(db(), orgId, 'wsm-a', { displayName: 'General' });
    const message = await postMessage(db(), orgId, channel.slug, 'wsm-a', { body });
    return { channel, message };
  }

  it('hands out sequence numbers that only ever go up', async () => {
    const { message } = await aMessage();
    const first = await appendChatEvent(db(), orgId, {
      type: 'message-posted',
      channelId: message.channelId,
      message,
    });
    const second = await appendChatEvent(db(), orgId, {
      type: 'message-deleted',
      channelId: message.channelId,
      messageId: message.id,
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(await currentChatSeq(db(), orgId)).toBe(2);
  });

  it('never issues the same number twice under concurrent appends', async () => {
    // The reason the counter is an upsert rather than MAX(seq) + 1. Two writers
    // reading the same maximum would both claim it, and the unique index would
    // turn a race into a lost message.
    const { message } = await aMessage();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        appendChatEvent(db(), orgId, {
          type: 'message-posted',
          channelId: message.channelId,
          message,
        }),
      ),
    );
    const seqs = results.map((row) => row.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(25);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it('replays only what came after the cursor', async () => {
    const { message } = await aMessage();
    for (let index = 0; index < 5; index += 1) {
      await appendChatEvent(db(), orgId, {
        type: 'message-posted',
        channelId: message.channelId,
        message: { ...message, id: `msg-${index}` },
      });
    }
    const replay = await replayChatEvents(db(), orgId, 2);
    expect(replay.events.map((row) => row.seq)).toEqual([3, 4, 5]);
    expect(replay.truncated).toBe(false);
    expect(replay.seq).toBe(5);
  });

  it('reports nothing to replay for a client that is already current', async () => {
    const { message } = await aMessage();
    await appendChatEvent(db(), orgId, {
      type: 'message-posted',
      channelId: message.channelId,
      message,
    });
    const replay = await replayChatEvents(db(), orgId, 1);
    expect(replay.events).toHaveLength(0);
    expect(replay.truncated).toBe(false);
  });

  it('says it is truncated when the events a client wants have been pruned', async () => {
    // A client that slept past the retention window must be told to reload
    // rather than handed a partial replay it would mistake for the whole thing.
    const { message } = await aMessage();
    for (let index = 0; index < 3; index += 1) {
      await appendChatEvent(db(), orgId, {
        type: 'message-posted',
        channelId: message.channelId,
        message,
      });
    }
    const future = Date.now() + CHAT_EVENT_RETENTION_MS + 60_000;
    expect(await pruneChatEvents(db(), orgId, future)).toBe(3);

    // The cursor is deliberately not reset by pruning, so a stale client's
    // position is still recognisable as being behind.
    await appendChatEvent(db(), orgId, {
      type: 'message-posted',
      channelId: message.channelId,
      message,
    });
    const replay = await replayChatEvents(db(), orgId, 1);
    expect(replay.truncated).toBe(true);
  });

  it('records the audience so a private event cannot be replayed to the room', async () => {
    const { message } = await aMessage();
    const stored = await appendChatEvent(
      db(),
      orgId,
      { type: 'message-posted', channelId: message.channelId, message },
      { audience: ['wsm-a', 'wsm-b'] },
    );
    expect(stored.audience).toEqual(['wsm-a', 'wsm-b']);
    const replay = await replayChatEvents(db(), orgId, 0);
    expect(replay.events[0]?.audience).toEqual(['wsm-a', 'wsm-b']);
  });

  it('refuses to log an ephemeral event', async () => {
    // Storing "someone is typing" would mean replaying it on reconnect, which
    // is worse than never knowing. Rejecting it here is cheaper than finding
    // out from a transcript that claims somebody typed four days ago.
    await expect(
      appendChatEvent(db(), orgId, {
        type: 'typing',
        typing: { channelId: 'chn-1', memberId: 'wsm-a', parentMessageId: null, expiresAt: 0 },
      }),
    ).rejects.toThrow(/ephemeral/);
  });
});
