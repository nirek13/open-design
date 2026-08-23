// @vitest-environment jsdom

// The fetch wrapper is a security boundary: a session token must ride along
// to same-origin /api calls, and must never ride along anywhere else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('shouldAttachSessionToken', () => {
  it('attaches only to same-origin /api paths', async () => {
    const { shouldAttachSessionToken } = await import('../../src/auth/session');
    const origin = 'http://localhost:17573/app';
    expect(shouldAttachSessionToken('/api/orgs', origin)).toBe(true);
    expect(shouldAttachSessionToken('http://localhost:17573/api/auth/context', origin)).toBe(true);
    expect(shouldAttachSessionToken('/api/', origin)).toBe(true);
  });

  it('refuses third-party hosts, non-API paths, and malformed URLs', async () => {
    const { shouldAttachSessionToken } = await import('../../src/auth/session');
    const origin = 'http://localhost:17573/';
    expect(shouldAttachSessionToken('https://evil.example/api/orgs', origin)).toBe(false);
    expect(shouldAttachSessionToken('/index.html', origin)).toBe(false);
    expect(shouldAttachSessionToken('/artifacts/x', origin)).toBe(false);
    expect(shouldAttachSessionToken('http://127.0.0.1:17573/api/orgs', origin)).toBe(false);
    expect(shouldAttachSessionToken('::not-a-url::', origin)).toBe(false);
  });
});

function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit | undefined {
  const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
  return calls.at(-1)?.[1];
}

describe('installSessionFetch', () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    vi.resetModules();
    window.fetch = originalFetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('adds a Bearer token to same-origin API calls and leaves others alone', async () => {
    const { installSessionFetch, setSessionTokenProvider } = await import('../../src/auth/session');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    window.fetch = fetchMock as unknown as typeof fetch;

    installSessionFetch();
    setSessionTokenProvider(async () => 'jwt-1');

    await window.fetch('/api/orgs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(lastInit(fetchMock)?.headers).get('authorization')).toBe('Bearer jwt-1');

    fetchMock.mockClear();
    await window.fetch('https://clerk.example/v1/client');
    expect(lastInit(fetchMock)).toBeUndefined();

    fetchMock.mockClear();
    await window.fetch('/home');
    expect(lastInit(fetchMock)).toBeUndefined();
  });

  it('does not overwrite an Authorization header the caller already set', async () => {
    const { installSessionFetch, setSessionTokenProvider } = await import('../../src/auth/session');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    window.fetch = fetchMock as unknown as typeof fetch;

    installSessionFetch();
    setSessionTokenProvider(async () => 'jwt-1');

    await window.fetch('/api/orgs', { headers: { authorization: 'Bearer explicit' } });
    expect(new Headers(lastInit(fetchMock)?.headers).get('authorization')).toBe('Bearer explicit');
  });

  it('sends the request without a token when minting one fails', async () => {
    const { installSessionFetch, setSessionTokenProvider } = await import('../../src/auth/session');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    window.fetch = fetchMock as unknown as typeof fetch;

    installSessionFetch();
    setSessionTokenProvider(async () => {
      throw new Error('clerk offline');
    });

    await window.fetch('/api/orgs');
    expect(lastInit(fetchMock)).toBeUndefined();
  });
});
