// Huddles in the browser: a small full-mesh WebRTC call.
//
// Full mesh rather than a server-mixed conference because the daemon carries
// no audio — it relays offers, answers, and ICE candidates, and the browsers
// talk to each other. For the size of a huddle (a handful of people around one
// channel) a mesh is the right shape: no media server to run, no single point
// that has to be online, and the call keeps working if the daemon restarts
// mid-conversation.
//
// The one genuinely fiddly part of a mesh is glare — two peers offering to
// each other at the same moment, each rejecting the other's offer because it
// arrived while their own was in flight. The fix here is not to detect and
// recover but to make it impossible: for any pair, the member whose id sorts
// lower is the only one that offers. Both sides can compute that from the
// roster they already have, so there is nothing to agree on.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHuddle, ChatHuddleSignal } from '@open-design/contracts';
import {
  joinChatHuddle,
  leaveChatHuddle,
  sendChatHuddleSignal,
  setChatHuddleState,
} from '../../providers/registry';

/** Public STUN only. A huddle between two laptops on the same office network
 * connects without it; one across NATs needs a reflexive candidate, and there
 * is no TURN here — a call that cannot traverse a symmetric NAT fails rather
 * than being relayed through infrastructure this product does not run. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export interface HuddleState {
  huddle: ChatHuddle | null;
  /** Member ids whose audio is currently arriving. */
  connected: string[];
  muted: boolean;
  error: string | null;
  joining: boolean;
}

export interface HuddleControls extends HuddleState {
  join(channelRef: string): Promise<void>;
  leave(): Promise<void>;
  toggleMute(): Promise<void>;
  /** Feed one relayed signalling frame in. Called by the view from the stream. */
  accept(signal: ChatHuddleSignal): void;
  /** Keep the local roster in step with `huddle-roster` events. */
  sync(huddle: ChatHuddle): void;
}

export function useChatHuddle(orgId: string | null, myMemberId: string | null): HuddleControls {
  const [huddle, setHuddle] = useState<ChatHuddle | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const huddleRef = useRef<ChatHuddle | null>(null);
  huddleRef.current = huddle;

  const teardownPeer = useCallback((memberId: string) => {
    peers.current.get(memberId)?.close();
    peers.current.delete(memberId);
    const audio = audioEls.current.get(memberId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audioEls.current.delete(memberId);
    }
    setConnected((prev) => prev.filter((id) => id !== memberId));
  }, []);

  const teardownAll = useCallback(() => {
    for (const memberId of [...peers.current.keys()]) teardownPeer(memberId);
    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    setConnected([]);
    setMuted(false);
  }, [teardownPeer]);

  /** Open (or reuse) a connection to one peer.
   *
   * `polite` is the half of the glare rule that does not offer. It answers,
   * and it is the side that would back down if both ever did offer — which,
   * given the id comparison, it will not have to. */
  const peerFor = useCallback(
    (peerId: string, huddleId: string): RTCPeerConnection => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;

      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peers.current.set(peerId, connection);

      for (const track of localStream.current?.getTracks() ?? []) {
        connection.addTrack(track, localStream.current!);
      }

      connection.addEventListener('icecandidate', (event) => {
        if (!event.candidate || !orgId) return;
        void sendChatHuddleSignal(orgId, huddleId, {
          toMemberId: peerId,
          kind: 'candidate',
          payload: event.candidate.toJSON(),
        }).catch(() => {
          // A dropped candidate costs one path, not the call.
        });
      });

      connection.addEventListener('track', (event) => {
        // One audio element per peer, attached to the document but never
        // rendered: the browser will not play a stream that is not attached to
        // something, and there is nothing to look at.
        let audio = audioEls.current.get(peerId);
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          audioEls.current.set(peerId, audio);
        }
        audio.srcObject = event.streams[0] ?? null;
        void audio.play().catch(() => {
          // Autoplay policy. The join was a click, so this is rare; when it
          // does happen the next interaction starts it.
        });
        setConnected((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
      });

      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
          teardownPeer(peerId);
        }
      });

      return connection;
    },
    [orgId, teardownPeer],
  );

  /** Bring the mesh in line with the roster: offer to anyone new we are
   * responsible for, and drop anyone who has left. */
  const reconcile = useCallback(
    async (next: ChatHuddle) => {
      if (!orgId || !myMemberId || !localStream.current) return;
      const present = new Set(next.participants.map((row) => row.memberId));
      for (const peerId of [...peers.current.keys()]) {
        if (!present.has(peerId)) teardownPeer(peerId);
      }
      for (const participant of next.participants) {
        const peerId = participant.memberId;
        if (peerId === myMemberId || peers.current.has(peerId)) continue;
        // The lower id offers. Deterministic on both sides, so exactly one
        // offer is ever in flight for a pair.
        if (myMemberId > peerId) {
          // The other side will offer; open nothing yet and let the offer
          // create the connection.
          continue;
        }
        const connection = peerFor(peerId, next.id);
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await sendChatHuddleSignal(orgId, next.id, {
          toMemberId: peerId,
          kind: 'offer',
          payload: offer,
        }).catch(() => teardownPeer(peerId));
      }
    },
    [orgId, myMemberId, peerFor, teardownPeer],
  );

  const join = useCallback(
    async (channelRef: string) => {
      if (!orgId) return;
      setJoining(true);
      setError(null);
      try {
        localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const next = await joinChatHuddle(orgId, channelRef);
        setHuddle(next);
        await reconcile(next);
      } catch (err) {
        // The common failure is a denied microphone, and "NotAllowedError" is
        // not something to put in front of a person.
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'microphone access is needed for a huddle'
            : err instanceof Error
              ? err.message
              : String(err),
        );
        teardownAll();
        setHuddle(null);
      } finally {
        setJoining(false);
      }
    },
    [orgId, reconcile, teardownAll],
  );

  const leave = useCallback(async () => {
    const current = huddleRef.current;
    teardownAll();
    setHuddle(null);
    if (!orgId || !current) return;
    await leaveChatHuddle(orgId, current.id).catch(() => {
      // Leaving locally is what matters; the server reaps an abandoned
      // participant on its own.
    });
  }, [orgId, teardownAll]);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    for (const track of localStream.current?.getAudioTracks() ?? []) {
      track.enabled = !next;
    }
    const current = huddleRef.current;
    if (!orgId || !current) return;
    await setChatHuddleState(orgId, current.id, { muted: next }).catch(() => {
      // The mute is already applied to the track; the roster catching up is a
      // nicety.
    });
  }, [muted, orgId]);

  const accept = useCallback(
    (signal: ChatHuddleSignal) => {
      const current = huddleRef.current;
      if (!orgId || !current || signal.huddleId !== current.id) return;
      void (async () => {
        try {
          if (signal.kind === 'bye') {
            teardownPeer(signal.fromMemberId);
            return;
          }
          const connection = peerFor(signal.fromMemberId, current.id);
          if (signal.kind === 'offer') {
            await connection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            await sendChatHuddleSignal(orgId, current.id, {
              toMemberId: signal.fromMemberId,
              kind: 'answer',
              payload: answer,
            });
            return;
          }
          if (signal.kind === 'answer') {
            await connection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
            return;
          }
          // A candidate can arrive before the description it belongs to. The
          // browser rejects it; the connection still forms from the ones that
          // arrive in order, so this is noise rather than failure.
          await connection.addIceCandidate(signal.payload as RTCIceCandidateInit).catch(() => {});
        } catch {
          teardownPeer(signal.fromMemberId);
        }
      })();
    },
    [orgId, peerFor, teardownPeer],
  );

  const sync = useCallback(
    (next: ChatHuddle) => {
      const current = huddleRef.current;
      if (!current || next.id !== current.id) return;
      setHuddle(next);
      void reconcile(next);
    },
    [reconcile],
  );

  // Leaving the page should hang up. Without this, a closed tab leaves a
  // participant on the roster until the server reaps it, and everyone else
  // keeps a dead peer connection open.
  useEffect(() => {
    const onUnload = () => {
      teardownAll();
    };
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      teardownAll();
    };
  }, [teardownAll]);

  return { huddle, connected, muted, error, joining, join, leave, toggleMute, accept, sync };
}
