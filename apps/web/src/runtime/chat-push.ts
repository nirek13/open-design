import { useEffect } from 'react';
import { useOptionalOrg } from '../org/OrgContext';
import {
  fetchPushStatus,
  registerPushSubscription,
  unregisterPushSubscription,
} from '../providers/registry';
import {
  ensureNotificationServiceWorker,
  notificationPermission,
  requestNotificationPermission,
} from '../utils/notifications';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Whether a subscription the browser is already holding was minted against
 * the key the daemon signs with today.
 *
 * A subscription outlives the daemon's VAPID keys: regenerate `vapid.json`,
 * move to a new data directory, or set `OD_VAPID_*` for the first time, and
 * the browser keeps handing back a subscription the daemon can no longer
 * sign for. Every send then fails with a 403 that looks, from the user's
 * side, exactly like notifications quietly not working.
 */
function matchesServerKey(
  subscription: PushSubscription,
  publicKey: string,
): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const actual = new Uint8Array(current);
  const expected = urlBase64ToUint8Array(publicKey);
  if (actual.length !== expected.length) return false;
  return actual.every((byte, index) => byte === expected[index]);
}

export async function syncChatPushSubscription(): Promise<'subscribed' | 'skipped' | 'denied'> {
  if (typeof window === 'undefined') return 'skipped';
  if (notificationPermission() !== 'granted') return 'skipped';
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) return 'skipped';
  try {
    const status = await fetchPushStatus();
    if (!status.enabled || !status.publicKey) return 'skipped';
    const registration = await ensureNotificationServiceWorker();
    if (!registration?.pushManager) return 'skipped';
    let existing = await registration.pushManager.getSubscription();
    if (existing && !matchesServerKey(existing, status.publicKey)) {
      // Retire the stale endpoint on both sides before re-subscribing, so the
      // daemon stops sending to an address it can no longer sign for.
      const staleEndpoint = existing.endpoint;
      await existing.unsubscribe().catch(() => false);
      await unregisterPushSubscription(staleEndpoint).catch(() => {});
      existing = null;
    }
    const subscription =
      existing
      ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey) as BufferSource,
      });
    await registerPushSubscription(subscription.toJSON(), navigator.userAgent);
    return 'subscribed';
  } catch {
    return 'skipped';
  }
}

export async function enableChatPush(): Promise<NotificationPermission | 'unsupported'> {
  const permission = await requestNotificationPermission();
  if (permission === 'granted') {
    await syncChatPushSubscription();
  }
  return permission;
}

/** Re-register the current browser whenever the signed-in user is known and
 * the browser already granted notifications. Does not prompt. */
export function ChatPushSync() {
  const org = useOptionalOrg();
  const viewerId = org?.auth?.viewer?.userId ?? null;
  useEffect(() => {
    if (!viewerId) return;
    void syncChatPushSubscription();
  }, [viewerId]);
  return null;
}
