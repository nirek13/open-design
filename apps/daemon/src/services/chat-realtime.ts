// The chat realtime hub.
//
// One process-wide registry of open streams, plus the two pieces of state that
// exist only while someone is connected: who is here, and who is typing.
//
// Three problems this file exists to solve, and the shape of each answer:
//
//   Who may hear this?     A subscriber is told about a channel event only if
//                          they can see the channel. The check is a callback
//                          into the data layer, memoised per member for a few
//                          seconds and dropped outright whenever membership
//                          changes, so a private channel never leaks and a
//                          fan-out to fifty tabs is not fifty queries.
//
//   What if a client is    Nothing is dropped silently. Durable events are
//   slow or asleep?        already in the log with a sequence number; a
//                          subscriber whose socket has backed up past
//                          MAX_BUFFERED_BYTES is disconnected rather than
//                          allowed to grow without bound, and reconnects with
//                          `Last-Event-ID` to collect exactly what it missed.
//
//   When is someone gone?  Presence is a heartbeat with a timeout, counted per
//                          connection. Closing one of three tabs is not going
//                          offline; a laptop lid closing without a clean
//                          disconnect still clears after PRESENCE_TIMEOUT_MS.

import { randomUUID } from 'node:crypto';
import {
  PRESENCE_TIMEOUT_MS,
  TYPING_TTL_MS,
  type ChatEphemeralEvent,
  type ChatPresence,
  type ChatPresenceState,
  type ChatStreamFrame,
  type ChatTyping,
} from '@open-design/contracts';
import type { StoredChatEvent } from '../workspace-data/chat-events.js';

/** A socket has to fall this far behind before it is treated as broken rather
 * than slow. Roughly a megabyte — far more than a live conversation produces,
 * far less than enough to matter to the process. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** How long a resolved "which channels can this member see" answer is trusted
 * before it is asked again. Short enough that a stale answer is a few seconds
 * of a public channel not appearing, never of a private one leaking — because
 * joins and leaves invalidate it immediately regardless. */
const VISIBILITY_TTL_MS = 15_000;

/** Ephemeral state is swept on this interval. */
const SWEEP_MS = 10_000;

/** What the hub needs from the data layer, passed in rather than imported so
 * the hub has no opinion about storage and can be tested with a fake. */
export interface ChatVisibilityResolver {
  /** Channel ids this member may see right now: public channels plus the
   * private ones and DMs they belong to. */
  visibleChannelIds(orgId: string, memberId: string): Promise<Set<string>>;
}

export interface ChatStreamSink {
  /** Returns false when the underlying socket is backed up. */
  write(chunk: string): boolean;
  bufferedBytes(): number;
  close(): void;
}

export interface ChatSubscription {
  readonly id: string;
  readonly orgId: string;
  readonly memberId: string;
  close(): void;
}

interface Subscriber {
  id: string;
  orgId: string;
  memberId: string;
  sink: ChatStreamSink;
}

interface PresenceEntry {
  memberId: string;
  state: ChatPresenceState;
  lastActiveAt: number;
  /** Subscriber ids, so a heartbeat from a tab that has since closed does not
   * keep a member alive. */
  connections: Set<string>;
  /** Set by an explicit heartbeat; a member with no heartbeat but an open
   * socket is still `active`, because the socket itself is evidence. */
  expiresAt: number;
}

interface TypingEntry extends ChatTyping {}

interface VisibilityCacheEntry {
  channelIds: Set<string>;
  expiresAt: number;
}

function typingKey(channelId: string, memberId: string, parentMessageId: string | null): string {
  return `${channelId}\u0000${memberId}\u0000${parentMessageId ?? ''}`;
}

export class ChatRealtimeHub {
  readonly #byOrg = new Map<string, Map<string, Subscriber>>();
  readonly #presence = new Map<string, Map<string, PresenceEntry>>();
  readonly #typing = new Map<string, Map<string, TypingEntry>>();
  readonly #visibility = new Map<string, VisibilityCacheEntry>();
  /** The tail of each organization's delivery chain. Deciding who may hear an
   * event can await a database query, so two events published a millisecond
   * apart could otherwise be written to a socket in the opposite order — and a
   * client that receives `message-edited` before `message-posted` drops the
   * edit and then shows the original. Chaining makes delivery order the same
   * as publish order, which is the order the log already assigns. */
  readonly #deliveryTail = new Map<string, Promise<void>>();
  readonly #resolver: ChatVisibilityResolver;
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(resolver: ChatVisibilityResolver) {
    this.#resolver = resolver;
  }

  /** Start the timer that expires stale presence and typing rows. Idempotent,
   * so wiring it from more than one place is harmless. */
  start(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.#sweeper.unref?.();
  }

  stop(): void {
    if (!this.#sweeper) return;
    clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /** Open streams for an organization, for diagnostics and tests. */
  subscriberCount(orgId: string): number {
    return this.#byOrg.get(orgId)?.size ?? 0;
  }

  subscribe(orgId: string, memberId: string, sink: ChatStreamSink): ChatSubscription {
    const id = `sub-${randomUUID()}`;
    const subscriber: Subscriber = { id, orgId, memberId, sink };
    let org = this.#byOrg.get(orgId);
    if (!org) {
      org = new Map();
      this.#byOrg.set(orgId, org);
    }
    org.set(id, subscriber);
    this.#connect(orgId, memberId, id);
    this.start();

    const close = () => {
      const bucket = this.#byOrg.get(orgId);
      if (!bucket?.delete(id)) return;
      if (bucket.size === 0) this.#byOrg.delete(orgId);
      this.#disconnect(orgId, memberId, id);
      try {
        sink.close();
      } catch {
        // Closing an already-closed socket is not an error worth reporting.
      }
    };
    return { id, orgId, memberId, close };
  }

  // --- Delivery -----------------------------------------------------------

  /** Fan a logged event out to everyone entitled to hear it. The event is
   * already persisted by the time this runs, so a delivery failure costs a
   * client nothing it cannot recover on reconnect. */
  publish(orgId: string, stored: StoredChatEvent): void {
    this.#enqueue(orgId, () =>
      this.#deliver(
        orgId,
        { seq: stored.seq, orgId, event: stored.event },
        stored.channelId,
        stored.audience,
      ),
    );
  }

  /** Send something that is true only right now. Never logged, so a client
   * that is not connected simply does not learn it — which is correct. */
  publishEphemeral(
    orgId: string,
    event: ChatEphemeralEvent,
    options: { channelId?: string | null; audience?: readonly string[] | null } = {},
  ): void {
    this.#enqueue(orgId, () =>
      this.#deliver(
        orgId,
        { seq: null, orgId, event },
        options.channelId ?? null,
        options.audience ? [...options.audience] : null,
      ),
    );
  }

  /** Run `work` after everything already queued for this organization.
   *
   * The chain is per organization rather than global so a slow visibility
   * lookup in one does not hold up another, and a failure never breaks the
   * chain — the tail always resolves, so one bad delivery cannot wedge every
   * later event behind it. */
  #enqueue(orgId: string, work: () => Promise<void>): void {
    const previous = this.#deliveryTail.get(orgId) ?? Promise.resolve();
    const next = previous.then(work, work).catch(() => {});
    this.#deliveryTail.set(orgId, next);
    void next.then(() => {
      // Drop the entry once this was the last one, so an organization nobody
      // is talking in does not keep a resolved promise alive forever.
      if (this.#deliveryTail.get(orgId) === next) this.#deliveryTail.delete(orgId);
    });
  }

  async #deliver(
    orgId: string,
    frame: ChatStreamFrame,
    channelId: string | null,
    audience: string[] | null,
  ): Promise<void> {
    const bucket = this.#byOrg.get(orgId);
    if (!bucket || bucket.size === 0) return;
    const subscribers = [...bucket.values()];
    const line = this.#encode(frame);

    // An explicit audience is the cheap and the strict path: no visibility
    // question to ask, and nobody outside the list can be reached by accident.
    if (audience) {
      const allowed = new Set(audience);
      for (const subscriber of subscribers) {
        if (allowed.has(subscriber.memberId)) this.#write(subscriber, line);
      }
      return;
    }

    // Organization-wide news goes to every member with a stream open.
    if (!channelId) {
      for (const subscriber of subscribers) this.#write(subscriber, line);
      return;
    }

    // One visibility lookup per distinct member, not per socket.
    const byMember = new Map<string, Subscriber[]>();
    for (const subscriber of subscribers) {
      const list = byMember.get(subscriber.memberId);
      if (list) list.push(subscriber);
      else byMember.set(subscriber.memberId, [subscriber]);
    }
    await Promise.all(
      [...byMember.entries()].map(async ([memberId, sockets]) => {
        if (!(await this.#canSee(orgId, memberId, channelId))) return;
        for (const socket of sockets) this.#write(socket, line);
      }),
    );
  }

  #encode(frame: ChatStreamFrame): string {
    const id = frame.seq === null ? '' : `id: ${frame.seq}\n`;
    return `${id}event: chat\ndata: ${JSON.stringify(frame)}\n\n`;
  }

  #write(subscriber: Subscriber, line: string): void {
    try {
      subscriber.sink.write(line);
      if (subscriber.sink.bufferedBytes() > MAX_BUFFERED_BYTES) {
        // The client is not keeping up. Dropping it is safe: durable events are
        // in the log, and its reconnect will replay from where it stopped.
        this.#dropSubscriber(subscriber);
      }
    } catch {
      this.#dropSubscriber(subscriber);
    }
  }

  #dropSubscriber(subscriber: Subscriber): void {
    const bucket = this.#byOrg.get(subscriber.orgId);
    if (!bucket?.delete(subscriber.id)) return;
    if (bucket.size === 0) this.#byOrg.delete(subscriber.orgId);
    this.#disconnect(subscriber.orgId, subscriber.memberId, subscriber.id);
    try {
      subscriber.sink.close();
    } catch {
      // Already gone.
    }
  }

  // --- Visibility ---------------------------------------------------------

  async #canSee(orgId: string, memberId: string, channelId: string): Promise<boolean> {
    const key = `${orgId}\u0000${memberId}`;
    const cached = this.#visibility.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.channelIds.has(channelId);
    try {
      const channelIds = await this.#resolver.visibleChannelIds(orgId, memberId);
      this.#visibility.set(key, { channelIds, expiresAt: Date.now() + VISIBILITY_TTL_MS });
      return channelIds.has(channelId);
    } catch {
      // If the answer cannot be established, say no. A missed event is a
      // refresh away; a leaked one is not recoverable.
      return false;
    }
  }

  /** Forget what this member could see. Called whenever membership or channel
   * visibility changes, so the next event is decided on fresh information
   * rather than waiting out the TTL. */
  invalidateVisibility(orgId: string, memberId?: string): void {
    if (memberId) {
      this.#visibility.delete(`${orgId}\u0000${memberId}`);
      return;
    }
    const prefix = `${orgId}\u0000`;
    for (const key of this.#visibility.keys()) {
      if (key.startsWith(prefix)) this.#visibility.delete(key);
    }
  }

  // --- Presence -----------------------------------------------------------

  #presenceFor(orgId: string): Map<string, PresenceEntry> {
    let bucket = this.#presence.get(orgId);
    if (!bucket) {
      bucket = new Map();
      this.#presence.set(orgId, bucket);
    }
    return bucket;
  }

  #connect(orgId: string, memberId: string, subscriberId: string): void {
    const bucket = this.#presenceFor(orgId);
    const now = Date.now();
    const entry = bucket.get(memberId) ?? {
      memberId,
      state: 'active' as ChatPresenceState,
      lastActiveAt: now,
      connections: new Set<string>(),
      expiresAt: now + PRESENCE_TIMEOUT_MS,
    };
    const wasEmpty = entry.connections.size === 0;
    entry.connections.add(subscriberId);
    entry.lastActiveAt = now;
    entry.expiresAt = now + PRESENCE_TIMEOUT_MS;
    if (wasEmpty) entry.state = 'active';
    bucket.set(memberId, entry);
    if (wasEmpty) this.#broadcastPresence(orgId, entry);
  }

  #disconnect(orgId: string, memberId: string, subscriberId: string): void {
    const bucket = this.#presence.get(orgId);
    const entry = bucket?.get(memberId);
    if (!bucket || !entry) return;
    entry.connections.delete(subscriberId);
    if (entry.connections.size > 0) return;
    bucket.delete(memberId);
    this.#clearTypingFor(orgId, memberId);
    this.#broadcastPresence(orgId, {
      ...entry,
      state: 'offline',
      connections: new Set(),
    });
  }

  /** Record that a member is alive, and how they want to be shown. Returns the
   * presence row so the caller can echo it back on the HTTP response. */
  heartbeat(orgId: string, memberId: string, state: ChatPresenceState = 'active'): ChatPresence {
    const bucket = this.#presenceFor(orgId);
    const now = Date.now();
    const entry = bucket.get(memberId) ?? {
      memberId,
      state,
      lastActiveAt: now,
      connections: new Set<string>(),
      expiresAt: now + PRESENCE_TIMEOUT_MS,
    };
    const changed = entry.state !== state;
    entry.state = state;
    // Only an active beat counts as activity. Being away for an hour should
    // read as "active 1h ago", not as continuous presence.
    if (state === 'active') entry.lastActiveAt = now;
    entry.expiresAt = now + PRESENCE_TIMEOUT_MS;
    bucket.set(memberId, entry);
    const presence = toPresence(entry);
    if (changed) this.#broadcastPresence(orgId, entry);
    return presence;
  }

  presence(orgId: string): ChatPresence[] {
    const bucket = this.#presence.get(orgId);
    if (!bucket) return [];
    return [...bucket.values()].map(toPresence);
  }

  #broadcastPresence(orgId: string, entry: PresenceEntry): void {
    this.publishEphemeral(orgId, { type: 'presence', presence: toPresence(entry) });
  }

  // --- Typing -------------------------------------------------------------

  #typingFor(orgId: string): Map<string, TypingEntry> {
    let bucket = this.#typing.get(orgId);
    if (!bucket) {
      bucket = new Map();
      this.#typing.set(orgId, bucket);
    }
    return bucket;
  }

  /** Say that someone started or stopped typing. A stop is broadcast with an
   * already-elapsed expiry, which is how a client is told to take the
   * indicator down without a second event shape to handle. */
  typing(
    orgId: string,
    channelId: string,
    memberId: string,
    parentMessageId: string | null,
    typing: boolean,
  ): ChatTyping {
    const bucket = this.#typingFor(orgId);
    const key = typingKey(channelId, memberId, parentMessageId);
    const entry: TypingEntry = {
      channelId,
      memberId,
      parentMessageId,
      expiresAt: typing ? Date.now() + TYPING_TTL_MS : Date.now() - 1,
    };
    if (typing) bucket.set(key, entry);
    else bucket.delete(key);
    this.publishEphemeral(orgId, { type: 'typing', typing: entry }, { channelId });
    return entry;
  }

  typingIn(orgId: string, channelId: string): ChatTyping[] {
    const bucket = this.#typing.get(orgId);
    if (!bucket) return [];
    const now = Date.now();
    return [...bucket.values()].filter(
      (entry) => entry.channelId === channelId && entry.expiresAt > now,
    );
  }

  #clearTypingFor(orgId: string, memberId: string): void {
    const bucket = this.#typing.get(orgId);
    if (!bucket) return;
    for (const [key, entry] of bucket) {
      if (entry.memberId !== memberId) continue;
      bucket.delete(key);
      this.publishEphemeral(
        orgId,
        { type: 'typing', typing: { ...entry, expiresAt: Date.now() - 1 } },
        { channelId: entry.channelId },
      );
    }
  }

  // --- Housekeeping -------------------------------------------------------

  /** Expire what nobody refreshed. Typing rows simply vanish — the client
   * already drops them at `expiresAt`, so no event is needed. Presence is
   * announced, because "went offline" is something other people are looking
   * at right now. */
  sweep(now = Date.now()): void {
    for (const [, bucket] of this.#typing) {
      for (const [key, entry] of bucket) {
        if (entry.expiresAt <= now) bucket.delete(key);
      }
    }
    for (const [orgId, bucket] of this.#presence) {
      for (const [memberId, entry] of bucket) {
        if (entry.connections.size > 0 || entry.expiresAt > now) continue;
        bucket.delete(memberId);
        this.#broadcastPresence(orgId, { ...entry, state: 'offline', connections: new Set() });
      }
    }
    for (const [key, entry] of this.#visibility) {
      if (entry.expiresAt <= now) this.#visibility.delete(key);
    }
  }

  /** Close every stream. Used on shutdown so sockets are not left hanging. */
  closeAll(): void {
    for (const [, bucket] of this.#byOrg) {
      for (const subscriber of [...bucket.values()]) this.#dropSubscriber(subscriber);
    }
    this.stop();
  }
}

function toPresence(entry: PresenceEntry): ChatPresence {
  return {
    memberId: entry.memberId,
    state: entry.connections.size === 0 ? 'offline' : entry.state,
    lastActiveAt: entry.lastActiveAt,
    connections: entry.connections.size,
  };
}
