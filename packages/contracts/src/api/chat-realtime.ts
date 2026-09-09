// Team chat realtime: what the server pushes, and what a client may push back.
//
// Chat used to refresh by asking again every five seconds. That is fine for a
// dashboard and wrong for a conversation: it costs a full channel render per
// tick whether or not anything happened, it cannot show that someone is
// typing, and the person you are talking to appears to answer up to five
// seconds late. This module is the contract for the stream that replaces it.
//
// Two kinds of event travel the same wire, and the difference is the whole
// design:
//
//   durable   — a message was posted, a channel was renamed. Written to an
//               append-only log with a per-organization sequence number before
//               anyone is told about it, so a client that reconnects can say
//               "I had 4182" and be handed 4183 onward. Nothing is missed by a
//               laptop that slept.
//   ephemeral — someone is typing, someone came online, a huddle offer. True
//               only for the moment it is sent. Never logged, never replayed;
//               replaying "Ada is typing" from four minutes ago is worse than
//               not knowing.
//
// The union below is closed on purpose. A client switches exhaustively over
// it, so adding a case is a contract change that fails the build in every
// place that has to care.

import type {
  ChatBookmark,
  ChatChannel,
  ChatChannelMember,
  TeamChatMessage,
} from './team-chat.js';

// --- Presence -------------------------------------------------------------

/** `active` is a live tab. `away` is a client that said so, or one whose tab
 * has been hidden past the idle threshold. `offline` is no connection at all —
 * it is never sent as an update, it is what absence from the roster means. */
export type ChatPresenceState = 'active' | 'away' | 'offline';

export interface ChatPresence {
  memberId: string;
  state: ChatPresenceState;
  /** Epoch-ms of the last thing this member did — a heartbeat, a keystroke,
   * a read. Drives "active 20m ago" without a second query. */
  lastActiveAt: number;
  /** How many tabs/devices are connected. A close on one of three tabs is not
   * a member going offline. */
  connections: number;
}

/** Sent by the client on a timer while its tab is open. The server treats a
 * missing heartbeat as `offline` after PRESENCE_TIMEOUT_MS. */
export interface ChatHeartbeatRequest {
  state?: ChatPresenceState;
}

/** A client heartbeat is expected about this often. */
export const PRESENCE_HEARTBEAT_MS = 25_000;

/** No heartbeat for this long and the member drops off the roster. Deliberately
 * more than twice the heartbeat so one dropped request is not a disconnect. */
export const PRESENCE_TIMEOUT_MS = 70_000;

/** A tab hidden longer than this reports itself away without disconnecting. */
export const PRESENCE_IDLE_MS = 5 * 60_000;

// --- Typing ---------------------------------------------------------------

export interface ChatTyping {
  channelId: string;
  memberId: string;
  /** Set when the person is typing into a thread rather than the channel, so
   * the indicator appears in the right column. */
  parentMessageId: string | null;
  /** Epoch-ms after which this indicator is stale and must be dropped by the
   * client even if no stop event arrives. */
  expiresAt: number;
}

export interface ChatTypingRequest {
  parentMessageId?: string;
  /** `false` retracts an indicator early — on send, or on clearing the box. */
  typing?: boolean;
}

/** How long one typing signal stands before the client must drop it. The
 * composer re-sends while a person keeps typing, so this is a floor on
 * chattiness, not on how long the indicator can stay up. */
export const TYPING_TTL_MS = 6_000;

/** The composer sends at most one typing signal per this interval. */
export const TYPING_THROTTLE_MS = 3_000;

// --- Huddles --------------------------------------------------------------

/** A live audio room attached to a channel. The daemon never carries audio —
 * it carries the offers, answers, and ICE candidates that let two browsers
 * find each other, and the roster of who is in. Media is peer-to-peer. */
export interface ChatHuddle {
  id: string;
  orgId: string;
  channelId: string;
  startedBy: string;
  startedAt: number;
  endedAt: number | null;
  participants: ChatHuddleParticipant[];
}

export interface ChatHuddleParticipant {
  memberId: string;
  displayName: string | null;
  joinedAt: number;
  muted: boolean;
  /** True while this participant is sharing their screen. */
  sharing: boolean;
}

/** One WebRTC negotiation frame, addressed to a single peer. The daemon does
 * not read `payload`; it checks that both ends are in the same huddle and
 * relays. Keeping the body opaque means a browser-side change to the SDP or
 * candidate shape is not a daemon change. */
export interface ChatHuddleSignal {
  huddleId: string;
  fromMemberId: string;
  toMemberId: string;
  kind: 'offer' | 'answer' | 'candidate' | 'bye';
  payload: unknown;
}

export interface ChatHuddleSignalRequest {
  toMemberId: string;
  kind: ChatHuddleSignal['kind'];
  payload: unknown;
}

export interface ChatHuddleStateRequest {
  muted?: boolean;
  sharing?: boolean;
}

export interface ChatHuddleResponse {
  huddle: ChatHuddle;
}

export interface ChatHuddlesResponse {
  huddles: ChatHuddle[];
}

// --- The stream -----------------------------------------------------------

/** Events written to the durable log. Every one of these carries a sequence
 * number on the wire and survives a reconnect. */
export type ChatDurableEvent =
  | { type: 'message-posted'; channelId: string; message: TeamChatMessage }
  | { type: 'message-edited'; channelId: string; message: TeamChatMessage }
  | { type: 'message-deleted'; channelId: string; messageId: string }
  | { type: 'reaction-changed'; channelId: string; message: TeamChatMessage }
  | { type: 'channel-created'; channel: ChatChannel }
  | { type: 'channel-updated'; channel: ChatChannel }
  | { type: 'channel-archived'; channelId: string; archivedAt: number }
  | { type: 'member-joined'; channelId: string; member: ChatChannelMember }
  | { type: 'member-left'; channelId: string; memberId: string }
  | { type: 'pin-changed'; channelId: string; messageId: string; pinned: boolean }
  | { type: 'bookmark-changed'; channelId: string; bookmarks: ChatBookmark[] }
  | { type: 'huddle-started'; channelId: string; huddle: ChatHuddle }
  | { type: 'huddle-ended'; channelId: string; huddleId: string }
  | { type: 'huddle-roster'; channelId: string; huddle: ChatHuddle };

/** Events that are true only right now. Never logged, never replayed. */
export type ChatEphemeralEvent =
  | { type: 'presence'; presence: ChatPresence }
  | { type: 'typing'; typing: ChatTyping }
  | { type: 'huddle-signal'; signal: ChatHuddleSignal }
  | { type: 'read-marker'; channelId: string; memberId: string; lastReadAt: number };

export type ChatStreamEvent = ChatDurableEvent | ChatEphemeralEvent;

const DURABLE_TYPES = new Set<string>([
  'message-posted',
  'message-edited',
  'message-deleted',
  'reaction-changed',
  'channel-created',
  'channel-updated',
  'channel-archived',
  'member-joined',
  'member-left',
  'pin-changed',
  'bookmark-changed',
  'huddle-started',
  'huddle-ended',
  'huddle-roster',
]);

/** True when this event belongs in the log and must be replayable. The single
 * place that decides; the writer and the reader both call it rather than each
 * keeping a list that can drift. */
export function isDurableChatEvent(event: ChatStreamEvent): event is ChatDurableEvent {
  return DURABLE_TYPES.has(event.type);
}

/** One frame as it appears on the SSE wire. `seq` is present exactly when the
 * event is durable, and is what a client echoes back as `Last-Event-ID`. */
export interface ChatStreamFrame {
  seq: number | null;
  orgId: string;
  event: ChatStreamEvent;
}

/** Sent once when a stream opens, before any event. Tells the client where the
 * log currently is (so it can tell "nothing happened" from "I have not caught
 * up yet") and hands it the roster it would otherwise have to fetch. */
export interface ChatStreamHello {
  orgId: string;
  memberId: string;
  seq: number;
  presence: ChatPresence[];
  huddles: ChatHuddle[];
  /** True when the requested `Last-Event-ID` was older than the retained log,
   * so the client must reload rather than assume it is up to date. */
  truncated: boolean;
}

/** How much history the log keeps. A week is long enough that a laptop shut
 * over a weekend still resumes, and short enough that the table stays small. */
export const CHAT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Replay is capped so a very stale client gets told to reload instead of
 * being handed ten thousand frames it will re-render one at a time. */
export const CHAT_EVENT_REPLAY_LIMIT = 500;
