import { describe, expect, it } from 'vitest';
import { isPushEndpoint, parsePushSubscriptionJSON } from '../src/api/push.js';

describe('parsePushSubscriptionJSON', () => {
  it('accepts a browser PushSubscription.toJSON() shape', () => {
    expect(
      parsePushSubscriptionJSON({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        expirationTime: null,
        keys: { p256dh: 'p256', auth: 'auth' },
      }),
    ).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
      keys: { p256dh: 'p256', auth: 'auth' },
    });
  });

  it('rejects javascript URLs and missing keys', () => {
    expect(parsePushSubscriptionJSON({ endpoint: 'javascript:alert(1)', keys: { p256dh: 'a', auth: 'b' } })).toBeNull();
    expect(parsePushSubscriptionJSON({ endpoint: 'https://push.example/x', keys: { p256dh: 'a' } })).toBeNull();
  });
});

describe('isPushEndpoint', () => {
  it('allows https push services and localhost http', () => {
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/xxx')).toBe(true);
    expect(isPushEndpoint('http://localhost:8443/push')).toBe(true);
    expect(isPushEndpoint('http://evil.example/push')).toBe(false);
  });
});
