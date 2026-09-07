// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  clerkHttpOrigin,
  clerkRedirectUrl,
  isHttpLocation,
  locationForClerkRedirect,
  stayOnPackagedApp,
} from '../../src/auth/clerk-redirect-url';

describe('clerkRedirectUrl', () => {
  it('keeps a relative path on http(s) pages', () => {
    expect(
      clerkRedirectUrl({ protocol: 'https:', pathname: '/onboarding', search: '?x=1' }),
    ).toBe('/onboarding?x=1');
    expect(isHttpLocation({ protocol: 'http:' })).toBe(true);
  });

  it('maps packaged od:// windows onto the sidecar HTTP origin', () => {
    expect(
      clerkRedirectUrl(
        { protocol: 'od:', pathname: '/', search: '' },
        'http://127.0.0.1:56831/',
      ),
    ).toBe('http://127.0.0.1:56831/');
    expect(
      clerkRedirectUrl(
        { protocol: 'od:', pathname: '/join/abc', search: '' },
        'http://127.0.0.1:56831',
      ),
    ).toBe('http://127.0.0.1:56831/join/abc');
  });

  it('falls back to loopback http when no app origin is known', () => {
    expect(clerkRedirectUrl({ protocol: 'od:', pathname: '/', search: '' })).toBe('http://127.0.0.1/');
    expect(clerkHttpOrigin('od://app')).toBeNull();
    expect(clerkHttpOrigin('not a url')).toBeNull();
  });

  it('strips Clerk handshake params and prefers a pending join path', () => {
    expect(
      locationForClerkRedirect({
        protocol: 'http:',
        pathname: '/',
        search: '?__clerk_handshake=abc&x=1',
      }),
    ).toEqual({ protocol: 'http:', pathname: '/', search: '?x=1' });
    expect(
      clerkRedirectUrl(
        { protocol: 'http:', pathname: '/', search: '?__clerk_handshake=abc' },
        undefined,
        '/join/tok-abc',
      ),
    ).toBe('/join/tok-abc');
  });
});

describe('stayOnPackagedApp', () => {
  it('rewrites http Clerk targets back onto the od:// path', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    stayOnPackagedApp('http://127.0.0.1:17573/onboarding?x=1', {
      protocol: 'od:',
      href: 'od://app/',
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/onboarding?x=1');
    replaceState.mockRestore();
  });
});
