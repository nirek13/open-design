import { describe, expect, it } from 'vitest';
import type { ChatPresence } from '@open-design/contracts';

import { applyPresence, presenceState } from '../../src/runtime/team-chat-stream';

const presence = (memberId: string, state: ChatPresence['state']): ChatPresence => ({
  memberId,
  state,
  lastActiveAt: 1_000,
  connections: state === 'offline' ? 0 : 1,
});

describe('applyPresence', () => {
  it('adds someone who was not on the roster', () => {
    expect(applyPresence([], presence('wsm-a', 'active'))).toHaveLength(1);
  });

  it('replaces rather than duplicating an existing row', () => {
    const roster = applyPresence([presence('wsm-a', 'active')], presence('wsm-a', 'away'));
    expect(roster).toHaveLength(1);
    expect(roster[0]?.state).toBe('away');
  });

  it('removes someone who went offline, because the roster is who is here', () => {
    const roster = applyPresence([presence('wsm-a', 'active')], presence('wsm-a', 'offline'));
    expect(roster).toHaveLength(0);
  });

  it('keeps a stable order so a heartbeat does not reshuffle the list', () => {
    let roster = applyPresence([], presence('wsm-c', 'active'));
    roster = applyPresence(roster, presence('wsm-a', 'active'));
    roster = applyPresence(roster, presence('wsm-b', 'active'));
    expect(roster.map((row) => row.memberId)).toEqual(['wsm-a', 'wsm-b', 'wsm-c']);

    // A second update for someone already present must not move them.
    roster = applyPresence(roster, presence('wsm-b', 'away'));
    expect(roster.map((row) => row.memberId)).toEqual(['wsm-a', 'wsm-b', 'wsm-c']);
  });
});

describe('presenceState', () => {
  it('reads someone off the roster', () => {
    const roster = [presence('wsm-a', 'away')];
    expect(presenceState(roster, 'wsm-a')).toBe('away');
  });

  it('treats absence as offline rather than unknown', () => {
    // The roster is built from open connections, so it cannot fall behind the
    // way a stored last-seen column can. Not being in it means not connected.
    expect(presenceState([], 'wsm-a')).toBe('offline');
    expect(presenceState([], null)).toBe('offline');
  });
});
