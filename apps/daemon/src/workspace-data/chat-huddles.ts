// Huddles: the live audio room attached to a channel.
//
// The daemon never carries audio. It carries the roster — who is in, who is
// muted, who is sharing a screen — and it relays the offers, answers, and ICE
// candidates that let two browsers find each other. Media then flows directly
// between them. That split is deliberate: a laptop daemon has no business
// being an audio mixer, and a peer-to-peer call does not stop working when the
// tab that started it closes.
//
// Signalling frames are not stored. They are meaningful for the second it
// takes two peers to agree on a route, and a replayed offer from ten minutes
// ago would try to renegotiate a call that is already up. They ride the
// ephemeral side of the realtime stream and are gone.

import { randomUUID } from 'node:crypto';
import type { ChatHuddle, ChatHuddleParticipant } from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';
import type { ResolveMemberName } from './chat.js';

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

async function loadParticipants(
  db: SqlExecutor,
  huddleId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddleParticipant[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT member_id AS "memberId", joined_at AS "joinedAt", muted, sharing
       FROM od_chat_huddle_participants
      WHERE huddle_id = ? AND left_at IS NULL
      ORDER BY joined_at ASC`,
    [huddleId],
  );
  return rows.map((row) => ({
    memberId: row.memberId,
    displayName: resolveMemberName?.(row.memberId) ?? null,
    joinedAt: num(row.joinedAt),
    muted: bool(row.muted),
    sharing: bool(row.sharing),
  }));
}

async function loadHuddle(
  db: SqlExecutor,
  orgId: string,
  huddleId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle> {
  const row = await db.get<Record<string, any>>(
    `SELECT id, channel_id AS "channelId", started_by AS "startedBy",
            started_at AS "startedAt", ended_at AS "endedAt"
       FROM od_chat_huddles WHERE id = ? AND workspace_id = ?`,
    [huddleId, orgId],
  );
  if (!row) throw new WorkspaceDataError('HUDDLE_NOT_FOUND', 404, 'no such huddle');
  return {
    id: row.id,
    orgId,
    channelId: row.channelId,
    startedBy: row.startedBy,
    startedAt: num(row.startedAt),
    endedAt: nullableNum(row.endedAt),
    participants: await loadParticipants(db, row.id, resolveMemberName),
  };
}

/** The huddle running in a channel, if any. At most one per channel — a second
 * one would split the room in half without anybody being told which half they
 * are in. */
export async function liveHuddle(
  db: SqlExecutor,
  orgId: string,
  channelId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle | null> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM od_chat_huddles
      WHERE workspace_id = ? AND channel_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, channelId],
  );
  return row ? loadHuddle(db, orgId, row.id, resolveMemberName) : null;
}

export async function listLiveHuddles(
  db: SqlExecutor,
  orgId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle[]> {
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM od_chat_huddles WHERE workspace_id = ? AND ended_at IS NULL ORDER BY started_at ASC',
    [orgId],
  );
  return Promise.all(rows.map((row) => loadHuddle(db, orgId, row.id, resolveMemberName)));
}

/** Join the channel's huddle, starting one if there is none.
 *
 * Deliberately one call rather than start-then-join: from where the person
 * clicking is standing, "start a huddle" and "join the huddle" are the same
 * button, and making the client decide which to send is how two people
 * clicking at once end up in two different rooms. */
export async function joinHuddle(
  db: SqlExecutor,
  orgId: string,
  channelId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle> {
  const existing = await db.get<{ id: string }>(
    `SELECT id FROM od_chat_huddles
      WHERE workspace_id = ? AND channel_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, channelId],
  );
  const now = Date.now();
  let huddleId = existing?.id;
  if (!huddleId) {
    huddleId = `hdl-${randomUUID()}`;
    await db.run(
      `INSERT INTO od_chat_huddles (id, workspace_id, channel_id, started_by, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      [huddleId, orgId, channelId, memberId, now],
    );
  }
  // Rejoining after a dropped connection clears the earlier `left_at` rather
  // than inserting a second row, so the roster never shows one person twice.
  await db.run(
    `INSERT INTO od_chat_huddle_participants (huddle_id, member_id, joined_at, left_at, muted, sharing)
     VALUES (?, ?, ?, NULL, 0, 0)
     ON CONFLICT (huddle_id, member_id)
     DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at`,
    [huddleId, memberId, now],
  );
  return loadHuddle(db, orgId, huddleId, resolveMemberName);
}

/** Leave. The huddle ends when the last person goes, because an empty room
 * that still shows a live dot in the sidebar is worse than no dot. */
export async function leaveHuddle(
  db: SqlExecutor,
  orgId: string,
  huddleId: string,
  memberId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<{ huddle: ChatHuddle; ended: boolean }> {
  const now = Date.now();
  await db.run(
    'UPDATE od_chat_huddle_participants SET left_at = ? WHERE huddle_id = ? AND member_id = ? AND left_at IS NULL',
    [now, huddleId, memberId],
  );
  const remaining = await db.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM od_chat_huddle_participants WHERE huddle_id = ? AND left_at IS NULL',
    [huddleId],
  );
  const ended = num(remaining?.n ?? 0) === 0;
  if (ended) {
    await db.run('UPDATE od_chat_huddles SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [
      now,
      huddleId,
    ]);
  }
  return { huddle: await loadHuddle(db, orgId, huddleId, resolveMemberName), ended };
}

export async function setHuddleState(
  db: SqlExecutor,
  orgId: string,
  huddleId: string,
  memberId: string,
  input: { muted?: boolean; sharing?: boolean },
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof input.muted === 'boolean') {
    sets.push('muted = ?');
    params.push(input.muted ? 1 : 0);
  }
  if (typeof input.sharing === 'boolean') {
    sets.push('sharing = ?');
    params.push(input.sharing ? 1 : 0);
  }
  if (sets.length > 0) {
    params.push(huddleId, memberId);
    await db.run(
      `UPDATE od_chat_huddle_participants SET ${sets.join(', ')}
        WHERE huddle_id = ? AND member_id = ? AND left_at IS NULL`,
      params,
    );
  }
  return loadHuddle(db, orgId, huddleId, resolveMemberName);
}

/** True when both members are currently in the same huddle. The relay checks
 * this before forwarding a signalling frame, so a stranger holding a huddle id
 * cannot use the daemon to reach someone's browser. */
export async function bothInHuddle(
  db: SqlExecutor,
  huddleId: string,
  a: string,
  b: string,
): Promise<boolean> {
  const row = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM od_chat_huddle_participants
      WHERE huddle_id = ? AND left_at IS NULL AND member_id IN (?, ?)`,
    [huddleId, a, b],
  );
  return num(row?.n ?? 0) === 2;
}

export async function getHuddle(
  db: SqlExecutor,
  orgId: string,
  huddleId: string,
  resolveMemberName?: ResolveMemberName,
): Promise<ChatHuddle> {
  return loadHuddle(db, orgId, huddleId, resolveMemberName);
}

/** Close huddles nobody has been in for a while. A browser that crashes never
 * sends a leave, so without this a channel can show a live huddle forever. */
export async function reapStaleHuddles(
  db: SqlExecutor,
  orgId: string,
  staleAfterMs: number,
  now = Date.now(),
): Promise<string[]> {
  const rows = await db.all<{ id: string; startedAt: number | string }>(
    `SELECT h.id, h.started_at AS "startedAt"
       FROM od_chat_huddles h
      WHERE h.workspace_id = ? AND h.ended_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM od_chat_huddle_participants p
           WHERE p.huddle_id = h.id AND p.left_at IS NULL
        )`,
    [orgId],
  );
  const ended: string[] = [];
  for (const row of rows) {
    if (now - num(row.startedAt) < staleAfterMs) continue;
    await db.run('UPDATE od_chat_huddles SET ended_at = ? WHERE id = ?', [now, row.id]);
    ended.push(row.id);
  }
  return ended;
}
