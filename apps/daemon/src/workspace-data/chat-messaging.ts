// Slack-shaped extras on team chat: pins, later, reminders, bookmarks,
// scheduled posts, activity, and per-member channel prefs / status.
//
// Channel membership and message bodies stay in chat.ts. This file only
// owns the tables that appeared with those extras.

import { randomUUID } from 'node:crypto';
import {
  CHAT_NOTIFY_LEVELS,
  sanitizeTeamChatAttachments,
  type ChatActivityItem,
  type ChatBookmark,
  type ChatNotifyLevel,
  type ChatPin,
  type ChatReminder,
  type ChatScheduledMessage,
  type ChatSearchHit,
  type ChatStatus,
  type TeamChatAttachment,
  type TeamChatMessage,
  type UpdateChannelPrefsRequest,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';
import {
  getChannel,
  getMessage,
  postMessage,
  type ResolveMemberName,
} from './chat.js';

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

const SAFE_HTTP = /^https?:\/\//i;

export async function updateChannelPrefs(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  input: UpdateChannelPrefsRequest,
): Promise<ReturnType<typeof getChannel>> {
  const channel = await getChannel(db, orgId, ref, memberId);
  if (!channel.joined) {
    throw new WorkspaceDataError('CHANNEL_ACCESS_DENIED', 403, 'join this channel first');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof input.starred === 'boolean') {
    sets.push('starred = ?');
    params.push(input.starred ? 1 : 0);
  }
  if (typeof input.muted === 'boolean') {
    sets.push('muted = ?');
    params.push(input.muted ? 1 : 0);
  }
  if (input.notify && (CHAT_NOTIFY_LEVELS as readonly string[]).includes(input.notify)) {
    sets.push('notify = ?');
    params.push(input.notify as ChatNotifyLevel);
  }
  if (sets.length === 0) return channel;
  params.push(channel.id, memberId);
  await db.run(
    `UPDATE od_chat_channel_members SET ${sets.join(', ')} WHERE channel_id = ? AND member_id = ?`,
    params,
  );
  return getChannel(db, orgId, channel.id, memberId);
}

export async function markChannelUnread(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  messageId?: string,
): Promise<ReturnType<typeof getChannel>> {
  const channel = await getChannel(db, orgId, ref, memberId);
  if (!channel.joined) {
    throw new WorkspaceDataError('CHANNEL_ACCESS_DENIED', 403, 'join this channel first');
  }
  let readAt = 0;
  if (messageId) {
    const message = await getMessage(db, messageId);
    if (message.channelId !== channel.id) {
      throw workspaceValidationError([{ path: 'messageId', message: 'that message is not in this channel' }]);
    }
    readAt = Math.max(0, message.createdAt - 1);
  } else {
    const latest = await db.get<{ last: number | string | null }>(
      'SELECT MAX(created_at) AS last FROM od_chat_messages WHERE channel_id = ? AND deleted_at IS NULL',
      [channel.id],
    );
    readAt = Math.max(0, (nullableNum(latest?.last) ?? 1) - 1);
  }
  await db.run(
    'UPDATE od_chat_channel_members SET last_read_at = ? WHERE channel_id = ? AND member_id = ?',
    [readAt, channel.id, memberId],
  );
  return getChannel(db, orgId, channel.id, memberId);
}

export async function togglePin(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<TeamChatMessage> {
  const message = await getMessage(db, messageId, resolveMemberName, memberId);
  if (message.orgId !== orgId) {
    throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  }
  await getChannel(db, orgId, message.channelId, memberId);
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_pins WHERE channel_id = ? AND message_id = ?',
    [message.channelId, messageId],
  );
  if (existing) {
    await db.run('DELETE FROM od_chat_pins WHERE id = ?', [existing.id]);
  } else {
    await db.run(
      `INSERT INTO od_chat_pins (id, channel_id, message_id, pinned_by, pinned_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`pin-${randomUUID()}`, message.channelId, messageId, memberId, Date.now()],
    );
  }
  return getMessage(db, messageId, resolveMemberName, memberId);
}

export async function listPins(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatPin[]> {
  const channel = await getChannel(db, orgId, ref, memberId);
  const rows = await db.all<{
    id: string;
    channelId: string;
    messageId: string;
    pinnedBy: string;
    pinnedAt: number | string;
  }>(
    `SELECT id, channel_id AS "channelId", message_id AS "messageId",
            pinned_by AS "pinnedBy", pinned_at AS "pinnedAt"
       FROM od_chat_pins WHERE channel_id = ?
       ORDER BY pinned_at DESC`,
    [channel.id],
  );
  const pins: ChatPin[] = [];
  for (const row of rows) {
    try {
      pins.push({
        id: row.id,
        channelId: row.channelId,
        messageId: row.messageId,
        pinnedBy: row.pinnedBy,
        pinnedAt: num(row.pinnedAt),
        message: await getMessage(db, row.messageId, resolveMemberName, memberId),
      });
    } catch {
      // A deleted message should not keep a pin hanging in the UI.
    }
  }
  return pins;
}

export async function toggleSave(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<TeamChatMessage> {
  const message = await getMessage(db, messageId, resolveMemberName, memberId);
  if (message.orgId !== orgId) {
    throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  }
  await getChannel(db, orgId, message.channelId, memberId);
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_saves WHERE member_id = ? AND message_id = ?',
    [memberId, messageId],
  );
  if (existing) {
    await db.run('DELETE FROM od_chat_saves WHERE id = ?', [existing.id]);
  } else {
    await db.run(
      `INSERT INTO od_chat_saves (id, workspace_id, member_id, message_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`sav-${randomUUID()}`, orgId, memberId, messageId, Date.now()],
    );
  }
  return getMessage(db, messageId, resolveMemberName, memberId);
}

export async function listSaved(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatSearchHit[]> {
  const rows = await db.all<{
    messageId: string;
    channelId: string;
    slug: string;
    name: string;
    kind: string | null;
  }>(
    `SELECT s.message_id AS "messageId", c.id AS "channelId", c.slug, c.display_name AS "name", c.kind
       FROM od_chat_saves s
       JOIN od_chat_messages m ON m.id = s.message_id
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE s.workspace_id = ? AND s.member_id = ? AND m.deleted_at IS NULL
      ORDER BY s.created_at DESC
      LIMIT 80`,
    [orgId, memberId],
  );
  const items: ChatSearchHit[] = [];
  for (const row of rows) {
    items.push({
      channelId: row.channelId,
      channelSlug: row.slug,
      channelName: row.name,
      kind: row.kind === 'dm' || row.kind === 'group_dm' ? row.kind : 'channel',
      message: await getMessage(db, row.messageId, resolveMemberName, memberId),
    });
  }
  return items;
}

export async function createReminder(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  fireAt: number,
  note?: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatReminder> {
  if (!Number.isFinite(fireAt) || fireAt < Date.now() - 60_000) {
    throw workspaceValidationError([{ path: 'fireAt', message: 'pick a time in the future' }]);
  }
  const message = await getMessage(db, messageId, resolveMemberName, memberId);
  if (message.orgId !== orgId) {
    throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  }
  const channel = await getChannel(db, orgId, message.channelId, memberId);
  const id = `rmd-${randomUUID()}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO od_chat_reminders
       (id, workspace_id, member_id, message_id, fire_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, memberId, messageId, fireAt, note?.trim() || null, now],
  );
  return {
    id,
    orgId,
    memberId,
    messageId,
    fireAt,
    note: note?.trim() || null,
    deliveredAt: null,
    createdAt: now,
    message,
    channelId: channel.id,
    channelSlug: channel.slug,
    channelName: channel.displayName,
  };
}

export async function listReminders(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatReminder[]> {
  const rows = await db.all<{
    id: string;
    messageId: string;
    fireAt: number | string;
    note: string | null;
    deliveredAt: number | string | null;
    createdAt: number | string;
    channelId: string;
    slug: string;
    name: string;
  }>(
    `SELECT r.id, r.message_id AS "messageId", r.fire_at AS "fireAt", r.note,
            r.delivered_at AS "deliveredAt", r.created_at AS "createdAt",
            c.id AS "channelId", c.slug, c.display_name AS "name"
       FROM od_chat_reminders r
       JOIN od_chat_messages m ON m.id = r.message_id
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE r.workspace_id = ? AND r.member_id = ?
      ORDER BY r.fire_at ASC
      LIMIT 80`,
    [orgId, memberId],
  );
  const out: ChatReminder[] = [];
  for (const row of rows) {
    out.push({
      id: row.id,
      orgId,
      memberId,
      messageId: row.messageId,
      fireAt: num(row.fireAt),
      note: row.note,
      deliveredAt: nullableNum(row.deliveredAt),
      createdAt: num(row.createdAt),
      message: await getMessage(db, row.messageId, resolveMemberName, memberId),
      channelId: row.channelId,
      channelSlug: row.slug,
      channelName: row.name,
    });
  }
  return out;
}

export async function cancelReminder(
  db: SqlExecutor,
  orgId: string,
  reminderId: string,
  memberId: string,
): Promise<void> {
  const row = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_reminders WHERE id = ? AND workspace_id = ? AND member_id = ?',
    [reminderId, orgId, memberId],
  );
  if (!row) throw new WorkspaceDataError('NOT_FOUND', 404, 'no such reminder');
  await db.run('DELETE FROM od_chat_reminders WHERE id = ?', [reminderId]);
}

export async function createBookmark(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  input: { label: string; url: string; emoji?: string },
): Promise<ChatBookmark> {
  const channel = await getChannel(db, orgId, ref, memberId);
  const label = input.label.trim();
  const url = input.url.trim();
  if (!label) throw workspaceValidationError([{ path: 'label', message: 'a bookmark needs a name' }]);
  if (!SAFE_HTTP.test(url)) {
    throw workspaceValidationError([{ path: 'url', message: 'a bookmark needs an http(s) link' }]);
  }
  const positionRow = await db.get<{ n: number | string }>(
    'SELECT COALESCE(MAX(position), -1) AS n FROM od_chat_bookmarks WHERE channel_id = ?',
    [channel.id],
  );
  const id = `bmk-${randomUUID()}`;
  const now = Date.now();
  const position = num(positionRow?.n ?? -1) + 1;
  await db.run(
    `INSERT INTO od_chat_bookmarks
       (id, channel_id, label, url, emoji, position, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, channel.id, label, url, input.emoji?.trim() || null, position, memberId, now],
  );
  return {
    id,
    channelId: channel.id,
    label,
    url,
    emoji: input.emoji?.trim() || null,
    position,
    createdBy: memberId,
    createdAt: now,
  };
}

export async function listBookmarks(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatBookmark[]> {
  const channel = await getChannel(db, orgId, ref, memberId);
  const rows = await db.all<ChatBookmark>(
    `SELECT id, channel_id AS "channelId", label, url, emoji, position,
            created_by AS "createdBy", created_at AS "createdAt"
       FROM od_chat_bookmarks WHERE channel_id = ? ORDER BY position ASC`,
    [channel.id],
  );
  return rows.map((row) => ({
    ...row,
    position: num(row.position),
    createdAt: num(row.createdAt),
  }));
}

export async function deleteBookmark(
  db: SqlExecutor,
  orgId: string,
  bookmarkId: string,
  memberId: string,
): Promise<void> {
  const row = await db.get<{ id: string; channelId: string }>(
    'SELECT id, channel_id AS "channelId" FROM od_chat_bookmarks WHERE id = ?',
    [bookmarkId],
  );
  if (!row) throw new WorkspaceDataError('NOT_FOUND', 404, 'no such bookmark');
  await getChannel(db, orgId, row.channelId, memberId);
  await db.run('DELETE FROM od_chat_bookmarks WHERE id = ?', [bookmarkId]);
}

export async function scheduleMessage(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  input: {
    body: string;
    attachments?: TeamChatAttachment[];
    mentions?: string[];
    parentMessageId?: string;
    sendAt: number;
  },
): Promise<ChatScheduledMessage> {
  if (!Number.isFinite(input.sendAt) || input.sendAt <= Date.now()) {
    throw workspaceValidationError([{ path: 'sendAt', message: 'pick a time in the future' }]);
  }
  const channel = await getChannel(db, orgId, ref, memberId);
  const body = input.body.trim();
  const attachments = sanitizeTeamChatAttachments(input.attachments);
  if (!body && attachments.length === 0) {
    throw workspaceValidationError([{ path: 'body', message: 'a message needs something in it' }]);
  }
  const id = `sch-${randomUUID()}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO od_chat_scheduled
       (id, workspace_id, channel_id, author_member_id, body, attachments_json,
        mentions_json, parent_message_id, send_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      channel.id,
      memberId,
      body,
      JSON.stringify(attachments),
      JSON.stringify(input.mentions ?? []),
      input.parentMessageId ?? null,
      input.sendAt,
      now,
    ],
  );
  return {
    id,
    orgId,
    channelId: channel.id,
    channelSlug: channel.slug,
    channelName: channel.displayName,
    authorMemberId: memberId,
    body,
    attachments,
    mentions: input.mentions ?? [],
    parentMessageId: input.parentMessageId ?? null,
    sendAt: input.sendAt,
    createdAt: now,
  };
}

export async function listScheduled(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<ChatScheduledMessage[]> {
  const rows = await db.all<{
    id: string;
    channelId: string;
    slug: string;
    name: string;
    body: string;
    attachmentsJson: string;
    mentionsJson: string;
    parentMessageId: string | null;
    sendAt: number | string;
    createdAt: number | string;
  }>(
    `SELECT s.id, s.channel_id AS "channelId", c.slug, c.display_name AS "name",
            s.body, s.attachments_json AS "attachmentsJson", s.mentions_json AS "mentionsJson",
            s.parent_message_id AS "parentMessageId", s.send_at AS "sendAt", s.created_at AS "createdAt"
       FROM od_chat_scheduled s
       JOIN od_chat_channels c ON c.id = s.channel_id
      WHERE s.workspace_id = ? AND s.author_member_id = ?
      ORDER BY s.send_at ASC
      LIMIT 80`,
    [orgId, memberId],
  );
  return rows.map((row) => ({
    id: row.id,
    orgId,
    channelId: row.channelId,
    channelSlug: row.slug,
    channelName: row.name,
    authorMemberId: memberId,
    body: row.body,
    attachments: sanitizeTeamChatAttachments(
      (() => {
        try {
          return JSON.parse(row.attachmentsJson);
        } catch {
          return [];
        }
      })(),
    ),
    mentions: (() => {
      try {
        const parsed = JSON.parse(row.mentionsJson);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
      } catch {
        return [];
      }
    })(),
    parentMessageId: row.parentMessageId,
    sendAt: num(row.sendAt),
    createdAt: num(row.createdAt),
  }));
}

export async function cancelScheduled(
  db: SqlExecutor,
  orgId: string,
  scheduledId: string,
  memberId: string,
): Promise<void> {
  const row = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_scheduled WHERE id = ? AND workspace_id = ? AND author_member_id = ?',
    [scheduledId, orgId, memberId],
  );
  if (!row) throw new WorkspaceDataError('NOT_FOUND', 404, 'no such scheduled message');
  await db.run('DELETE FROM od_chat_scheduled WHERE id = ?', [scheduledId]);
}

export async function deliverDueScheduled(
  db: SqlExecutor,
  orgId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<number> {
  const due = await db.all<{
    id: string;
    channelId: string;
    authorMemberId: string;
    body: string;
    attachmentsJson: string;
    mentionsJson: string;
    parentMessageId: string | null;
  }>(
    `SELECT id, channel_id AS "channelId", author_member_id AS "authorMemberId", body,
            attachments_json AS "attachmentsJson", mentions_json AS "mentionsJson",
            parent_message_id AS "parentMessageId"
       FROM od_chat_scheduled
      WHERE workspace_id = ? AND send_at <= ?
      ORDER BY send_at ASC
      LIMIT 20`,
    [orgId, Date.now()],
  );
  let posted = 0;
  for (const row of due) {
    try {
      const attachments = sanitizeTeamChatAttachments(
        (() => {
          try {
            return JSON.parse(row.attachmentsJson);
          } catch {
            return [];
          }
        })(),
      );
      const mentions = (() => {
        try {
          const parsed = JSON.parse(row.mentionsJson);
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
        } catch {
          return [];
        }
      })();
      await postMessage(
        db,
        orgId,
        row.channelId,
        row.authorMemberId,
        {
          body: row.body,
          attachments,
          mentions,
          ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
        },
        resolveMemberName,
      );
      await db.run('DELETE FROM od_chat_scheduled WHERE id = ?', [row.id]);
      posted += 1;
    } catch {
      // Leave it queued; a later tick can retry.
    }
  }
  return posted;
}

export async function setChatStatus(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  input: { text?: string | null; emoji?: string | null; expiresAt?: number | null },
): Promise<ChatStatus> {
  const text = input.text === undefined ? undefined : (input.text?.trim() || null);
  const emoji = input.emoji === undefined ? undefined : (input.emoji?.trim() || null);
  const existing = await db.get<ChatStatus>(
    `SELECT member_id AS "memberId", status_text AS "text", status_emoji AS "emoji",
            status_expires_at AS "expiresAt", updated_at AS "updatedAt"
       FROM od_chat_profiles WHERE member_id = ? AND workspace_id = ?`,
    [memberId, orgId],
  );
  const next: ChatStatus = {
    memberId,
    text: text === undefined ? (existing?.text ?? null) : text,
    emoji: emoji === undefined ? (existing?.emoji ?? null) : emoji,
    expiresAt: input.expiresAt === undefined ? (existing?.expiresAt ?? null) : input.expiresAt,
    updatedAt: Date.now(),
  };
  await db.run(
    `INSERT INTO od_chat_profiles
       (member_id, workspace_id, status_text, status_emoji, status_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       status_text = excluded.status_text,
       status_emoji = excluded.status_emoji,
       status_expires_at = excluded.status_expires_at,
       updated_at = excluded.updated_at`,
    [memberId, orgId, next.text, next.emoji, next.expiresAt, next.updatedAt],
  );
  return next;
}

export async function getChatStatus(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<ChatStatus | null> {
  const row = await db.get<ChatStatus>(
    `SELECT member_id AS "memberId", status_text AS "text", status_emoji AS "emoji",
            status_expires_at AS "expiresAt", updated_at AS "updatedAt"
       FROM od_chat_profiles WHERE member_id = ? AND workspace_id = ?`,
    [memberId, orgId],
  );
  if (!row) return null;
  const expiresAt = nullableNum(row.expiresAt);
  if (expiresAt && expiresAt < Date.now()) {
    await db.run(
      `UPDATE od_chat_profiles SET status_text = NULL, status_emoji = NULL,
              status_expires_at = NULL, updated_at = ? WHERE member_id = ?`,
      [Date.now(), memberId],
    );
    return { memberId, text: null, emoji: null, expiresAt: null, updatedAt: Date.now() };
  }
  return {
    ...row,
    expiresAt,
    updatedAt: num(row.updatedAt),
  };
}

export async function listChatStatuses(
  db: SqlExecutor,
  orgId: string,
): Promise<ChatStatus[]> {
  const rows = await db.all<ChatStatus>(
    `SELECT member_id AS "memberId", status_text AS "text", status_emoji AS "emoji",
            status_expires_at AS "expiresAt", updated_at AS "updatedAt"
       FROM od_chat_profiles WHERE workspace_id = ?`,
    [orgId],
  );
  const now = Date.now();
  return rows
    .map((row) => ({
      ...row,
      expiresAt: nullableNum(row.expiresAt),
      updatedAt: num(row.updatedAt),
    }))
    .filter((row) => !row.expiresAt || row.expiresAt >= now);
}

export async function listChannelFiles(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<TeamChatAttachment[]> {
  const channel = await getChannel(db, orgId, ref, memberId);
  const rows = await db.all<{ attachmentsJson: string }>(
    `SELECT attachments_json AS "attachmentsJson" FROM od_chat_messages
      WHERE channel_id = ? AND deleted_at IS NULL AND attachments_json != '[]'
      ORDER BY created_at DESC LIMIT 80`,
    [channel.id],
  );
  const files: TeamChatAttachment[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.attachmentsJson);
      for (const item of sanitizeTeamChatAttachments(parsed)) {
        if (item.kind === 'file' || item.kind === 'link') files.push(item);
      }
    } catch {
      // skip
    }
  }
  return files.slice(0, 80);
}

export async function listActivity(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatActivityItem[]> {
  const items: ChatActivityItem[] = [];

  const mentions = await db.all<{
    messageId: string;
    createdAt: number | string;
    channelId: string;
    slug: string;
    name: string;
    author: string | null;
  }>(
    `SELECT m.id AS "messageId", m.created_at AS "createdAt", c.id AS "channelId",
            c.slug, c.display_name AS "name", m.author_member_id AS "author"
       FROM od_chat_messages m
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL
        AND (
          m.mentions_json LIKE ?
          OR m.mentions_json LIKE '%"@channel"%'
          OR m.mentions_json LIKE '%"@here"%'
          OR m.mentions_json LIKE '%"@everyone"%'
        )
        AND (m.author_member_id IS NULL OR m.author_member_id <> ?)
      ORDER BY m.created_at DESC
      LIMIT 30`,
    [orgId, `%"${memberId}"%`, memberId],
  );
  for (const row of mentions) {
    items.push({
      kind: 'mention',
      createdAt: num(row.createdAt),
      channelId: row.channelId,
      channelSlug: row.slug,
      channelName: row.name,
      message: await getMessage(db, row.messageId, resolveMemberName, memberId),
      ...(row.author ? { actorMemberId: row.author } : {}),
      actorName: row.author ? resolveMemberName?.(row.author) ?? null : null,
    });
  }

  const reactions = await db.all<{
    messageId: string;
    createdAt: number | string;
    channelId: string;
    slug: string;
    name: string;
    actor: string;
    emoji: string;
  }>(
    `SELECT m.id AS "messageId", r.created_at AS "createdAt", c.id AS "channelId",
            c.slug, c.display_name AS "name", r.member_id AS "actor", r.emoji
       FROM od_chat_reactions r
       JOIN od_chat_messages m ON m.id = r.message_id
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE m.workspace_id = ? AND m.author_member_id = ? AND r.member_id <> ?
        AND m.deleted_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT 30`,
    [orgId, memberId, memberId],
  );
  for (const row of reactions) {
    items.push({
      kind: 'reaction',
      createdAt: num(row.createdAt),
      channelId: row.channelId,
      channelSlug: row.slug,
      channelName: row.name,
      message: await getMessage(db, row.messageId, resolveMemberName, memberId),
      actorMemberId: row.actor,
      actorName: resolveMemberName?.(row.actor) ?? null,
      emoji: row.emoji,
    });
  }

  const threads = await db.all<{
    messageId: string;
    createdAt: number | string;
    channelId: string;
    slug: string;
    name: string;
    author: string | null;
    parentId: string;
  }>(
    `SELECT m.id AS "messageId", m.created_at AS "createdAt", c.id AS "channelId",
            c.slug, c.display_name AS "name", m.author_member_id AS "author",
            m.parent_message_id AS "parentId"
       FROM od_chat_messages m
       JOIN od_chat_messages p ON p.id = m.parent_message_id
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL
        AND p.author_member_id = ? AND (m.author_member_id IS NULL OR m.author_member_id <> ?)
      ORDER BY m.created_at DESC
      LIMIT 30`,
    [orgId, memberId, memberId],
  );
  for (const row of threads) {
    items.push({
      kind: 'thread',
      createdAt: num(row.createdAt),
      channelId: row.channelId,
      channelSlug: row.slug,
      channelName: row.name,
      message: await getMessage(db, row.messageId, resolveMemberName, memberId),
      ...(row.author ? { actorMemberId: row.author } : {}),
      actorName: row.author ? resolveMemberName?.(row.author) ?? null : null,
    });
  }

  const reminders = await listReminders(db, orgId, memberId, resolveMemberName);
  for (const reminder of reminders) {
    if (reminder.fireAt > Date.now()) continue;
    if (reminder.deliveredAt) continue;
    items.push({
      kind: 'reminder',
      createdAt: reminder.fireAt,
      channelId: reminder.channelId,
      channelSlug: reminder.channelSlug,
      channelName: reminder.channelName,
      message: reminder.message,
      reminderId: reminder.id,
      note: reminder.note,
      fireAt: reminder.fireAt,
    });
    await db.run('UPDATE od_chat_reminders SET delivered_at = ? WHERE id = ?', [
      Date.now(),
      reminder.id,
    ]);
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return items.slice(0, 50);
}
