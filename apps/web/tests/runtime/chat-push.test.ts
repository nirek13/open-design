import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncChatPushSubscription } from '../../src/runtime/chat-push';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('syncChatPushSubscription', () => {
  it('does not prompt or subscribe when permission is not granted', async () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncChatPushSubscription()).resolves.toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
