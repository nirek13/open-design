// Web Push subscriptions for team chat (and later, anything else that should
// reach a closed laptop). The daemon stores one row per browser endpoint,
// keyed by the signed-in user — not by organization — so a single permission
// grant covers every org the person belongs to.

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** Wire shape of `PushSubscription.toJSON()` from the browser. */
export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
}

export interface RegisterPushSubscriptionRequest {
  subscription: PushSubscriptionJSON;
  userAgent?: string;
}

export interface RegisterPushSubscriptionResponse {
  id: string;
}

export interface UnregisterPushSubscriptionRequest {
  endpoint: string;
}

export interface PushStatusResponse {
  /** False when VAPID keys could not be loaded or generated. */
  enabled: boolean;
  /** Application server key for `PushManager.subscribe`. Null when disabled. */
  publicKey: string | null;
  /** How many browsers this user currently has registered. */
  subscriptionCount: number;
}

export interface PushTestRequest {
  title?: string;
  body?: string;
}

export interface ChatPushPayload {
  type: 'team-chat';
  title: string;
  body: string;
  /** Path or absolute URL the service worker opens on click. */
  url: string;
  tag: string;
  orgId: string;
  channelSlug: string;
  messageId: string;
}

const HTTPS_ENDPOINT = /^https:\/\//i;
const LOCAL_HTTP_ENDPOINT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i;

export function isPushEndpoint(value: string): boolean {
  if (HTTPS_ENDPOINT.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && parsed.pathname.length > 0;
    } catch {
      return false;
    }
  }
  return LOCAL_HTTP_ENDPOINT.test(value);
}

export function parsePushSubscriptionJSON(raw: unknown): PushSubscriptionJSON | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const endpoint = typeof rec.endpoint === 'string' ? rec.endpoint.trim() : '';
  if (!endpoint || !isPushEndpoint(endpoint) || endpoint.length > 2048) return null;
  const keysRaw = rec.keys;
  if (!keysRaw || typeof keysRaw !== 'object' || Array.isArray(keysRaw)) return null;
  const keysRec = keysRaw as Record<string, unknown>;
  const p256dh = typeof keysRec.p256dh === 'string' ? keysRec.p256dh.trim() : '';
  const auth = typeof keysRec.auth === 'string' ? keysRec.auth.trim() : '';
  if (!p256dh || !auth || p256dh.length > 256 || auth.length > 256) return null;
  const expirationTime =
    rec.expirationTime === null || rec.expirationTime === undefined
      ? null
      : typeof rec.expirationTime === 'number' && Number.isFinite(rec.expirationTime)
        ? rec.expirationTime
        : null;
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}
