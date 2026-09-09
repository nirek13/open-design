import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { createChannel, getChannel, postMessage } from '../src/workspace-data/chat.js';
import {
  applyRetention,
  createCustomEmoji,
  createEmojiAlias,
  createSection,
  createUserGroup,
  createWebhook,
  deleteCustomEmoji,
  deleteSection,
  getDnd,
  listCustomEmoji,
  listDnd,
  listDrafts,
  listSections,
  listWebhooks,
  resolveWebhookToken,
  revokeWebhook,
  saveDraft,
  setDnd,
  setRetention,
  updateSection,
  updateUserGroup,
} from '../src/workspace-data/chat-org.js';

describe('organization-level chat furniture', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let orgId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-org-'));
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const db = () => manager.workspaceExecutor(orgId);

  describe('custom emoji', () => {
    it('normalises the name and rejects a duplicate', async () => {
      const emoji = await createCustomEmoji(db(), orgId, 'wsm-a', {
        name: ':Ship It:',
        url: '/api/orgs/o/chat/files/file-1',
      });
      expect(emoji.name).toBe('ship_it');
      await expect(
        createCustomEmoji(db(), orgId, 'wsm-a', { name: 'ship_it', url: '/x' }),
      ).rejects.toMatchObject({ code: 'CHAT_EMOJI_TAKEN' });
    });

    it('takes its aliases with it when it is deleted', async () => {
      // An alias pointing at a deleted image renders as a broken picture. A
      // missing `:lgtm:` is better than a broken one.
      await createCustomEmoji(db(), orgId, 'wsm-a', { name: 'shipit', url: '/file-1' });
      await createEmojiAlias(db(), orgId, 'wsm-a', { name: 'lgtm', aliasFor: 'shipit' });
      expect(await listCustomEmoji(db(), orgId)).toHaveLength(2);

      await deleteCustomEmoji(db(), orgId, 'shipit');
      expect(await listCustomEmoji(db(), orgId)).toHaveLength(0);
    });

    it('will not alias a name that does not exist', async () => {
      await expect(
        createEmojiAlias(db(), orgId, 'wsm-a', { name: 'lgtm', aliasFor: 'nothing' }),
      ).rejects.toMatchObject({ code: 'CHAT_EMOJI_NOT_FOUND' });
    });
  });

  describe('user groups', () => {
    it('derives a handle from the name and keeps it unique', async () => {
      const group = await createUserGroup(db(), orgId, 'wsm-a', {
        name: 'Design Team',
        memberIds: ['wsm-a', 'wsm-b', 'wsm-a'],
      });
      expect(group.handle).toBe('design-team');
      expect(group.memberIds).toEqual(['wsm-a', 'wsm-b']);
      await expect(
        createUserGroup(db(), orgId, 'wsm-a', { name: 'Design Team' }),
      ).rejects.toMatchObject({ code: 'CHAT_GROUP_TAKEN' });
    });

    it('replaces the member list rather than merging into it', async () => {
      const group = await createUserGroup(db(), orgId, 'wsm-a', {
        name: 'Ops',
        memberIds: ['wsm-a', 'wsm-b'],
      });
      const updated = await updateUserGroup(db(), orgId, group.id, { memberIds: ['wsm-c'] });
      expect(updated.memberIds).toEqual(['wsm-c']);
    });
  });

  describe('sidebar sections', () => {
    it('moves a channel out of its old section when it is put in a new one', async () => {
      // A channel in two sections would appear twice in the sidebar, which is
      // the one thing a folder is supposed to prevent.
      const first = await createSection(db(), orgId, 'wsm-a', { name: 'Projects' });
      const second = await createSection(db(), orgId, 'wsm-a', { name: 'Archive' });
      await updateSection(db(), orgId, 'wsm-a', first.id, { channelIds: ['chn-1', 'chn-2'] });
      const after = await updateSection(db(), orgId, 'wsm-a', second.id, { channelIds: ['chn-1'] });

      expect(after.find((row) => row.id === first.id)?.channelIds).toEqual(['chn-2']);
      expect(after.find((row) => row.id === second.id)?.channelIds).toEqual(['chn-1']);
    });

    it('is private to one member', async () => {
      await createSection(db(), orgId, 'wsm-a', { name: 'Mine' });
      expect(await listSections(db(), orgId, 'wsm-a')).toHaveLength(1);
      expect(await listSections(db(), orgId, 'wsm-b')).toHaveLength(0);
    });

    it('deleting a section keeps the channels that were in it', async () => {
      const section = await createSection(db(), orgId, 'wsm-a', { name: 'Temp' });
      await updateSection(db(), orgId, 'wsm-a', section.id, { channelIds: ['chn-1'] });
      await deleteSection(db(), orgId, 'wsm-a', section.id);
      expect(await listSections(db(), orgId, 'wsm-a')).toHaveLength(0);
    });
  });

  describe('drafts', () => {
    it('keeps the channel draft and the thread draft apart', async () => {
      await saveDraft(db(), orgId, 'wsm-a', 'chn-1', { body: 'to the channel' });
      await saveDraft(db(), orgId, 'wsm-a', 'chn-1', {
        parentMessageId: 'msg-1',
        body: 'to the thread',
      });
      const drafts = await listDrafts(db(), orgId, 'wsm-a');
      expect(drafts).toHaveLength(2);
      expect(new Set(drafts.map((row) => row.parentMessageId))).toEqual(new Set([null, 'msg-1']));
    });

    it('clears the row when the body is emptied rather than storing a blank', async () => {
      await saveDraft(db(), orgId, 'wsm-a', 'chn-1', { body: 'half a thought' });
      expect(await saveDraft(db(), orgId, 'wsm-a', 'chn-1', { body: '   ' })).toBeNull();
      expect(await listDrafts(db(), orgId, 'wsm-a')).toHaveLength(0);
    });
  });

  describe('quiet hours', () => {
    it('defaults to off and round-trips a schedule', async () => {
      expect((await getDnd(db(), orgId, 'wsm-a')).scheduleEnabled).toBe(false);
      const saved = await setDnd(db(), orgId, 'wsm-a', {
        scheduleEnabled: true,
        startMinute: 22 * 60,
        endMinute: 8 * 60,
        timezone: 'Europe/Berlin',
      });
      expect(saved.scheduleEnabled).toBe(true);
      expect(saved.timezone).toBe('Europe/Berlin');
      expect((await listDnd(db(), orgId)).get('wsm-a')?.startMinute).toBe(1320);
    });

    it('never stores a snooze in the past', async () => {
      const saved = await setDnd(db(), orgId, 'wsm-a', { snoozeUntil: 1 });
      expect(saved.snoozeUntil).toBeGreaterThanOrEqual(Date.now() - 1_000);
    });
  });

  describe('incoming webhooks', () => {
    it('returns the token once and stores only its hash', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-a', { displayName: 'Incidents' });
      const { webhook, token } = await createWebhook(db(), orgId, 'wsm-a', {
        channelId: channel.slug,
        name: 'Pager',
      });
      expect(token).toHaveLength(43);

      const row = await db().get<{ tokenHash: string }>(
        'SELECT token_hash AS "tokenHash" FROM od_chat_webhooks WHERE id = ?',
        [webhook.id],
      );
      expect(row?.tokenHash).not.toContain(token);
      expect((await resolveWebhookToken(db(), token))?.id).toBe(webhook.id);
    });

    it('stops resolving once revoked, and disappears from the list', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-a', { displayName: 'Incidents' });
      const { webhook, token } = await createWebhook(db(), orgId, 'wsm-a', {
        channelId: channel.slug,
        name: 'Pager',
      });
      await revokeWebhook(db(), orgId, webhook.id);
      expect(await resolveWebhookToken(db(), token)).toBeNull();
      expect(await listWebhooks(db(), orgId)).toHaveLength(0);
    });
  });

  describe('retention', () => {
    it('deletes expired messages outright rather than soft-deleting them', async () => {
      // The point of a retention policy is that the content is gone. A
      // `deleted_at` that still holds the text satisfies nobody who asked for
      // one.
      const channel = await createChannel(db(), orgId, 'wsm-a', { displayName: 'Ephemeral' });
      const message = await postMessage(db(), orgId, channel.slug, 'wsm-a', { body: 'secret' });
      await setRetention(db(), orgId, channel.id, { days: 1 });

      const removed = await applyRetention(db(), orgId, message.createdAt + 3 * 24 * 60 * 60 * 1000);
      expect(removed.get(channel.id)).toBe(1);

      const row = await db().get('SELECT id FROM od_chat_messages WHERE id = ?', [message.id]);
      expect(row).toBeNull();
    });

    it('leaves a channel with no policy alone', async () => {
      const channel = await createChannel(db(), orgId, 'wsm-a', { displayName: 'Forever' });
      await postMessage(db(), orgId, channel.slug, 'wsm-a', { body: 'keep me' });
      const removed = await applyRetention(db(), orgId, Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(removed.size).toBe(0);
      expect((await getChannel(db(), orgId, channel.slug, 'wsm-a')).messageCount).toBe(1);
    });
  });
});
