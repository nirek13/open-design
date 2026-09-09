import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_OWNER_USER_ID } from '@open-design/contracts';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization, listOrgMembers } from '../src/workspace-data/tenancy.js';
import { createChannel, postMessage } from '../src/workspace-data/chat.js';
import { updateChannelPrefs } from '../src/workspace-data/chat-messaging.js';
import { chatPushPayload, dispatchChatPush, listChatPushMemberIds } from '../src/workspace-data/chat-push.js';
import { upsertPushSubscription } from '../src/workspace-data/push-subscriptions.js';
import { createWebPushService, type PushSendResult } from '../src/services/web-push.js';

describe('team chat push', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-push-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  it('does not notify the author, and honors mentions-only', async () => {
    const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'General' });
    await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'joining' });

    const fromOther = await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'hello all' });
    expect(await listChatPushMemberIds(db(), channel.id, fromOther)).toEqual(['wsm-test']);

    const fromSelf = await postMessage(db(), orgId, channel.slug, 'wsm-test', { body: 'own message' });
    expect(await listChatPushMemberIds(db(), channel.id, fromSelf)).toEqual(['wsm-other']);

    await updateChannelPrefs(db(), orgId, channel.slug, 'wsm-test', { notify: 'mentions' });
    const plain = await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'no ping' });
    expect(await listChatPushMemberIds(db(), channel.id, plain)).toEqual([]);

    const mentioned = await postMessage(db(), orgId, channel.slug, 'wsm-other', {
      body: 'hey',
      mentions: ['wsm-test'],
    });
    expect(await listChatPushMemberIds(db(), channel.id, mentioned)).toEqual(['wsm-test']);
  });

  it('builds a click-through payload for the channel', async () => {
    const channel = await createChannel(db(), orgId, 'wsm-test', { displayName: 'Deals' });
    const message = await postMessage(db(), orgId, channel.slug, 'wsm-other', {
      body: 'closed won',
    });
    const payload = chatPushPayload({ ...channel, kind: 'channel' }, { ...message, authorName: 'Sam' });
    expect(payload.url).toBe('/team/deals');
    expect(payload.title).toBe('Sam in Deals');
    expect(payload.body).toBe('closed won');
    expect(payload.tag).toBe(`chat-${channel.id}`);
  });

  it('sends to the matching user subscription and drops gone endpoints', async () => {
    const people = await listOrgMembers(manager.directoryExecutor, orgId);
    const owner = people.find((person) => person.userId === LOCAL_OWNER_USER_ID);
    expect(owner).toBeTruthy();
    const channel = await createChannel(db(), orgId, owner!.id, { displayName: 'General' });
    await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'joining' });

    await upsertPushSubscription(manager.directoryExecutor, LOCAL_OWNER_USER_ID, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
      keys: { p256dh: 'p256', auth: 'auth' },
    });

    const sent: string[] = [];
    const webPush = createWebPushService({
      dataDir: tempDir,
      sender: {
        async send(target): Promise<PushSendResult> {
          sent.push(target.endpoint);
          return 'gone';
        },
      },
    });

    const message = await postMessage(db(), orgId, channel.slug, 'wsm-other', { body: 'ping' });
    const delivered = await dispatchChatPush({
      directory: manager.directoryExecutor,
      db: db(),
      orgId,
      channel: { ...channel, kind: 'channel' },
      message,
      webPush,
    });
    expect(delivered).toBe(0);
    expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/test-endpoint']);

    const again = await dispatchChatPush({
      directory: manager.directoryExecutor,
      db: db(),
      orgId,
      channel: { ...channel, kind: 'channel' },
      message,
      webPush,
    });
    expect(again).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
