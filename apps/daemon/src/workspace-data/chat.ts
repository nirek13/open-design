// Team chat: channels, membership, messages, threads, and read state.
//
// Written against SqlExecutor so it runs unchanged on SQLite and Supabase
// Postgres, like the ledger and tenancy do.
//
// Two rules the rest of the file exists to keep:
//
//   - A private channel is invisible, not merely closed. Every read path
//     filters on membership before it filters on anything else, and a
//     non-member gets CHANNEL_NOT_FOUND rather than a permission error — a 403
//     would confirm that #board-comp exists.
//   - Read position is a timestamp per member per channel. Unread is then a
//     count of messages newer than it, which stays correct when a message is
//     deleted and needs no write on the message itself.

import { createHash, randomUUID } from 'node:crypto';
import {
  CHANNEL_SLUG_PATTERN,
  CHAT_MESSAGE_MAX_LENGTH,
  DEFAULT_CHANNELS,
  parseChatSearchQuery,
  sanitizeTeamChatAttachments,
  slugifyChannelName,
  type ChannelMemberRole,
  type ChannelVisibility,
  type ChatChannelKind,
  type ChatNotifyLevel,
  type ChatReaction,
  type ChatSearchHit,
  type TeamChatAttachment,
  type ChatChannel,
  type ChatChannelMember,
  type TeamChatMessage,
  type CreateChannelRequest,
  type ListMessagesQuery,
  type PostMessageRequest,
  type UpdateChannelRequest,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const CHANNEL_COLS = `
  id, workspace_id AS "orgId", slug, display_name AS "displayName", topic, purpose,
  kind, visibility, archived_at AS "archivedAt", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const MESSAGE_COLS = `
  id, channel_id AS "channelId", workspace_id AS "orgId",
  author_member_id AS "authorMemberId", body, system,
  attachments_json AS "attachmentsJson", mentions_json AS "mentionsJson",
  parent_message_id AS "parentMessageId", edited_at AS "editedAt",
  deleted_at AS "deletedAt", created_at AS "createdAt"
`;

/** The same columns qualified for the aliased message table. Written out
 * rather than derived, because a regex over column lists is exactly the kind
 * of cleverness that breaks the first time a column name contains the alias. */
const MESSAGE_COLS_M = `
  m.id, m.channel_id AS "channelId", m.workspace_id AS "orgId",
  m.author_member_id AS "authorMemberId", m.body, m.system,
  m.attachments_json AS "attachmentsJson", m.mentions_json AS "mentionsJson",
  m.parent_message_id AS "parentMessageId", m.edited_at AS "editedAt",
  m.deleted_at AS "deletedAt", m.created_at AS "createdAt"
`;

/** Turns an organization member id into a display name.
 *
 * Chat lives in the per-organization database; members and users live in the
 * directory database. There is no join across those two files, so the route
 * layer — which holds both — passes name resolution in. Same arrangement
 * `listApps` uses for its gallery byline. */
export type ResolveMemberName = (memberId: string) => string | null;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function channelNotFound(ref: string): WorkspaceDataError {
  return new WorkspaceDataError('CHANNEL_NOT_FOUND', 404, `no channel '${ref}'`);
}

// --- Channels -------------------------------------------------------------

interface ChannelRow {
  id: string;
  orgId: string;
  slug: string;
  displayName: string;
  topic: string | null;
  purpose: string | null;
  kind: string | null;
  visibility: ChannelVisibility;
  archivedAt: number | string | null;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
}

/** Attach the per-caller and per-channel counts the UI needs. Done in one
 * grouped query per channel set rather than per row, because the channel list
 * is rendered on every page load. */
async function decorateChannels(
  db: SqlExecutor,
  rows: ChannelRow[],
  memberId: string,
): Promise<ChatChannel[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  const memberCounts = new Map<string, number>();
  for (const row of await db.all<{ channelId: string; n: number | string }>(
    `SELECT channel_id AS "channelId", COUNT(*) AS n FROM od_chat_channel_members
      WHERE channel_id IN (${placeholders}) GROUP BY channel_id`,
    ids,
  )) {
    memberCounts.set(row.channelId, num(row.n));
  }

  const stats = new Map<string, { count: number; last: number | null }>();
  for (const row of await db.all<{ channelId: string; n: number | string; last: number | string | null }>(
    `SELECT channel_id AS "channelId", COUNT(*) AS n, MAX(created_at) AS last
       FROM od_chat_messages
      WHERE channel_id IN (${placeholders}) AND deleted_at IS NULL
      GROUP BY channel_id`,
    ids,
  )) {
    stats.set(row.channelId, { count: num(row.n), last: nullableNum(row.last) });
  }

  const membership = new Map<string, {
    lastReadAt: number;
    starred: boolean;
    muted: boolean;
    notify: ChatNotifyLevel;
  }>();
  for (const row of await db.all<{
    channelId: string;
    lastReadAt: number | string;
    starred: number | boolean | null;
    muted: number | boolean | null;
    notify: string | null;
  }>(
    `SELECT channel_id AS "channelId", last_read_at AS "lastReadAt",
            starred, muted, notify
       FROM od_chat_channel_members
      WHERE member_id = ? AND channel_id IN (${placeholders})`,
    [memberId, ...ids],
  )) {
    membership.set(row.channelId, {
      lastReadAt: num(row.lastReadAt),
      starred: row.starred === 1 || row.starred === true,
      muted: row.muted === 1 || row.muted === true,
      notify: row.notify === 'mentions' || row.notify === 'nothing' ? row.notify : 'all',
    });
  }

  // Unread counts only for channels the caller is in — there is no such thing
  // as unread in a channel you have not joined. Mute / mentions-only follow
  // Slack: a muted room never badges, and mentions-only only counts @you
  // (or @channel / @here / @everyone).
  const unread = new Map<string, number>();
  for (const [channelId, prefs] of membership) {
    if (prefs.muted || prefs.notify === 'nothing') {
      unread.set(channelId, 0);
      continue;
    }
    const mentionOnly = prefs.notify === 'mentions';
    const row = await db.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM od_chat_messages
        WHERE channel_id = ? AND deleted_at IS NULL AND created_at > ?
          AND (author_member_id IS NULL OR author_member_id <> ?)
          ${mentionOnly
            ? `AND (
                 mentions_json LIKE ?
                 OR mentions_json LIKE '%"@channel"%'
                 OR mentions_json LIKE '%"@here"%'
                 OR mentions_json LIKE '%"@everyone"%'
               )`
            : ''}`,
      mentionOnly
        ? [channelId, prefs.lastReadAt, memberId, `%"${memberId}"%`]
        : [channelId, prefs.lastReadAt, memberId],
    );
    unread.set(channelId, num(row?.n ?? 0));
  }

  return rows.map((row) => {
    const prefs = membership.get(row.id);
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      displayName: row.displayName,
      topic: row.topic,
      purpose: row.purpose ?? null,
      kind: row.kind === 'dm' || row.kind === 'group_dm' ? row.kind : 'channel',
      visibility: row.visibility,
      archivedAt: nullableNum(row.archivedAt),
      createdBy: row.createdBy,
      createdAt: num(row.createdAt),
      updatedAt: num(row.updatedAt),
      memberCount: memberCounts.get(row.id) ?? 0,
      messageCount: stats.get(row.id)?.count ?? 0,
      lastMessageAt: stats.get(row.id)?.last ?? null,
      joined: Boolean(prefs),
      unreadCount: unread.get(row.id) ?? 0,
      starred: prefs?.starred ?? false,
      muted: prefs?.muted ?? false,
      notify: prefs?.notify ?? 'all',
    };
  });
}

/** Channels this member can see: every public one, plus the private ones they
 * belong to. Private channels they are not in do not appear at all. */
export async function listChannels(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ChatChannel[]> {
  const rows = await db.all<ChannelRow>(
    `SELECT ${CHANNEL_COLS} FROM od_chat_channels c
      WHERE c.workspace_id = ?
        ${options.includeArchived ? '' : 'AND c.archived_at IS NULL'}
        AND (
          c.visibility = 'public'
          OR EXISTS (
            SELECT 1 FROM od_chat_channel_members m
             WHERE m.channel_id = c.id AND m.member_id = ?
          )
        )
      ORDER BY c.slug ASC`,
    [orgId, memberId],
  );
  return decorateChannels(db, rows, memberId);
}

/** Load a channel the caller is allowed to see. Resolves by id or by slug,
 * because the CLI says `#sales` and the UI says `chn-…`. */
export async function getChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatChannel> {
  const row = await db.get<ChannelRow>(
    `SELECT ${CHANNEL_COLS} FROM od_chat_channels
      WHERE workspace_id = ? AND (id = ? OR (slug = ? AND archived_at IS NULL))`,
    [orgId, ref, ref.replace(/^#/, '')],
  );
  if (!row) throw channelNotFound(ref);
  const [channel] = await decorateChannels(db, [row], memberId);
  if (!channel) throw channelNotFound(ref);
  // A private channel the caller is not in is reported as missing, not as
  // forbidden: "you may not read #board-comp" still tells them it exists.
  if (channel.visibility === 'private' && !channel.joined) throw channelNotFound(ref);
  return channel;
}

/** Assert the caller may post/read here, returning the channel. Public
 * channels are readable by any member; posting requires joining, which the
 * caller does implicitly by posting (see `postMessage`). */
async function assertChannelAccess(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatChannel> {
  return getChannel(db, orgId, ref, memberId);
}

export async function createChannel(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: CreateChannelRequest,
): Promise<ChatChannel> {
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName) {
    throw workspaceValidationError([{ path: 'displayName', message: 'a channel needs a name' }]);
  }
  const slug = (input.slug?.trim() || slugifyChannelName(displayName)).replace(/^#/, '');
  if (!CHANNEL_SLUG_PATTERN.test(slug)) {
    throw workspaceValidationError([
      {
        path: 'slug',
        message: 'a channel name may use lowercase letters, digits, and hyphens',
      },
    ]);
  }
  const existing = await db.get(
    'SELECT id FROM od_chat_channels WHERE workspace_id = ? AND slug = ? AND archived_at IS NULL',
    [orgId, slug],
  );
  if (existing) {
    throw new WorkspaceDataError('CHANNEL_SLUG_TAKEN', 409, `#${slug} already exists`);
  }

  const now = Date.now();
  const id = `chn-${randomUUID()}`;
  const visibility: ChannelVisibility = input.visibility === 'private' ? 'private' : 'public';
  await db.run(
    `INSERT INTO od_chat_channels
       (id, workspace_id, slug, display_name, topic, purpose, kind, visibility, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'channel', ?, ?, ?, ?)`,
    [
      id,
      orgId,
      slug,
      displayName,
      input.topic?.trim() || null,
      input.purpose?.trim() || null,
      visibility,
      createdBy,
      now,
      now,
    ],
  );

  // The creator owns it; anyone they named joins as an ordinary member.
  await addMember(db, id, createdBy, 'owner');
  for (const memberId of input.memberIds ?? []) {
    if (memberId !== createdBy) await addMember(db, id, memberId, 'member');
  }
  return getChannel(db, orgId, id, createdBy);
}

export async function updateChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  input: UpdateChannelRequest,
): Promise<ChatChannel> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof input.displayName === 'string' && input.displayName.trim()) {
    sets.push('display_name = ?');
    params.push(input.displayName.trim());
  }
  if (input.topic !== undefined) {
    sets.push('topic = ?');
    params.push(input.topic?.trim() || null);
  }
  if (input.purpose !== undefined) {
    sets.push('purpose = ?');
    params.push(input.purpose?.trim() || null);
  }
  if (input.visibility === 'public' || input.visibility === 'private') {
    sets.push('visibility = ?');
    params.push(input.visibility);
  }
  if (sets.length === 0) return channel;
  sets.push('updated_at = ?');
  params.push(Date.now(), channel.id);
  await db.run(`UPDATE od_chat_channels SET ${sets.join(', ')} WHERE id = ?`, params);
  return getChannel(db, orgId, channel.id, memberId);
}

export async function archiveChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatChannel> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  await db.run('UPDATE od_chat_channels SET archived_at = ?, updated_at = ? WHERE id = ?', [
    Date.now(),
    Date.now(),
    channel.id,
  ]);
  const row = await db.get<ChannelRow>(`SELECT ${CHANNEL_COLS} FROM od_chat_channels WHERE id = ?`, [
    channel.id,
  ]);
  if (!row) throw channelNotFound(ref);
  return (await decorateChannels(db, [row], memberId))[0]!;
}

export async function unarchiveChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatChannel> {
  const row = await db.get<ChannelRow>(
    `SELECT ${CHANNEL_COLS} FROM od_chat_channels WHERE workspace_id = ? AND (id = ? OR slug = ?)`,
    [orgId, ref, ref.replace(/^#/, '')],
  );
  if (!row) throw channelNotFound(ref);
  await db.run('UPDATE od_chat_channels SET archived_at = NULL, updated_at = ? WHERE id = ?', [
    Date.now(),
    row.id,
  ]);
  return getChannel(db, orgId, row.id, memberId);
}

// --- Membership -----------------------------------------------------------

/** The newest message timestamp in a channel, or 0 when it is empty.
 *
 * This is the anchor for both read markers and new message timestamps. Read
 * position means "up to the latest message I can see" rather than "as of the
 * wall clock when I looked": the two differ whenever a message lands in the
 * same millisecond as the marker, and only the first one is ever right. */
async function latestMessageAt(db: SqlExecutor, channelId: string): Promise<number> {
  const row = await db.get<{ last: number | string | null }>(
    'SELECT MAX(created_at) AS last FROM od_chat_messages WHERE channel_id = ?',
    [channelId],
  );
  return nullableNum(row?.last) ?? 0;
}

/** A timestamp strictly newer than every message already in the channel.
 *
 * Date.now() has millisecond resolution, and two people posting inside the
 * same millisecond is ordinary rather than exotic. Without this the transcript
 * order between them is undefined, and paging by timestamp can skip or repeat
 * a message. Nudging forward keeps ordering total within a channel, which is
 * the only scope where message order means anything. */
async function nextMessageTimestamp(db: SqlExecutor, channelId: string): Promise<number> {
  return Math.max(Date.now(), (await latestMessageAt(db, channelId)) + 1);
}

async function addMember(
  db: SqlExecutor,
  channelId: string,
  memberId: string,
  role: ChannelMemberRole,
): Promise<void> {
  const existing = await db.get(
    'SELECT id FROM od_chat_channel_members WHERE channel_id = ? AND member_id = ?',
    [channelId, memberId],
  );
  if (existing) return;
  await db.run(
    `INSERT INTO od_chat_channel_members (id, channel_id, member_id, role, joined_at, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    // Joining marks history read up to what exists now — a new member does not
    // arrive to a badge counting every message ever sent.
    [
      `chm-${randomUUID()}`,
      channelId,
      memberId,
      role,
      Date.now(),
      await latestMessageAt(db, channelId),
    ],
  );
}

export async function joinChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<ChatChannel> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  await addMember(db, channel.id, memberId, 'member');
  return getChannel(db, orgId, channel.id, memberId);
}

export async function leaveChannel(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
): Promise<void> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  await db.run('DELETE FROM od_chat_channel_members WHERE channel_id = ? AND member_id = ?', [
    channel.id,
    memberId,
  ]);
}

export async function listChannelMembers(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatChannelMember[]> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  const rows = await db.all<Record<string, any>>(
    `SELECT id, channel_id AS "channelId", member_id AS "memberId", role,
            joined_at AS "joinedAt", last_read_at AS "lastReadAt"
       FROM od_chat_channel_members
      WHERE channel_id = ?
      ORDER BY joined_at ASC`,
    [channel.id],
  );
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    memberId: row.memberId,
    displayName: resolveMemberName?.(row.memberId) ?? null,
    role: row.role as ChannelMemberRole,
    joinedAt: num(row.joinedAt),
    lastReadAt: num(row.lastReadAt),
  }));
}

/** Move the caller's read marker. Defaults to now, which is what "I have read
 * this channel" means when they are looking at it. */
export async function markChannelRead(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  readAt?: number,
): Promise<ChatChannel> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  await db.run(
    'UPDATE od_chat_channel_members SET last_read_at = ? WHERE channel_id = ? AND member_id = ?',
    [readAt ?? (await latestMessageAt(db, channel.id)), channel.id, memberId],
  );
  return getChannel(db, orgId, channel.id, memberId);
}

// --- Messages -------------------------------------------------------------

async function loadReactions(
  db: SqlExecutor,
  messageIds: string[],
  viewerMemberId: string,
): Promise<Map<string, ChatReaction[]>> {
  const map = new Map<string, ChatReaction[]>();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await db.all<{ messageId: string; emoji: string; memberId: string }>(
    `SELECT message_id AS "messageId", emoji, member_id AS "memberId"
       FROM od_chat_reactions
      WHERE message_id IN (${placeholders})
      ORDER BY created_at ASC`,
    messageIds,
  );
  const grouped = new Map<string, Map<string, { memberIds: string[]; me: boolean }>>();
  for (const row of rows) {
    let byEmoji = grouped.get(row.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      grouped.set(row.messageId, byEmoji);
    }
    let bucket = byEmoji.get(row.emoji);
    if (!bucket) {
      bucket = { memberIds: [], me: false };
      byEmoji.set(row.emoji, bucket);
    }
    bucket.memberIds.push(row.memberId);
    if (row.memberId === viewerMemberId) bucket.me = true;
  }
  for (const [messageId, byEmoji] of grouped) {
    map.set(
      messageId,
      [...byEmoji.entries()].map(([emoji, bucket]) => ({
        emoji,
        count: bucket.memberIds.length,
        me: bucket.me,
        memberIds: bucket.memberIds,
      })),
    );
  }
  return map;
}

async function withReactions(
  db: SqlExecutor,
  messages: TeamChatMessage[],
  viewerMemberId: string,
): Promise<TeamChatMessage[]> {
  const reactions = await loadReactions(
    db,
    messages.map((message) => message.id),
    viewerMemberId,
  );
  const ids = messages.map((message) => message.id);
  const pinned = new Set<string>();
  const saved = new Set<string>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    for (const row of await db.all<{ messageId: string }>(
      `SELECT message_id AS "messageId" FROM od_chat_pins WHERE message_id IN (${placeholders})`,
      ids,
    )) {
      pinned.add(row.messageId);
    }
    for (const row of await db.all<{ messageId: string }>(
      `SELECT message_id AS "messageId" FROM od_chat_saves
        WHERE member_id = ? AND message_id IN (${placeholders})`,
      [viewerMemberId, ...ids],
    )) {
      saved.add(row.messageId);
    }
  }
  return messages.map((message) => ({
    ...message,
    reactions: reactions.get(message.id) ?? [],
    pinned: pinned.has(message.id),
    saved: saved.has(message.id),
  }));
}

function toMessage(row: Record<string, any>, resolveMemberName?: ResolveMemberName): TeamChatMessage {
  const authorMemberId = row.authorMemberId ?? null;
  return {
    id: row.id,
    channelId: row.channelId,
    orgId: row.orgId,
    authorMemberId,
    authorName: authorMemberId ? (resolveMemberName?.(authorMemberId) ?? null) : null,
    body: row.body,
    system: row.system === 1 || row.system === true,
    attachments: sanitizeTeamChatAttachments(parseJsonArray<TeamChatAttachment>(row.attachmentsJson)),
    mentions: parseJsonArray<string>(row.mentionsJson),
    parentMessageId: row.parentMessageId ?? null,
    replyCount: num(row.replyCount ?? 0),
    reactions: [],
    editedAt: nullableNum(row.editedAt),
    deletedAt: nullableNum(row.deletedAt),
    createdAt: num(row.createdAt),
    pinned: false,
    saved: false,
  };
}

export async function listMessages(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  query: ListMessagesQuery = {},
  resolveMemberName?: ResolveMemberName,
): Promise<{ messages: TeamChatMessage[]; nextBefore: string | null }> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));

  const where: string[] = ['m.channel_id = ?', 'm.deleted_at IS NULL'];
  const params: unknown[] = [channel.id];

  if (query.parentMessageId) {
    where.push('m.parent_message_id = ?');
    params.push(query.parentMessageId);
  } else {
    // The channel view shows top-level messages; replies live in their thread.
    where.push('m.parent_message_id IS NULL');
  }

  if (query.before) {
    const cursor = await db.get<{ createdAt: number | string }>(
      'SELECT created_at AS "createdAt" FROM od_chat_messages WHERE id = ?',
      [query.before],
    );
    if (cursor) {
      where.push('m.created_at < ?');
      params.push(num(cursor.createdAt));
    }
  }

  const rows = await db.all<Record<string, any>>(
    `SELECT ${MESSAGE_COLS_M},
            (SELECT COUNT(*) FROM od_chat_messages r
              WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL) AS "replyCount"
       FROM od_chat_messages m
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?`,
    [...params, limit + 1],
  );

  // One extra row is fetched to know whether more history exists without a
  // second COUNT query.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: await withReactions(
      db,
      page.map((row) => toMessage(row, resolveMemberName)).reverse(),
      memberId,
    ),
    nextBefore: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getMessage(
  db: SqlExecutor,
  messageId: string,
  resolveMemberName?: ResolveMemberName,
  viewerMemberId?: string,
): Promise<TeamChatMessage> {
  const row = await db.get<Record<string, any>>(
    `SELECT ${MESSAGE_COLS},
            (SELECT COUNT(*) FROM od_chat_messages r
              WHERE r.parent_message_id = od_chat_messages.id AND r.deleted_at IS NULL) AS "replyCount"
       FROM od_chat_messages WHERE id = ?`,
    [messageId],
  );
  if (!row) {
    throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, `no message ${messageId}`);
  }
  const message = toMessage(row, resolveMemberName);
  if (!viewerMemberId) return message;
  const [withReact] = await withReactions(db, [message], viewerMemberId);
  return withReact ?? message;
}

export async function postMessage(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  memberId: string,
  input: PostMessageRequest,
  resolveMemberName?: ResolveMemberName,
): Promise<TeamChatMessage> {
  const channel = await assertChannelAccess(db, orgId, ref, memberId);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const attachments = sanitizeTeamChatAttachments(input.attachments);
  if (!body && attachments.length === 0) {
    throw workspaceValidationError([{ path: 'body', message: 'a message needs something in it' }]);
  }
  if (body.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw workspaceValidationError([
      { path: 'body', message: `a message may be at most ${CHAT_MESSAGE_MAX_LENGTH} characters` },
    ]);
  }
  if (input.parentMessageId) {
    const parent = await getMessage(db, input.parentMessageId);
    if (parent.channelId !== channel.id) {
      throw workspaceValidationError([
        { path: 'parentMessageId', message: 'a reply must be in the same channel as its parent' },
      ]);
    }
    // Threads are one level deep. Replying to a reply attaches to the same
    // parent, which is what every chat client does and what keeps the read
    // path a single indexed lookup.
    if (parent.parentMessageId) input = { ...input, parentMessageId: parent.parentMessageId };
  }

  // Posting is joining. Someone who says something in a public channel is in
  // it — requiring an explicit join first is friction with no purpose.
  await addMember(db, channel.id, memberId, 'member');

  const id = `msg-${randomUUID()}`;
  const now = await nextMessageTimestamp(db, channel.id);
  await db.run(
    `INSERT INTO od_chat_messages
       (id, channel_id, workspace_id, author_member_id, body, system,
        attachments_json, mentions_json, parent_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      channel.id,
      orgId,
      memberId,
      body,
      JSON.stringify(attachments),
      JSON.stringify(input.mentions ?? []),
      input.parentMessageId ?? null,
      now,
    ],
  );
  // Posting deliberately does not mark the channel read. Your own message is
  // already excluded from your unread count by author, and posting through the
  // CLI or an integration is not evidence you have read what other people said
  // while you were away. The UI marks read when it actually shows the channel.
  return getMessage(db, id, resolveMemberName);
}

/** Post as the daemon itself — "the purchasing pack was installed". System
 * messages have no author and are never editable. */
export async function postSystemMessage(
  db: SqlExecutor,
  orgId: string,
  channelSlug: string,
  body: string,
  attachments: TeamChatAttachment[] = [],
): Promise<TeamChatMessage | null> {
  const row = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_channels WHERE workspace_id = ? AND slug = ? AND archived_at IS NULL',
    [orgId, channelSlug],
  );
  // A system note is a courtesy, not an operation. If the channel is gone,
  // the thing it was announcing still happened.
  if (!row) return null;

  const id = `msg-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_chat_messages
       (id, channel_id, workspace_id, author_member_id, body, system,
        attachments_json, mentions_json, parent_message_id, created_at)
     VALUES (?, ?, ?, NULL, ?, 1, ?, '[]', NULL, ?)`,
    [
      id,
      row.id,
      orgId,
      body,
      JSON.stringify(sanitizeTeamChatAttachments(attachments)),
      await nextMessageTimestamp(db, row.id),
    ],
  );
  return getMessage(db, id);
}


export async function editMessage(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  body: string,
  resolveMemberName?: ResolveMemberName,
): Promise<TeamChatMessage> {
  const message = await getMessage(db, messageId);
  if (message.orgId !== orgId) throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  if (message.system || message.authorMemberId !== memberId) {
    throw new WorkspaceDataError('CHANNEL_ACCESS_DENIED', 403, 'you can only edit your own messages');
  }
  const next = body.trim();
  if (!next) {
    throw workspaceValidationError([{ path: 'body', message: 'a message needs something in it' }]);
  }
  await db.run('UPDATE od_chat_messages SET body = ?, edited_at = ? WHERE id = ?', [
    next,
    Date.now(),
    messageId,
  ]);
  return getMessage(db, messageId, resolveMemberName);
}

/** Soft-delete, so a thread does not lose its replies and the transcript keeps
 * its shape. */
export async function deleteMessage(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const message = await getMessage(db, messageId);
  if (message.orgId !== orgId) throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  // `force` is the admin path, set by the route after a role check.
  if (!options.force && (message.system || message.authorMemberId !== memberId)) {
    throw new WorkspaceDataError('CHANNEL_ACCESS_DENIED', 403, 'you can only delete your own messages');
  }
  await db.run('UPDATE od_chat_messages SET deleted_at = ? WHERE id = ?', [Date.now(), messageId]);
}

function dmSlug(memberIds: string[]): { kind: ChatChannelKind; slug: string } {
  const partners = [...new Set(memberIds.filter((id) => typeof id === 'string' && id.trim()))].sort();
  const digest = createHash('sha256').update(partners.join(',')).digest('hex').slice(0, 16);
  return {
    kind: partners.length === 2 ? 'dm' : 'group_dm',
    slug: `${partners.length === 2 ? 'dm' : 'gdm'}-${digest}`,
  };
}

/** Open (or reuse) a direct message with the given people. The caller is always
 * a member. Two people share one DM; adding a third person later turns it into
 * a group DM rather than creating a parallel room. */
export async function openDirectMessage(
  db: SqlExecutor,
  orgId: string,
  callerId: string,
  memberIds: string[],
  resolveMemberName?: ResolveMemberName,
): Promise<ChatChannel> {
  const partners = [...new Set([callerId, ...memberIds.map((id) => id.trim()).filter(Boolean)])];
  if (partners.length < 2) {
    throw workspaceValidationError([
      { path: 'memberIds', message: 'a direct message needs at least one other person' },
    ]);
  }
  const { kind, slug } = dmSlug(partners);
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_channels WHERE workspace_id = ? AND slug = ? AND archived_at IS NULL',
    [orgId, slug],
  );
  if (existing) {
    await addMember(db, existing.id, callerId, 'member');
    return getChannel(db, orgId, existing.id, callerId);
  }

  const others = partners.filter((id) => id !== callerId);
  const displayName =
    others
      .map((id) => resolveMemberName?.(id) || id)
      .filter(Boolean)
      .join(', ') || 'Direct message';
  const now = Date.now();
  const id = `chn-${randomUUID()}`;
  await db.run(
    `INSERT INTO od_chat_channels
       (id, workspace_id, slug, display_name, topic, purpose, kind, visibility, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 'private', ?, ?, ?)`,
    [id, orgId, slug, displayName, kind, callerId, now, now],
  );
  for (const memberId of partners) {
    await addMember(db, id, memberId, memberId === callerId ? 'owner' : 'member');
  }
  return getChannel(db, orgId, id, callerId);
}

export async function inviteChannelMembers(
  db: SqlExecutor,
  orgId: string,
  ref: string,
  callerId: string,
  memberIds: string[],
): Promise<ChatChannel> {
  const channel = await assertChannelAccess(db, orgId, ref, callerId);
  if (!channel.joined) {
    throw new WorkspaceDataError('CHANNEL_ACCESS_DENIED', 403, 'join this channel before inviting people');
  }
  const ids = [...new Set(memberIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw workspaceValidationError([{ path: 'memberIds', message: 'name at least one person to invite' }]);
  }
  for (const memberId of ids) await addMember(db, channel.id, memberId, 'member');
  if (channel.kind === 'dm') {
    const count = await db.get<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM od_chat_channel_members WHERE channel_id = ?',
      [channel.id],
    );
    if (num(count?.n ?? 0) > 2) {
      await db.run(`UPDATE od_chat_channels SET kind = 'group_dm', updated_at = ? WHERE id = ?`, [
        Date.now(),
        channel.id,
      ]);
    }
  }
  return getChannel(db, orgId, channel.id, callerId);
}

const REACTION_PATTERN = /^[\p{Emoji}\w+-]{1,32}$/u;

export async function toggleReaction(
  db: SqlExecutor,
  orgId: string,
  messageId: string,
  memberId: string,
  emoji: string,
  resolveMemberName?: ResolveMemberName,
): Promise<TeamChatMessage> {
  const name = emoji.trim();
  if (!name || name.length > 32) {
    throw workspaceValidationError([{ path: 'emoji', message: 'pick a short emoji or name' }]);
  }
  if (!REACTION_PATTERN.test(name) && !/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u.test(name)) {
    // Allow any short non-whitespace token; the UI sends unicode emoji or :names:.
    if (/\s/.test(name)) {
      throw workspaceValidationError([{ path: 'emoji', message: 'an emoji cannot contain spaces' }]);
    }
  }
  const message = await getMessage(db, messageId);
  if (message.orgId !== orgId) {
    throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
  }
  await assertChannelAccess(db, orgId, message.channelId, memberId);
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM od_chat_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?',
    [messageId, memberId, name],
  );
  if (existing) {
    await db.run('DELETE FROM od_chat_reactions WHERE id = ?', [existing.id]);
  } else {
    await db.run(
      `INSERT INTO od_chat_reactions (id, message_id, member_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`rxn-${randomUUID()}`, messageId, memberId, name, Date.now()],
    );
  }
  return getMessage(db, messageId, resolveMemberName, memberId);
}

export async function searchMessages(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  query: string,
  resolveMemberName?: ResolveMemberName,
  fromMemberId?: string | null,
): Promise<ChatSearchHit[]> {
  const filters = parseChatSearchQuery(query);
  if (!filters.text && !filters.in && !filters.from && !filters.has && !filters.before && !filters.after) {
    return [];
  }
  const where: string[] = [
    'm.workspace_id = ?',
    'm.deleted_at IS NULL',
    'c.archived_at IS NULL',
    `(
      c.visibility = 'public'
      OR EXISTS (
        SELECT 1 FROM od_chat_channel_members cm
         WHERE cm.channel_id = c.id AND cm.member_id = ?
      )
    )`,
  ];
  const params: unknown[] = [orgId, memberId];
  if (filters.text) {
    where.push(`m.body LIKE ? ESCAPE '\\'`);
    params.push(`%${filters.text.replace(/[%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (filters.in) {
    where.push('(c.slug = ? OR c.id = ?)');
    params.push(filters.in, filters.in);
  }
  const authorId = fromMemberId || null;
  if (authorId) {
    where.push('m.author_member_id = ?');
    params.push(authorId);
  }
  if (filters.before) {
    where.push('m.created_at < ?');
    params.push(filters.before);
  }
  if (filters.after) {
    where.push('m.created_at > ?');
    params.push(filters.after);
  }
  if (filters.has === 'file') {
    where.push(`m.attachments_json LIKE '%"kind":"file"%'`);
  } else if (filters.has === 'link') {
    where.push(`(m.attachments_json LIKE '%"kind":"link"%' OR m.body LIKE '%http%')`);
  } else if (filters.has === 'reaction') {
    where.push('EXISTS (SELECT 1 FROM od_chat_reactions rx WHERE rx.message_id = m.id)');
  }
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${MESSAGE_COLS_M},
            c.id AS "hitChannelId", c.slug AS "hitSlug", c.display_name AS "hitName", c.kind AS "hitKind",
            (SELECT COUNT(*) FROM od_chat_messages r
              WHERE r.parent_message_id = m.id AND r.deleted_at IS NULL) AS "replyCount"
       FROM od_chat_messages m
       JOIN od_chat_channels c ON c.id = m.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT 40`,
    params,
  );
  const messages = await withReactions(
    db,
    rows.map((row) => toMessage(row, resolveMemberName)),
    memberId,
  );
  return messages.map((message, index) => {
    const row = rows[index]!;
    const kind = row.hitKind === 'dm' || row.hitKind === 'group_dm' ? row.hitKind : 'channel';
    return {
      channelId: String(row.hitChannelId ?? message.channelId),
      channelSlug: String(row.hitSlug ?? ''),
      channelName: String(row.hitName ?? ''),
      kind,
      message,
    };
  });
}

// --- Setup ----------------------------------------------------------------

/** Create the starting channels and put the caller in them. Idempotent: a slug
 * that already exists is left alone, so this is safe to call whenever an
 * organization first opens chat. */
export async function setUpDefaultChannels(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
): Promise<ChatChannel[]> {
  const created: ChatChannel[] = [];
  for (const spec of DEFAULT_CHANNELS) {
    const existing = await db.get<{ id: string }>(
      'SELECT id FROM od_chat_channels WHERE workspace_id = ? AND slug = ? AND archived_at IS NULL',
      [orgId, spec.slug],
    );
    if (existing) {
      await addMember(db, existing.id, createdBy, 'member');
      continue;
    }
    created.push(
      await createChannel(db, orgId, createdBy, {
        slug: spec.slug,
        displayName: spec.displayName,
        topic: spec.topic,
      }),
    );
  }
  return created;
}

export async function totalUnread(db: SqlExecutor, orgId: string, memberId: string): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n
       FROM od_chat_messages m
       JOIN od_chat_channel_members cm
         ON cm.channel_id = m.channel_id AND cm.member_id = ?
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL
        AND m.created_at > cm.last_read_at
        AND (m.author_member_id IS NULL OR m.author_member_id <> ?)
        AND COALESCE(cm.muted, 0) = 0
        AND COALESCE(cm.notify, 'all') <> 'nothing'
        AND (
          COALESCE(cm.notify, 'all') = 'all'
          OR m.mentions_json LIKE ?
          OR m.mentions_json LIKE '%"@channel"%'
          OR m.mentions_json LIKE '%"@here"%'
          OR m.mentions_json LIKE '%"@everyone"%'
        )`,
    [memberId, orgId, memberId, `%"${memberId}"%`],
  );
  return num(row?.n ?? 0);
}
