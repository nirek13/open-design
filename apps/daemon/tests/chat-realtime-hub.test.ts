import { describe, expect, it, vi } from 'vitest';

import { PRESENCE_TIMEOUT_MS, TYPING_TTL_MS } from '@open-design/contracts';
import { ChatRealtimeHub, type ChatStreamSink } from '../src/services/chat-realtime.js';
import type { StoredChatEvent } from '../src/workspace-data/chat-events.js';

/** A sink that records what was written and can pretend to be backed up. */
function fakeSink(): ChatStreamSink & { frames: string[]; closed: boolean; buffered: number } {
  const sink = {
    frames: [] as string[],
    closed: false,
    buffered: 0,
    write(chunk: string) {
      sink.frames.push(chunk);
      return true;
    },
    bufferedBytes: () => sink.buffered,
    close() {
      sink.closed = true;
    },
  };
  return sink;
}

function storedEvent(overrides: Partial<StoredChatEvent> = {}): StoredChatEvent {
  return {
    seq: 1,
    type: 'message-posted',
    channelId: 'chn-public',
    audience: null,
    createdAt: Date.now(),
    event: {
      type: 'message-deleted',
      channelId: 'chn-public',
      messageId: 'msg-1',
    },
    ...overrides,
  };
}

/** Ada can see the public channel and the private one she is in; Ravi can only
 * see the public one. */
const resolver = {
  async visibleChannelIds(_orgId: string, memberId: string) {
    return memberId === 'wsm-ada'
      ? new Set(['chn-public', 'chn-private'])
      : new Set(['chn-public']);
  },
};

/** Deliveries are dispatched without awaiting — a slow visibility lookup must
 * not hold up the write that triggered it — and they are chained per
 * organization so order is preserved. Yielding a few times lets the chain
 * drain. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('the chat realtime hub', () => {
  it('delivers a channel event only to people who can see the channel', async () => {
    const hub = new ChatRealtimeHub(resolver);
    const ada = fakeSink();
    const ravi = fakeSink();
    hub.subscribe('org-1', 'wsm-ada', ada);
    hub.subscribe('org-1', 'wsm-ravi', ravi);

    hub.publish('org-1', storedEvent({ channelId: 'chn-private' }));
    await settle();

    expect(ada.frames.some((frame) => frame.includes('message-deleted'))).toBe(true);
    expect(ravi.frames.some((frame) => frame.includes('message-deleted'))).toBe(false);
    hub.closeAll();
  });

  it('honours an explicit audience over channel visibility', async () => {
    const hub = new ChatRealtimeHub(resolver);
    const ada = fakeSink();
    const ravi = fakeSink();
    hub.subscribe('org-1', 'wsm-ada', ada);
    hub.subscribe('org-1', 'wsm-ravi', ravi);

    // A public channel everyone can see, but an event addressed to one person.
    hub.publish('org-1', storedEvent({ channelId: 'chn-public', audience: ['wsm-ravi'] }));
    await settle();

    expect(ravi.frames.some((frame) => frame.includes('message-deleted'))).toBe(true);
    expect(ada.frames.some((frame) => frame.includes('message-deleted'))).toBe(false);
    hub.closeAll();
  });

  it('sends organization-wide events to everyone connected', async () => {
    const hub = new ChatRealtimeHub(resolver);
    const ravi = fakeSink();
    hub.subscribe('org-1', 'wsm-ravi', ravi);

    hub.publish('org-1', storedEvent({ channelId: null }));
    await settle();

    expect(ravi.frames.some((frame) => frame.includes('message-deleted'))).toBe(true);
    hub.closeAll();
  });

  it('stamps a durable frame with its sequence number and an ephemeral one without', async () => {
    // The `id:` line is what the browser echoes back as Last-Event-ID. Putting
    // one on a typing frame would make a client resume from a moment that was
    // never worth replaying.
    const hub = new ChatRealtimeHub(resolver);
    const ada = fakeSink();
    hub.subscribe('org-1', 'wsm-ada', ada);

    hub.publish('org-1', storedEvent({ seq: 42 }));
    hub.publishEphemeral(
      'org-1',
      { type: 'typing', typing: { channelId: 'chn-public', memberId: 'wsm-ravi', parentMessageId: null, expiresAt: Date.now() + TYPING_TTL_MS } },
      { channelId: 'chn-public' },
    );
    await settle();

    const durable = ada.frames.find((frame) => frame.includes('message-deleted'));
    const ephemeral = ada.frames.find((frame) => frame.includes('"typing"'));
    expect(durable).toContain('id: 42');
    expect(ephemeral).not.toContain('id:');
    hub.closeAll();
  });

  it('disconnects a subscriber whose socket has backed up', async () => {
    // Nothing is lost by doing this: durable events are already in the log, so
    // the client reconnects and replays. Letting the buffer grow instead would
    // trade one stalled tab for the whole process.
    const hub = new ChatRealtimeHub(resolver);
    const stalled = fakeSink();
    stalled.buffered = 8 * 1024 * 1024;
    hub.subscribe('org-1', 'wsm-ada', stalled);

    hub.publish('org-1', storedEvent({ channelId: null }));
    await settle();

    expect(stalled.closed).toBe(true);
    expect(hub.subscriberCount('org-1')).toBe(0);
    hub.closeAll();
  });

  it('counts connections rather than people, so closing one tab of two is not going offline', () => {
    const hub = new ChatRealtimeHub(resolver);
    const tabOne = hub.subscribe('org-1', 'wsm-ada', fakeSink());
    hub.subscribe('org-1', 'wsm-ada', fakeSink());

    expect(hub.presence('org-1')).toHaveLength(1);
    expect(hub.presence('org-1')[0]?.connections).toBe(2);

    tabOne.close();
    expect(hub.presence('org-1')[0]?.state).toBe('active');
    expect(hub.presence('org-1')[0]?.connections).toBe(1);
    hub.closeAll();
  });

  it('drops presence for a member whose heartbeat stopped', () => {
    const hub = new ChatRealtimeHub(resolver);
    hub.heartbeat('org-1', 'wsm-ghost');
    expect(hub.presence('org-1')).toHaveLength(1);

    // No socket, no heartbeat: a laptop lid closing without a clean disconnect.
    hub.sweep(Date.now() + PRESENCE_TIMEOUT_MS + 1_000);
    expect(hub.presence('org-1')).toHaveLength(0);
    hub.closeAll();
  });

  it('expires typing on its own and clears it when the typist disconnects', () => {
    const hub = new ChatRealtimeHub(resolver);
    const subscription = hub.subscribe('org-1', 'wsm-ravi', fakeSink());
    hub.typing('org-1', 'chn-public', 'wsm-ravi', null, true);
    expect(hub.typingIn('org-1', 'chn-public')).toHaveLength(1);

    hub.sweep(Date.now() + TYPING_TTL_MS + 1_000);
    expect(hub.typingIn('org-1', 'chn-public')).toHaveLength(0);

    hub.typing('org-1', 'chn-public', 'wsm-ravi', null, true);
    subscription.close();
    expect(hub.typingIn('org-1', 'chn-public')).toHaveLength(0);
    hub.closeAll();
  });

  it('re-asks the data layer once membership changes rather than waiting out the cache', async () => {
    const visible = vi.fn(async () => new Set(['chn-public']));
    const hub = new ChatRealtimeHub({ visibleChannelIds: visible });
    hub.subscribe('org-1', 'wsm-ada', fakeSink());

    hub.publish('org-1', storedEvent());
    await settle();
    hub.publish('org-1', storedEvent({ seq: 2 }));
    await settle();
    expect(visible).toHaveBeenCalledTimes(1);

    hub.invalidateVisibility('org-1');
    hub.publish('org-1', storedEvent({ seq: 3 }));
    await settle();
    expect(visible).toHaveBeenCalledTimes(2);
    hub.closeAll();
  });

  it('delivers in publish order even when the first lookup is slower', async () => {
    // Deciding who may hear an event can await a query. Without a per
    // organization chain, an edit whose visibility was cached could overtake
    // the post whose lookup went to the database — and a client that sees
    // `message-edited` first drops it, then shows the stale original.
    let firstCall = true;
    const hub = new ChatRealtimeHub({
      async visibleChannelIds() {
        if (firstCall) {
          firstCall = false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return new Set(['chn-public']);
      },
    });
    const ada = fakeSink();
    hub.subscribe('org-1', 'wsm-ada', ada);

    hub.publish('org-1', storedEvent({ seq: 1 }));
    hub.publish(
      'org-1',
      storedEvent({
        seq: 2,
        event: { type: 'message-deleted', channelId: 'chn-public', messageId: 'msg-second' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Only durable frames carry an id. Subscribing also emits a presence
    // frame, which deliberately has none — so the ordering claim is about the
    // frames that have one.
    const ids = ada.frames
      .map((frame) => /id: (\d+)/.exec(frame)?.[1])
      .filter((id): id is string => Boolean(id));
    expect(ids).toEqual(['1', '2']);
    hub.closeAll();
  });

  it('says no when visibility cannot be established', async () => {
    // A missed event is one refresh away. A leaked one is not recoverable.
    const hub = new ChatRealtimeHub({
      visibleChannelIds: async () => {
        throw new Error('database is gone');
      },
    });
    const ada = fakeSink();
    hub.subscribe('org-1', 'wsm-ada', ada);

    hub.publish('org-1', storedEvent({ channelId: 'chn-private' }));
    await settle();

    expect(ada.frames.some((frame) => frame.includes('message-deleted'))).toBe(false);
    hub.closeAll();
  });
});
