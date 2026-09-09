// Organization-level chat furniture: the emoji everyone can use, the groups
// you can address, how each person arranges their own sidebar, where an unsent
// draft lives, when someone does not want to be interrupted, how an outside
// system posts in, and how long a channel keeps what was said.
//
// Split from `chat.ts` because the access rules differ. A message is written
// once and read by a room; a draft is rewritten on every keystroke and read by
// exactly one person; a webhook token is written once and never read back at
// all. Keeping them together would mean one file where "who may see this" has
// six different answers.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CHAT_GROUP_HANDLE_PATTERN,
  CHAT_EMOJI_NAME_PATTERN,
  DEFAULT_CHAT_DND,
  normalizeEmojiName,
  sanitizeTeamChatAttachments,
  slugifyChannelName,
  type ChatCustomEmoji,
  type ChatDndSettings,
  type ChatDraft,
  type ChatRetentionPolicy,
  type ChatSection,
  type ChatUserGroup,
  type ChatWebhook,
  type CreateChatSectionRequest,
  type CreateChatUserGroupRequest,
  type CreateChatWebhookRequest,
  type TeamChatAttachment,
  type UpdateChatDndRequest,
  type UpdateChatRetentionRequest,
  type UpdateChatSectionRequest,
  type UpdateChatUserGroupRequest,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Every insert here is "replace what is there, or write it if it is not".
 * SQLite and Postgres spell this the same way, `excluded` included, so one
 * builder serves both — written once because five call sites need it and a
 * hand-written upsert that forgets a column is a bug nobody notices until the
 * second save. */
function upsert(table: string, conflict: string, columns: string[]): string {
  const keys = conflict.split(',').map((key) => key.trim());
  const updates = columns.filter((column) => !keys.includes(column));
  return `INSERT INTO ${table} (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
          ON CONFLICT (${conflict}) DO UPDATE SET ${updates
            .map((column) => `${column} = excluded.${column}`)
            .join(', ')}`;
}

// --- Custom emoji ---------------------------------------------------------

export async function listCustomEmoji(db: SqlExecutor, orgId: string): Promise<ChatCustomEmoji[]> {
  const rows = await db.all<{
    name: string;
    url: string | null;
    aliasFor: string | null;
    createdBy: string;
    createdAt: number | string;
  }>(
    `SELECT name, url, alias_for AS "aliasFor", created_by AS "createdBy", created_at AS "createdAt"
       FROM od_chat_emoji WHERE workspace_id = ? ORDER BY name ASC`,
    [orgId],
  );
  return rows.map((row) => ({
    name: row.name,
    orgId,
    url: row.url,
    aliasFor: row.aliasFor,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
  }));
}

function assertEmojiName(raw: string): string {
  const name = normalizeEmojiName(raw);
  if (!CHAT_EMOJI_NAME_PATTERN.test(name)) {
    throw workspaceValidationError([
      { path: 'name', message: 'an emoji name may use lowercase letters, digits, _ + and -' },
    ]);
  }
  return name;
}

export async function createCustomEmoji(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: { name: string; url: string },
): Promise<ChatCustomEmoji> {
  const name = assertEmojiName(input.name);
  const existing = await db.get('SELECT name FROM od_chat_emoji WHERE workspace_id = ? AND name = ?', [
    orgId,
    name,
  ]);
  if (existing) {
    throw new WorkspaceDataError('CHAT_EMOJI_TAKEN', 409, `:${name}: already exists`);
  }
  const createdAt = Date.now();
  await db.run(
    `INSERT INTO od_chat_emoji (workspace_id, name, url, alias_for, created_by, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    [orgId, name, input.url, createdBy, createdAt],
  );
  return { name, orgId, url: input.url, aliasFor: null, createdBy, createdAt };
}

export async function createEmojiAlias(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: { name: string; aliasFor: string },
): Promise<ChatCustomEmoji> {
  const name = assertEmojiName(input.name);
  const target = normalizeEmojiName(input.aliasFor);
  if (name === target) {
    throw workspaceValidationError([{ path: 'aliasFor', message: 'an alias cannot point at itself' }]);
  }
  const source = await db.get<{ name: string }>(
    'SELECT name FROM od_chat_emoji WHERE workspace_id = ? AND name = ?',
    [orgId, target],
  );
  if (!source) {
    throw new WorkspaceDataError('CHAT_EMOJI_NOT_FOUND', 404, `no emoji :${target}:`);
  }
  const createdAt = Date.now();
  await db.run(
    upsert('od_chat_emoji', 'workspace_id, name', [
      'workspace_id',
      'name',
      'url',
      'alias_for',
      'created_by',
      'created_at',
    ]),
    [orgId, name, null, target, createdBy, createdAt],
  );
  return { name, orgId, url: null, aliasFor: target, createdBy, createdAt };
}

export async function deleteCustomEmoji(db: SqlExecutor, orgId: string, name: string): Promise<void> {
  const normalized = normalizeEmojiName(name);
  const result = await db.run('DELETE FROM od_chat_emoji WHERE workspace_id = ? AND name = ?', [
    orgId,
    normalized,
  ]);
  if (result.changes === 0) {
    throw new WorkspaceDataError('CHAT_EMOJI_NOT_FOUND', 404, `no emoji :${normalized}:`);
  }
  // Aliases pointing at a deleted image would render as a broken picture, so
  // they go with it. Better a missing `:lgtm:` than a broken one.
  await db.run('DELETE FROM od_chat_emoji WHERE workspace_id = ? AND alias_for = ?', [orgId, normalized]);
}

// --- User groups ----------------------------------------------------------

function toGroup(row: Record<string, any>, orgId: string): ChatUserGroup {
  return {
    id: row.id,
    orgId,
    handle: row.handle,
    name: row.name,
    description: row.description ?? null,
    memberIds: parseJsonArray<string>(row.membersJson),
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

const GROUP_COLS = `
  id, handle, name, description, members_json AS "membersJson",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listUserGroups(db: SqlExecutor, orgId: string): Promise<ChatUserGroup[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT ${GROUP_COLS} FROM od_chat_user_groups WHERE workspace_id = ? ORDER BY handle ASC`,
    [orgId],
  );
  return rows.map((row) => toGroup(row, orgId));
}

export async function createUserGroup(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: CreateChatUserGroupRequest,
): Promise<ChatUserGroup> {
  const name = input.name?.trim() ?? '';
  if (!name) {
    throw workspaceValidationError([{ path: 'name', message: 'a group needs a name' }]);
  }
  const handle = (input.handle?.trim().replace(/^@/, '') || slugifyChannelName(name)).toLowerCase();
  if (!CHAT_GROUP_HANDLE_PATTERN.test(handle)) {
    throw workspaceValidationError([
      { path: 'handle', message: 'a group handle may use lowercase letters, digits, and hyphens' },
    ]);
  }
  const existing = await db.get('SELECT id FROM od_chat_user_groups WHERE workspace_id = ? AND handle = ?', [
    orgId,
    handle,
  ]);
  if (existing) {
    throw new WorkspaceDataError('CHAT_GROUP_TAKEN', 409, `@${handle} already exists`);
  }
  const now = Date.now();
  const id = `grp-${randomUUID()}`;
  const memberIds = [...new Set((input.memberIds ?? []).filter((value) => typeof value === 'string'))];
  await db.run(
    `INSERT INTO od_chat_user_groups
       (id, workspace_id, handle, name, description, members_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, handle, name, input.description?.trim() || null, JSON.stringify(memberIds), createdBy, now, now],
  );
  return {
    id,
    orgId,
    handle,
    name,
    description: input.description?.trim() || null,
    memberIds,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateUserGroup(
  db: SqlExecutor,
  orgId: string,
  groupId: string,
  input: UpdateChatUserGroupRequest,
): Promise<ChatUserGroup> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof input.name === 'string' && input.name.trim()) {
    sets.push('name = ?');
    params.push(input.name.trim());
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(input.description?.trim() || null);
  }
  if (Array.isArray(input.memberIds)) {
    sets.push('members_json = ?');
    params.push(JSON.stringify([...new Set(input.memberIds.filter((id) => typeof id === 'string'))]));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(Date.now(), groupId, orgId);
    await db.run(
      `UPDATE od_chat_user_groups SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
      params,
    );
  }
  const row = await db.get<Record<string, any>>(
    `SELECT ${GROUP_COLS} FROM od_chat_user_groups WHERE id = ? AND workspace_id = ?`,
    [groupId, orgId],
  );
  if (!row) throw new WorkspaceDataError('CHAT_GROUP_NOT_FOUND', 404, 'no such group');
  return toGroup(row, orgId);
}

export async function deleteUserGroup(db: SqlExecutor, orgId: string, groupId: string): Promise<void> {
  const result = await db.run('DELETE FROM od_chat_user_groups WHERE id = ? AND workspace_id = ?', [
    groupId,
    orgId,
  ]);
  if (result.changes === 0) {
    throw new WorkspaceDataError('CHAT_GROUP_NOT_FOUND', 404, 'no such group');
  }
}

// --- Sidebar sections -----------------------------------------------------

export async function listSections(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<ChatSection[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT id, name, emoji, position, collapsed, channels_json AS "channelsJson"
       FROM od_chat_sections
      WHERE workspace_id = ? AND member_id = ?
      ORDER BY position ASC, name ASC`,
    [orgId, memberId],
  );
  return rows.map((row) => ({
    id: row.id,
    orgId,
    memberId,
    name: row.name,
    emoji: row.emoji ?? null,
    position: num(row.position),
    collapsed: bool(row.collapsed),
    channelIds: parseJsonArray<string>(row.channelsJson),
  }));
}

export async function createSection(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  input: CreateChatSectionRequest,
): Promise<ChatSection> {
  const name = input.name?.trim() ?? '';
  if (!name) {
    throw workspaceValidationError([{ path: 'name', message: 'a section needs a name' }]);
  }
  const existing = await listSections(db, orgId, memberId);
  const id = `sec-${randomUUID()}`;
  const position = existing.length;
  await db.run(
    `INSERT INTO od_chat_sections
       (id, workspace_id, member_id, name, emoji, position, collapsed, channels_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, '[]', ?)`,
    [id, orgId, memberId, name, input.emoji?.trim() || null, position, Date.now()],
  );
  return { id, orgId, memberId, name, emoji: input.emoji?.trim() || null, position, collapsed: false, channelIds: [] };
}

export async function updateSection(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  sectionId: string,
  input: UpdateChatSectionRequest,
): Promise<ChatSection[]> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof input.name === 'string' && input.name.trim()) {
    sets.push('name = ?');
    params.push(input.name.trim());
  }
  if (input.emoji !== undefined) {
    sets.push('emoji = ?');
    params.push(input.emoji?.trim() || null);
  }
  if (typeof input.position === 'number' && Number.isFinite(input.position)) {
    sets.push('position = ?');
    params.push(Math.max(0, Math.trunc(input.position)));
  }
  if (typeof input.collapsed === 'boolean') {
    sets.push('collapsed = ?');
    params.push(input.collapsed ? 1 : 0);
  }
  if (Array.isArray(input.channelIds)) {
    const channelIds = [...new Set(input.channelIds.filter((id) => typeof id === 'string'))];
    sets.push('channels_json = ?');
    params.push(JSON.stringify(channelIds));
    // A channel belongs to one section at a time. Taking it out of the others
    // here keeps that true without a constraint the JSON column cannot express.
    for (const other of await listSections(db, orgId, memberId)) {
      if (other.id === sectionId) continue;
      const kept = other.channelIds.filter((id) => !channelIds.includes(id));
      if (kept.length === other.channelIds.length) continue;
      await db.run('UPDATE od_chat_sections SET channels_json = ? WHERE id = ?', [
        JSON.stringify(kept),
        other.id,
      ]);
    }
  }
  if (sets.length > 0) {
    params.push(sectionId, orgId, memberId);
    await db.run(
      `UPDATE od_chat_sections SET ${sets.join(', ')}
        WHERE id = ? AND workspace_id = ? AND member_id = ?`,
      params,
    );
  }
  return listSections(db, orgId, memberId);
}

export async function deleteSection(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  sectionId: string,
): Promise<void> {
  // Deleting a section does not delete anything in it: the channels fall back
  // to the default groups, which is what someone dragging a folder to the bin
  // expects to happen.
  const result = await db.run(
    'DELETE FROM od_chat_sections WHERE id = ? AND workspace_id = ? AND member_id = ?',
    [sectionId, orgId, memberId],
  );
  if (result.changes === 0) {
    throw new WorkspaceDataError('CHAT_SECTION_NOT_FOUND', 404, 'no such section');
  }
}

// --- Drafts ---------------------------------------------------------------

const THREAD_KEY = (parentMessageId: string | null | undefined): string => parentMessageId ?? '';

export async function listDrafts(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<ChatDraft[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT channel_id AS "channelId", thread_key AS "threadKey", body,
            attachments_json AS "attachmentsJson", updated_at AS "updatedAt"
       FROM od_chat_drafts
      WHERE workspace_id = ? AND member_id = ? AND body <> ''
      ORDER BY updated_at DESC`,
    [orgId, memberId],
  );
  return rows.map((row) => ({
    channelId: row.channelId,
    parentMessageId: row.threadKey || null,
    body: row.body,
    attachments: sanitizeTeamChatAttachments(parseJsonArray<TeamChatAttachment>(row.attachmentsJson)),
    updatedAt: num(row.updatedAt),
  }));
}

/** Save or clear one draft. An empty body deletes the row rather than storing
 * a blank, so "do I have a draft here?" is a row existing and never a string
 * comparison at every call site. */
export async function saveDraft(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  channelId: string,
  input: { parentMessageId?: string | null; body: string; attachments?: TeamChatAttachment[] },
): Promise<ChatDraft | null> {
  const threadKey = THREAD_KEY(input.parentMessageId);
  const body = typeof input.body === 'string' ? input.body : '';
  const attachments = sanitizeTeamChatAttachments(input.attachments);
  if (!body.trim() && attachments.length === 0) {
    await db.run(
      'DELETE FROM od_chat_drafts WHERE member_id = ? AND channel_id = ? AND thread_key = ?',
      [memberId, channelId, threadKey],
    );
    return null;
  }
  const updatedAt = Date.now();
  await db.run(
    upsert('od_chat_drafts', 'member_id, channel_id, thread_key', [
      'workspace_id',
      'member_id',
      'channel_id',
      'thread_key',
      'body',
      'attachments_json',
      'updated_at',
    ]),
    [orgId, memberId, channelId, threadKey, body, JSON.stringify(attachments), updatedAt],
  );
  return {
    channelId,
    parentMessageId: input.parentMessageId ?? null,
    body,
    attachments,
    updatedAt,
  };
}

export async function deleteDraft(
  db: SqlExecutor,
  memberId: string,
  channelId: string,
  parentMessageId?: string | null,
): Promise<void> {
  await db.run(
    'DELETE FROM od_chat_drafts WHERE member_id = ? AND channel_id = ? AND thread_key = ?',
    [memberId, channelId, THREAD_KEY(parentMessageId)],
  );
}

// --- Do not disturb -------------------------------------------------------

export async function getDnd(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
): Promise<ChatDndSettings> {
  const row = await db.get<Record<string, any>>(
    `SELECT schedule_enabled AS "scheduleEnabled", start_minute AS "startMinute",
            end_minute AS "endMinute", timezone, snooze_until AS "snoozeUntil",
            allow_urgent AS "allowUrgent", updated_at AS "updatedAt"
       FROM od_chat_dnd WHERE member_id = ? AND workspace_id = ?`,
    [memberId, orgId],
  );
  if (!row) return { memberId, ...DEFAULT_CHAT_DND };
  return {
    memberId,
    scheduleEnabled: bool(row.scheduleEnabled),
    startMinute: num(row.startMinute),
    endMinute: num(row.endMinute),
    timezone: row.timezone || 'UTC',
    snoozeUntil: nullableNum(row.snoozeUntil),
    allowUrgent: bool(row.allowUrgent),
    updatedAt: num(row.updatedAt),
  };
}

export async function setDnd(
  db: SqlExecutor,
  orgId: string,
  memberId: string,
  input: UpdateChatDndRequest,
): Promise<ChatDndSettings> {
  const current = await getDnd(db, orgId, memberId);
  const clampMinute = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(1439, Math.max(0, Math.trunc(value)))
      : fallback;
  const next: ChatDndSettings = {
    memberId,
    scheduleEnabled: input.scheduleEnabled ?? current.scheduleEnabled,
    startMinute: clampMinute(input.startMinute, current.startMinute),
    endMinute: clampMinute(input.endMinute, current.endMinute),
    timezone: typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : current.timezone,
    snoozeUntil:
      input.snoozeUntil === undefined
        ? current.snoozeUntil
        : input.snoozeUntil === null
          ? null
          : Math.max(Date.now(), Math.trunc(input.snoozeUntil)),
    allowUrgent: input.allowUrgent ?? current.allowUrgent,
    updatedAt: Date.now(),
  };
  await db.run(
    upsert('od_chat_dnd', 'member_id', [
      'member_id',
      'workspace_id',
      'schedule_enabled',
      'start_minute',
      'end_minute',
      'timezone',
      'snooze_until',
      'allow_urgent',
      'updated_at',
    ]),
    [
      memberId,
      orgId,
      next.scheduleEnabled ? 1 : 0,
      next.startMinute,
      next.endMinute,
      next.timezone,
      next.snoozeUntil,
      next.allowUrgent ? 1 : 0,
      next.updatedAt,
    ],
  );
  return next;
}

/** Everyone's quiet-hours settings at once, so deciding who to push to is one
 * query rather than one per recipient. */
export async function listDnd(db: SqlExecutor, orgId: string): Promise<Map<string, ChatDndSettings>> {
  const rows = await db.all<Record<string, any>>(
    `SELECT member_id AS "memberId", schedule_enabled AS "scheduleEnabled",
            start_minute AS "startMinute", end_minute AS "endMinute", timezone,
            snooze_until AS "snoozeUntil", allow_urgent AS "allowUrgent",
            updated_at AS "updatedAt"
       FROM od_chat_dnd WHERE workspace_id = ?`,
    [orgId],
  );
  const map = new Map<string, ChatDndSettings>();
  for (const row of rows) {
    map.set(row.memberId, {
      memberId: row.memberId,
      scheduleEnabled: bool(row.scheduleEnabled),
      startMinute: num(row.startMinute),
      endMinute: num(row.endMinute),
      timezone: row.timezone || 'UTC',
      snoozeUntil: nullableNum(row.snoozeUntil),
      allowUrgent: bool(row.allowUrgent),
      updatedAt: num(row.updatedAt),
    });
  }
  return map;
}

// --- Incoming webhooks ----------------------------------------------------

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toWebhook(row: Record<string, any>, orgId: string): ChatWebhook {
  return {
    id: row.id,
    orgId,
    channelId: row.channelId,
    channelSlug: row.channelSlug ?? '',
    name: row.name,
    icon: row.icon ?? null,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    lastUsedAt: nullableNum(row.lastUsedAt),
    revokedAt: nullableNum(row.revokedAt),
  };
}

const WEBHOOK_COLS = `
  w.id, w.channel_id AS "channelId", c.slug AS "channelSlug", w.name, w.icon,
  w.created_by AS "createdBy", w.created_at AS "createdAt",
  w.last_used_at AS "lastUsedAt", w.revoked_at AS "revokedAt"
`;

export async function listWebhooks(db: SqlExecutor, orgId: string): Promise<ChatWebhook[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT ${WEBHOOK_COLS}
       FROM od_chat_webhooks w
       JOIN od_chat_channels c ON c.id = w.channel_id
      WHERE w.workspace_id = ? AND w.revoked_at IS NULL
      ORDER BY w.created_at DESC`,
    [orgId],
  );
  return rows.map((row) => toWebhook(row, orgId));
}

export async function createWebhook(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: CreateChatWebhookRequest,
): Promise<{ webhook: ChatWebhook; token: string }> {
  const name = input.name?.trim() ?? '';
  if (!name) {
    throw workspaceValidationError([{ path: 'name', message: 'a webhook needs a name' }]);
  }
  const channel = await db.get<{ id: string; slug: string }>(
    'SELECT id, slug FROM od_chat_channels WHERE workspace_id = ? AND (id = ? OR slug = ?)',
    [orgId, input.channelId, String(input.channelId ?? '').replace(/^#/, '')],
  );
  if (!channel) {
    throw new WorkspaceDataError('CHANNEL_NOT_FOUND', 404, `no channel '${input.channelId}'`);
  }
  // 32 random bytes, shown once. Only the hash is stored, so a leaked database
  // does not hand out the ability to post as this webhook.
  const token = randomBytes(32).toString('base64url');
  const id = `hook-${randomUUID()}`;
  const createdAt = Date.now();
  await db.run(
    `INSERT INTO od_chat_webhooks
       (id, workspace_id, channel_id, name, icon, token_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, channel.id, name, input.icon?.trim() || null, hashWebhookToken(token), createdBy, createdAt],
  );
  return {
    token,
    webhook: {
      id,
      orgId,
      channelId: channel.id,
      channelSlug: channel.slug,
      name,
      icon: input.icon?.trim() || null,
      createdBy,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export async function revokeWebhook(db: SqlExecutor, orgId: string, webhookId: string): Promise<void> {
  const result = await db.run(
    'UPDATE od_chat_webhooks SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
    [Date.now(), webhookId, orgId],
  );
  if (result.changes === 0) {
    throw new WorkspaceDataError('CHAT_WEBHOOK_NOT_FOUND', 404, 'no such webhook');
  }
}

export interface ResolvedWebhook {
  id: string;
  orgId: string;
  channelId: string;
  name: string;
  icon: string | null;
  createdBy: string;
}

/** Find the webhook a token belongs to. Looks up by hash, so the token itself
 * is never compared against anything stored in plaintext. */
export async function resolveWebhookToken(
  db: SqlExecutor,
  token: string,
): Promise<ResolvedWebhook | null> {
  if (!token || token.length < 16) return null;
  const row = await db.get<Record<string, any>>(
    `SELECT id, workspace_id AS "orgId", channel_id AS "channelId", name, icon,
            created_by AS "createdBy"
       FROM od_chat_webhooks
      WHERE token_hash = ? AND revoked_at IS NULL`,
    [hashWebhookToken(token)],
  );
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    channelId: row.channelId,
    name: row.name,
    icon: row.icon ?? null,
    createdBy: row.createdBy,
  };
}

export async function markWebhookUsed(db: SqlExecutor, webhookId: string): Promise<void> {
  await db.run('UPDATE od_chat_webhooks SET last_used_at = ? WHERE id = ?', [Date.now(), webhookId]);
}

// --- Retention ------------------------------------------------------------

export async function getRetention(
  db: SqlExecutor,
  orgId: string,
  channelId: string,
): Promise<ChatRetentionPolicy> {
  const row = await db.get<Record<string, any>>(
    `SELECT days, include_files AS "includeFiles", updated_at AS "updatedAt"
       FROM od_chat_retention WHERE channel_id = ? AND workspace_id = ?`,
    [channelId, orgId],
  );
  return {
    channelId,
    days: row ? nullableNum(row.days) : null,
    includeFiles: row ? bool(row.includeFiles) : false,
    updatedAt: row ? num(row.updatedAt) : 0,
  };
}

export async function setRetention(
  db: SqlExecutor,
  orgId: string,
  channelId: string,
  input: UpdateChatRetentionRequest,
): Promise<ChatRetentionPolicy> {
  const current = await getRetention(db, orgId, channelId);
  const days =
    input.days === undefined
      ? current.days
      : input.days === null
        ? null
        : Math.max(1, Math.trunc(input.days));
  const includeFiles = input.includeFiles ?? current.includeFiles;
  const updatedAt = Date.now();
  await db.run(
    upsert('od_chat_retention', 'channel_id', [
      'channel_id',
      'workspace_id',
      'days',
      'include_files',
      'updated_at',
    ]),
    [channelId, orgId, days, includeFiles ? 1 : 0, updatedAt],
  );
  return { channelId, days, includeFiles, updatedAt };
}

/** Apply every channel's retention policy. Deletes for good rather than
 * soft-deleting: the point of a retention policy is that the content is gone,
 * and a `deleted_at` that still holds the text does not satisfy anyone who
 * asked for one. Returns how many messages went, per channel. */
export async function applyRetention(
  db: SqlExecutor,
  orgId: string,
  now = Date.now(),
): Promise<Map<string, number>> {
  const policies = await db.all<{ channelId: string; days: number | string | null }>(
    'SELECT channel_id AS "channelId", days FROM od_chat_retention WHERE workspace_id = ? AND days IS NOT NULL',
    [orgId],
  );
  const removed = new Map<string, number>();
  for (const policy of policies) {
    const days = nullableNum(policy.days);
    if (!days || days <= 0) continue;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const result = await db.run(
      'DELETE FROM od_chat_messages WHERE channel_id = ? AND created_at < ?',
      [policy.channelId, cutoff],
    );
    if (result.changes > 0) removed.set(policy.channelId, result.changes);
  }
  return removed;
}
