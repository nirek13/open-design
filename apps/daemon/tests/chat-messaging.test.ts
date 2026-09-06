import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { createChannel, postMessage } from '../src/workspace-data/chat.js';
import {
  listActivity,
  listSaved,
  markChannelUnread,
  togglePin,
  toggleSave,
  updateChannelPrefs,
} from '../src/workspace-data/chat-messaging.js';

describe('Slack-shaped chat extras', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-msg-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  it('stars, mutes, pins, saves, and marks unread', async () => {
    const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
    const message = await postMessage(db(), orgId, channel.slug, 'wsm-other', {
      body: 'hello @channel',
      mentions: ['@channel'],
    });

    const starred = await updateChannelPrefs(db(), orgId, channel.slug, 'wsm-test', { starred: true });
    expect(starred.starred).toBe(true);

    const muted = await updateChannelPrefs(db(), orgId, channel.slug, 'wsm-test', { muted: true });
    expect(muted.muted).toBe(true);
    expect(muted.unreadCount).toBe(0);

    const pinned = await togglePin(db(), orgId, message.id, 'wsm-test');
    expect(pinned.pinned).toBe(true);

    const saved = await toggleSave(db(), orgId, message.id, 'wsm-test');
    expect(saved.saved).toBe(true);
    expect(await listSaved(db(), orgId, 'wsm-test')).toHaveLength(1);

    await updateChannelPrefs(db(), orgId, channel.slug, 'wsm-test', { muted: false, notify: 'all' });
    const unread = await markChannelUnread(db(), orgId, channel.slug, 'wsm-test', message.id);
    expect(unread.unreadCount).toBeGreaterThan(0);

    const activity = await listActivity(db(), orgId, 'wsm-test');
    expect(activity.some((item) => item.kind === 'mention')).toBe(true);
  });

  it('schedules a message and cancels it', async () => {
    const { scheduleMessage, listScheduled, cancelScheduled } = await import('../src/workspace-data/chat-messaging.js');
    const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'Sales' });
    const scheduled = await scheduleMessage(db(), orgId, channel.slug, 'wsm-test', {
      body: 'later',
      sendAt: Date.now() + 60_000,
    });
    expect(await listScheduled(db(), orgId, 'wsm-test')).toHaveLength(1);
    await cancelScheduled(db(), orgId, scheduled.id, 'wsm-test');
    expect(await listScheduled(db(), orgId, 'wsm-test')).toHaveLength(0);
  });
});
