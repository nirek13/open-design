// The browser end of the chat stream.
//
// `EventSource` rather than a hand-rolled fetch reader, for one reason that
// matters more than the rest: the browser already implements resume. It stores
// the `id:` of the last frame it saw and replays it as `Last-Event-ID` on
// every reconnect, without the page having to remember anything across a
// dropped connection, a sleeping laptop, or a daemon restart. Reimplementing
// that on top of `fetch` means reimplementing the part most likely to be
// subtly wrong.
//
// The session travels as the `od_session` cookie the auth layer plants —
// EventSource cannot set an Authorization header, which is exactly why that
// cookie exists. The organization is in the path rather than a header for the
// same reason.
//
// What this module deliberately does not do is interpret events. It hands
// frames to a listener and manages the connection; deciding that a
// `message-posted` for the open channel should append to the transcript is the
// view's business, and mixing the two is how a transport ends up knowing about
// scroll position.

import type {
  ChatPresence,
  ChatStreamEvent,
  ChatStreamFrame,
  ChatStreamHello,
} from '@open-design/contracts';

export type ChatStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TeamChatStreamHandlers {
  /** Every frame, live or replayed, in order. */
  onEvent(event: ChatStreamEvent, seq: number | null): void;
  /** Sent once per connection, before any event. `truncated` means the client
   * was too far behind to be caught up and must reload. */
  onHello(hello: ChatStreamHello): void;
  onStatus?(status: ChatStreamStatus): void;
}

export interface TeamChatStreamHandle {
  close(): void;
  status(): ChatStreamStatus;
}

/** Open a chat stream for one organization.
 *
 * Returns a handle rather than an object with methods to call later, because
 * there is nothing to say to a stream: it is opened, it delivers, and it is
 * closed. Everything a client wants to push travels as an ordinary POST that
 * already has validation and error handling. */
export function openTeamChatStream(
  orgId: string,
  handlers: TeamChatStreamHandlers,
): TeamChatStreamHandle {
  let status: ChatStreamStatus = 'connecting';
  let source: EventSource | null = null;
  let closed = false;

  const setStatus = (next: ChatStreamStatus) => {
    if (status === next) return;
    status = next;
    handlers.onStatus?.(next);
  };

  const connect = () => {
    if (closed) return;
    // Server-side rendering and jsdom have no EventSource. Reporting the stream
    // as closed lets the view fall back to what it fetched, rather than
    // throwing during a render that had nothing to do with realtime.
    if (typeof EventSource === 'undefined') {
      setStatus('closed');
      return;
    }
    // `withCredentials` is what carries the session cookie. Without it the
    // stream is anonymous and the daemon answers 401 forever.
    source = new EventSource(`/api/orgs/${encodeURIComponent(orgId)}/chat/stream`, {
      withCredentials: true,
    });

    source.addEventListener('open', () => setStatus('open'));

    source.addEventListener('hello', (event) => {
      try {
        handlers.onHello(JSON.parse((event as MessageEvent<string>).data) as ChatStreamHello);
        setStatus('open');
      } catch {
        // A hello we cannot read means we do not know where the log is. The
        // connection is still useful for live events, so this is not fatal.
      }
    });

    source.addEventListener('chat', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent<string>).data) as ChatStreamFrame;
        handlers.onEvent(frame.event, frame.seq);
      } catch {
        // One unreadable frame is not worth tearing down a working connection.
      }
    });

    source.addEventListener('error', () => {
      // EventSource reconnects on its own unless it has given up, in which case
      // readyState is CLOSED. Distinguishing the two is the difference between
      // showing "reconnecting" and silently never recovering.
      if (source?.readyState === EventSource.CLOSED) {
        setStatus('closed');
        source = null;
        if (!closed) {
          // A closed source will not retry. This happens on a 401 — a session
          // that expired while the tab was open — so back off and try again
          // rather than leaving the page permanently stale.
          window.setTimeout(() => {
            if (!closed) connect();
          }, 15_000);
        }
        return;
      }
      setStatus('reconnecting');
    });
  };

  connect();

  return {
    close() {
      closed = true;
      source?.close();
      source = null;
      setStatus('closed');
    },
    status: () => status,
  };
}

/** Fold one presence update into a roster, keeping it sorted by member id so
 * rendering does not reorder on every heartbeat. `offline` removes rather than
 * marks, because a roster is "who is here". */
export function applyPresence(
  roster: readonly ChatPresence[],
  next: ChatPresence,
): ChatPresence[] {
  const without = roster.filter((row) => row.memberId !== next.memberId);
  if (next.state === 'offline') return without;
  return [...without, next].sort((a, b) => a.memberId.localeCompare(b.memberId));
}

/** How a member should be shown right now.
 *
 * Someone with no roster entry is offline, not unknown: the roster is complete
 * by construction, since it is built from open connections rather than from a
 * table that can fall behind. */
export function presenceState(
  roster: readonly ChatPresence[],
  memberId: string | null | undefined,
): 'active' | 'away' | 'offline' {
  if (!memberId) return 'offline';
  const found = roster.find((row) => row.memberId === memberId);
  if (!found) return 'offline';
  return found.state === 'offline' ? 'offline' : found.state;
}
