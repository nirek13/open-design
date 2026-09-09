// The chat event log.
//
// Every change a connected client could have missed is appended here, with a
// per-organization sequence number, before anybody is told about it. That
// ordering is the whole point. A stream that fans out first and persists after
// has a window where a subscriber that reconnects in between is told nothing
// happened; a log that is written first can always answer "what came after
// 4182?" — which is the only question a reconnecting client has.
//
// What does NOT go in here: presence, typing, and huddle signalling. Those are
// true for a few seconds and replaying them is worse than dropping them —
// nobody wants to be told, on waking a laptop, that someone started typing on
// Tuesday. They travel the same socket and are handled by the hub in
// `services/chat-realtime.ts`.
//
// Audience: an event row carries either an explicit list of member ids or
// nothing at all. Nothing means "whoever can see this channel", which the hub
// resolves per subscriber; a list means exactly those people, and is how a
// read-marker or a private membership change avoids leaking to the room.

import { randomUUID } from 'node:crypto';
import {
  CHAT_EVENT_RETENTION_MS,
  CHAT_EVENT_REPLAY_LIMIT,
  isDurableChatEvent,
  type ChatDurableEvent,
  type ChatStreamEvent,
} from '@open-design/contracts';
import type { SqlExecutor } from '../storage/sql.js';

export interface StoredChatEvent {
  seq: number;
  type: string;
  channelId: string | null;
  audience: string[] | null;
  event: ChatDurableEvent;
  createdAt: number;
}

export interface AppendChatEventInput {
  /** Which channel the event belongs to, or null for organization-wide news
   * (a new public channel, a user group changing). */
  channelId?: string | null;
  /** Restrict delivery to these member ids. Omit for "anyone who can see the
   * channel". */
  audience?: readonly string[] | null;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Hand out the next sequence number for an organization.
 *
 * A counter row rather than `MAX(seq) + 1`: two posts landing at once would
 * both read the same maximum and both claim it, and the unique index would
 * turn a race into a failed message rather than a reordered one. The upsert
 * does the read and the increment in one statement, so there is no window
 * between them at all. */
async function nextSeq(db: SqlExecutor, orgId: string): Promise<number> {
  const sql =
    db.dialect === 'postgres'
      ? `INSERT INTO od_chat_event_cursor (workspace_id, seq) VALUES (?, 1)
           ON CONFLICT (workspace_id)
           DO UPDATE SET seq = od_chat_event_cursor.seq + 1
         RETURNING seq`
      : `INSERT INTO od_chat_event_cursor (workspace_id, seq) VALUES (?, 1)
           ON CONFLICT(workspace_id)
           DO UPDATE SET seq = seq + 1
         RETURNING seq`;
  const row = await db.get<{ seq: number | string }>(sql, [orgId]);
  return num(row?.seq ?? 1);
}

/** Append one event and return the sequence number it was given.
 *
 * Callers pass an event that is already a `ChatStreamEvent`; an ephemeral one
 * is rejected rather than silently stored, because storing it would mean it
 * gets replayed and the caller almost certainly did not mean that. */
export async function appendChatEvent(
  db: SqlExecutor,
  orgId: string,
  event: ChatStreamEvent,
  input: AppendChatEventInput = {},
): Promise<StoredChatEvent> {
  if (!isDurableChatEvent(event)) {
    throw new Error(`chat event '${event.type}' is ephemeral and must not be logged`);
  }
  const seq = await nextSeq(db, orgId);
  const createdAt = Date.now();
  const channelId = input.channelId ?? channelOf(event);
  const audience = input.audience ? [...new Set(input.audience)] : null;
  await db.run(
    `INSERT INTO od_chat_events
       (id, workspace_id, seq, type, channel_id, audience_json, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `evt-${randomUUID()}`,
      orgId,
      seq,
      event.type,
      channelId,
      audience ? JSON.stringify(audience) : null,
      JSON.stringify(event),
      createdAt,
    ],
  );
  return { seq, type: event.type, channelId, audience, event, createdAt };
}

/** The channel an event is about, read off the event itself so callers do not
 * have to repeat it. Organization-wide events return null. */
function channelOf(event: ChatDurableEvent): string | null {
  if ('channelId' in event && typeof event.channelId === 'string') return event.channelId;
  if ('channel' in event && event.channel) return event.channel.id;
  return null;
}

/** The highest sequence number issued for an organization. Sent in the stream
 * hello so a client can tell "I am up to date" from "I have not caught up". */
export async function currentChatSeq(db: SqlExecutor, orgId: string): Promise<number> {
  const row = await db.get<{ seq: number | string }>(
    'SELECT seq FROM od_chat_event_cursor WHERE workspace_id = ?',
    [orgId],
  );
  return num(row?.seq ?? 0);
}

export interface ChatEventReplay {
  events: StoredChatEvent[];
  /** True when the requested position was older than what the log still holds,
   * so the client is missing events that no longer exist and must reload
   * rather than assume the replay was complete. */
  truncated: boolean;
  /** Where the log is now, whether or not anything was replayed. */
  seq: number;
}

/** Everything after `afterSeq`, oldest first.
 *
 * Two ways this comes back short, and the caller has to tell them apart:
 * the client was already current (nothing to send), or the client is so far
 * behind that the events it wants have been pruned (reload). `truncated`
 * distinguishes them, and is also set when more than the replay limit is
 * waiting — handing a client six thousand frames to apply one at a time is
 * slower than letting it fetch the channel fresh. */
export async function replayChatEvents(
  db: SqlExecutor,
  orgId: string,
  afterSeq: number,
): Promise<ChatEventReplay> {
  const seq = await currentChatSeq(db, orgId);
  if (afterSeq >= seq) return { events: [], truncated: false, seq };

  const oldest = await db.get<{ seq: number | string | null }>(
    'SELECT MIN(seq) AS seq FROM od_chat_events WHERE workspace_id = ?',
    [orgId],
  );
  const earliestHeld = oldest?.seq === null || oldest?.seq === undefined ? seq + 1 : num(oldest.seq);
  // A gap between what the client has and what the log still holds means the
  // events in between were pruned.
  const pruned = afterSeq + 1 < earliestHeld;

  const rows = await db.all<{
    seq: number | string;
    type: string;
    channelId: string | null;
    audienceJson: string | null;
    payloadJson: string;
    createdAt: number | string;
  }>(
    `SELECT seq, type, channel_id AS "channelId", audience_json AS "audienceJson",
            payload_json AS "payloadJson", created_at AS "createdAt"
       FROM od_chat_events
      WHERE workspace_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [orgId, afterSeq, CHAT_EVENT_REPLAY_LIMIT + 1],
  );
  const overflowed = rows.length > CHAT_EVENT_REPLAY_LIMIT;
  const page = overflowed ? rows.slice(0, CHAT_EVENT_REPLAY_LIMIT) : rows;

  const events: StoredChatEvent[] = [];
  for (const row of page) {
    let event: ChatDurableEvent;
    try {
      event = JSON.parse(row.payloadJson) as ChatDurableEvent;
    } catch {
      // A row that will not parse is a row nobody can act on. Skipping it is
      // better than failing the whole replay for the sake of one.
      continue;
    }
    events.push({
      seq: num(row.seq),
      type: row.type,
      channelId: row.channelId,
      audience: parseAudience(row.audienceJson),
      event,
      createdAt: num(row.createdAt),
    });
  }
  return { events, truncated: pruned || overflowed, seq };
}

function parseAudience(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

/** Drop events older than the retention window. Called on a timer by the hub;
 * the cursor is never reset, so sequence numbers keep climbing and a client
 * holding an old one is correctly told it was truncated. */
export async function pruneChatEvents(
  db: SqlExecutor,
  orgId: string,
  now = Date.now(),
): Promise<number> {
  const result = await db.run('DELETE FROM od_chat_events WHERE workspace_id = ? AND created_at < ?', [
    orgId,
    now - CHAT_EVENT_RETENTION_MS,
  ]);
  return result.changes;
}
