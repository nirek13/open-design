// The live half of team chat: one stream, and the state it keeps current.
//
// Before this, the view asked the server for the whole open channel every five
// seconds and diffed the answer. That is why replies appeared late, why
// nothing could show that somebody was typing, and why forty idle tabs were
// forty requests a second against a laptop.
//
// The shape here is deliberately narrow. This hook owns the connection and the
// three things only the connection knows — presence, typing, and live huddles —
// and it hands every durable event to a callback. It does not own the
// transcript: deciding that a `message-posted` for the open channel appends to
// the list, while one for another channel bumps a badge, is the view's
// business and depends on what the view is showing.
//
// Reconnects are the browser's job (EventSource resumes from `Last-Event-ID`),
// so the only thing this adds on top is the reload signal: when the server says
// the replay was truncated, the client has a hole it cannot fill and must
// refetch rather than pretend it is current.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_IDLE_MS,
  TYPING_THROTTLE_MS,
  type ChatHuddle,
  type ChatPresence,
  type ChatStreamEvent,
  type ChatTyping,
} from '@open-design/contracts';
import { sendChatHeartbeat, sendChatTyping } from '../../providers/registry';
import {
  applyPresence,
  openTeamChatStream,
  type ChatStreamStatus,
  type TeamChatStreamHandle,
} from '../../runtime/team-chat-stream';

export interface TeamChatRealtime {
  status: ChatStreamStatus;
  presence: ChatPresence[];
  /** Live typing rows, already filtered to exclude the viewer and to drop
   * anything past its expiry. */
  typing: ChatTyping[];
  huddles: ChatHuddle[];
  /** Where the log was when the stream last said hello. Useful for showing
   * "reconnecting" honestly rather than optimistically. */
  seq: number;
  /** Announce that the viewer is typing. Throttled internally, so the composer
   * can call it on every keystroke without thinking about it. */
  notifyTyping(channelRef: string, parentMessageId: string | null, typing: boolean): void;
}

export interface UseTeamChatRealtimeInput {
  orgId: string | null;
  /** Suspended when the chat view is not on screen: an inactive tab should not
   * hold a stream open or claim presence. */
  active: boolean;
  myMemberId: string | null;
  /** Every durable event, in order, live or replayed. */
  onEvent(event: ChatStreamEvent): void;
  /** The client is behind by more than the log retains, or the connection was
   * re-established after being closed. Refetch rather than patch. */
  onResync(): void;
}

export function useTeamChatRealtime(input: UseTeamChatRealtimeInput): TeamChatRealtime {
  const { orgId, active, myMemberId } = input;
  const [status, setStatus] = useState<ChatStreamStatus>('closed');
  const [presence, setPresence] = useState<ChatPresence[]>([]);
  const [typing, setTyping] = useState<ChatTyping[]>([]);
  const [huddles, setHuddles] = useState<ChatHuddle[]>([]);
  const [seq, setSeq] = useState(0);

  // Handlers change on every render of the view; the stream must not. Holding
  // them in refs means the connection is opened once per organization rather
  // than torn down and rebuilt whenever the parent re-renders.
  const onEventRef = useRef(input.onEvent);
  const onResyncRef = useRef(input.onResync);
  onEventRef.current = input.onEvent;
  onResyncRef.current = input.onResync;

  const streamRef = useRef<TeamChatStreamHandle | null>(null);
  const typingSentAt = useRef(new Map<string, number>());
  const helloCount = useRef(0);

  useEffect(() => {
    if (!active || !orgId) {
      streamRef.current?.close();
      streamRef.current = null;
      setStatus('closed');
      setPresence([]);
      setTyping([]);
      return;
    }
    helloCount.current = 0;
    const handle = openTeamChatStream(orgId, {
      onStatus: setStatus,
      onHello(hello) {
        setSeq(hello.seq);
        setPresence(hello.presence);
        setHuddles(hello.huddles);
        helloCount.current += 1;
        // The first hello is the initial load, which the view has already
        // fetched around. Any later one is a reconnect: either the server said
        // it could not catch us up, or we were disconnected long enough that
        // silently continuing would leave the transcript wrong.
        if (hello.truncated || helloCount.current > 1) onResyncRef.current();
      },
      onEvent(event, eventSeq) {
        if (eventSeq !== null) setSeq((prev) => Math.max(prev, eventSeq));
        switch (event.type) {
          case 'presence':
            setPresence((prev) => applyPresence(prev, event.presence));
            return;
          case 'typing':
            setTyping((prev) => {
              const without = prev.filter(
                (row) =>
                  row.memberId !== event.typing.memberId
                  || row.channelId !== event.typing.channelId
                  || row.parentMessageId !== event.typing.parentMessageId,
              );
              return event.typing.expiresAt > Date.now() ? [...without, event.typing] : without;
            });
            return;
          case 'huddle-started':
          case 'huddle-roster':
            setHuddles((prev) => [
              ...prev.filter((row) => row.id !== event.huddle.id),
              event.huddle,
            ]);
            onEventRef.current(event);
            return;
          case 'huddle-ended':
            setHuddles((prev) => prev.filter((row) => row.id !== event.huddleId));
            onEventRef.current(event);
            return;
          default:
            onEventRef.current(event);
        }
      },
    });
    streamRef.current = handle;
    return () => {
      handle.close();
      streamRef.current = null;
    };
  }, [active, orgId]);

  // Typing rows carry their own expiry so a client that never hears the stop
  // event still takes the indicator down. Sweeping on a timer rather than
  // filtering at render time means the indicator disappears on its own instead
  // of waiting for the next unrelated re-render.
  useEffect(() => {
    if (typing.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTyping((prev) => (prev.some((row) => row.expiresAt <= now)
        ? prev.filter((row) => row.expiresAt > now)
        : prev));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [typing.length]);

  // Presence heartbeat. A hidden tab reports itself away rather than
  // disconnecting, so a laptop with chat open in a background tab still shows
  // its owner as reachable without claiming they are looking at it.
  useEffect(() => {
    if (!active || !orgId) return;
    let lastInteraction = Date.now();
    const noteInteraction = () => {
      lastInteraction = Date.now();
    };
    window.addEventListener('keydown', noteInteraction, { passive: true });
    window.addEventListener('pointerdown', noteInteraction, { passive: true });

    const beat = () => {
      const idle = Date.now() - lastInteraction > PRESENCE_IDLE_MS;
      const state = document.visibilityState === 'hidden' || idle ? 'away' : 'active';
      void sendChatHeartbeat(orgId, state).catch(() => {
        // A missed heartbeat expires presence on its own after the timeout.
        // Retrying harder here would only add load while the daemon is
        // already struggling.
      });
    };
    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      window.removeEventListener('keydown', noteInteraction);
      window.removeEventListener('pointerdown', noteInteraction);
    };
  }, [active, orgId]);

  const notifyTyping = useCallback(
    (channelRef: string, parentMessageId: string | null, isTyping: boolean) => {
      if (!orgId) return;
      const key = `${channelRef}:${parentMessageId ?? ''}`;
      const now = Date.now();
      // A stop is always sent — it is the difference between an indicator that
      // disappears when you send and one that lingers for six seconds. Starts
      // are throttled, because a keystroke is not news.
      if (isTyping && now - (typingSentAt.current.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
      typingSentAt.current.set(key, isTyping ? now : 0);
      void sendChatTyping(orgId, channelRef, { parentMessageId, typing: isTyping }).catch(() => {
        // Cosmetic. Never worth surfacing.
      });
    },
    [orgId],
  );

  return {
    status,
    presence,
    typing: typing.filter((row) => row.memberId !== myMemberId),
    huddles,
    seq,
    notifyTyping,
  };
}
