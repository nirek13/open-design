// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const signInProps: Record<string, unknown>[] = [];
const clerkProviderProps: Record<string, unknown>[] = [];
let signedIn = false;
let authLoaded = true;
const getToken = vi.fn(async () => 'session-token');

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: (props: Record<string, unknown> & { children: ReactNode }) => {
    clerkProviderProps.push(props);
    return <div data-testid="clerk-provider">{props.children}</div>;
  },
  SignedOut: ({ children }: { children: ReactNode }) => (signedIn ? null : <>{children}</>),
  SignedIn: ({ children }: { children: ReactNode }) => (signedIn ? <>{children}</> : null),
  SignIn: (props: Record<string, unknown>) => {
    signInProps.push(props);
    return <div data-testid="clerk-sign-in-widget" />;
  },
  AuthenticateWithRedirectCallback: () => <div data-testid="clerk-sso-widget" />,
  useAuth: () => ({ getToken, isLoaded: authLoaded }),
  useClerk: () => ({ signOut: vi.fn(async () => {}) }),
}));

import ClerkSession, { isClerkOAuthReturn } from '../../src/auth/ClerkSession';
import { setSessionTokenProvider } from '../../src/auth/session';
import { I18nProvider } from '../../src/i18n';

describe('isClerkOAuthReturn', () => {
  it('recognises the handshake Clerk appends after an OAuth redirect', () => {
    expect(isClerkOAuthReturn('?__clerk_handshake=abc')).toBe(true);
    expect(isClerkOAuthReturn('__clerk_created_session=1')).toBe(true);
    expect(isClerkOAuthReturn('?rotating_token_nonce=n')).toBe(true);
    expect(isClerkOAuthReturn('')).toBe(false);
    expect(isClerkOAuthReturn('?foo=bar')).toBe(false);
  });
});

describe('ClerkSession', () => {
  beforeEach(() => {
    signedIn = false;
    authLoaded = true;
    signInProps.length = 0;
    clerkProviderProps.length = 0;
    getToken.mockClear();
    setSessionTokenProvider(null);
    document.cookie = 'od_session=; Path=/; Max-Age=0; SameSite=Lax';
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ valid: true, orgName: 'Northwind', role: 'member' }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    setSessionTokenProvider(null);
    document.cookie = 'od_session=; Path=/; Max-Age=0; SameSite=Lax';
    sessionStorage.clear();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('shows a sign-in-or-up card that stays on this page after success', () => {
    render(
      <I18nProvider initial="en">
        <ClerkSession publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(screen.getByTestId('clerk-sign-in')).toBeInTheDocument();
    expect(screen.getByTestId('clerk-sign-in-widget')).toBeInTheDocument();
    expect(screen.getByText('Plyxl')).toBeInTheDocument();
    expect(screen.getByText('The Future Of Work')).toBeInTheDocument();
    expect(screen.getByText('Sign in or create a new account to continue.')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();
    expect(signInProps[0]).toMatchObject({
      routing: 'virtual',
      withSignUp: true,
      oauthFlow: 'auto',
    });
    expect(signInProps[0]?.fallback).toBeTruthy();
    expect(typeof signInProps[0]?.fallbackRedirectUrl).toBe('string');
    expect(typeof signInProps[0]?.forceRedirectUrl).toBe('string');
  });

  it('forces Clerk back onto a /join link after sign-in', async () => {
    window.history.replaceState({}, '', '/join/tok-abc');
    render(
      <I18nProvider initial="en">
        <ClerkSession publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(signInProps[0]).toMatchObject({
      forceRedirectUrl: '/join/tok-abc',
      fallbackRedirectUrl: '/join/tok-abc',
    });
    expect(clerkProviderProps[0]).toMatchObject({
      signInForceRedirectUrl: '/join/tok-abc',
      signUpForceRedirectUrl: '/join/tok-abc',
    });
    expect(await screen.findByTestId('clerk-join-eyebrow')).toBeInTheDocument();
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
  });

  it('returns a signed-in visitor to a pending invite instead of dumping them on /', async () => {
    signedIn = true;
    window.history.replaceState({}, '', '/');
    sessionStorage.setItem('open-design:pending-invite:v1', 'tok-abc');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    render(
      <I18nProvider initial="en">
        <ClerkSession publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), '', '/join/tok-abc');
    replaceState.mockRestore();
    sessionStorage.removeItem('open-design:pending-invite:v1');
    window.history.replaceState({}, '', '/');
  });

  it('finishes an OAuth redirect instead of re-showing the form', () => {
    const previous = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, '', '/?__clerk_handshake=tok');
    render(
      <I18nProvider initial="en">
        <ClerkSession publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(screen.getByTestId('clerk-sso-callback')).toBeInTheDocument();
    expect(screen.getByTestId('clerk-sso-widget')).toBeInTheDocument();
    expect(screen.queryByTestId('clerk-sign-in-widget')).toBeNull();
    window.history.replaceState({}, '', previous || '/');
  });

  it('renders the app and registers a token provider once signed in', async () => {
    signedIn = true;
    render(
      <I18nProvider initial="en">
        <ClerkSession publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(screen.queryByTestId('clerk-sign-in')).toBeNull();
    expect(document.cookie).toContain('od_session=session-token');
  });

  it('maps packaged od:// windows onto an http Clerk redirect and stays in-app', () => {
    const href = 'od://app/';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        protocol: 'od:',
        pathname: '/',
        search: '',
        href,
        origin: 'od://app',
      },
    });
    render(
      <I18nProvider initial="en">
        <ClerkSession appOrigin="http://127.0.0.1:17573" publishableKey="pk_test_x">
          <div data-testid="app">app</div>
        </ClerkSession>
      </I18nProvider>,
    );
    expect(signInProps[0]).toMatchObject({
      oauthFlow: 'popup',
      fallbackRedirectUrl: 'http://127.0.0.1:17573/',
    });
    expect(clerkProviderProps[0]).toMatchObject({
      allowedRedirectProtocols: ['http', 'https', 'od'],
      signInFallbackRedirectUrl: 'http://127.0.0.1:17573/',
      signInForceRedirectUrl: 'http://127.0.0.1:17573/',
    });
    expect(typeof clerkProviderProps[0]?.routerPush).toBe('function');
    expect(typeof clerkProviderProps[0]?.routerReplace).toBe('function');
  });
});
