// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const signInProps: Record<string, unknown>[] = [];
let signedIn = false;
let authLoaded = true;
const getToken = vi.fn(async () => 'session-token');

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="clerk-provider">{children}</div>
  ),
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
    getToken.mockClear();
    setSessionTokenProvider(null);
  });

  afterEach(() => {
    cleanup();
    setSessionTokenProvider(null);
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
    expect(screen.getByText('Sign in to Open Design')).toBeInTheDocument();
    expect(screen.getByText('Sign in or create a new account to continue.')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();
    expect(signInProps[0]).toMatchObject({
      routing: 'virtual',
      withSignUp: true,
      oauthFlow: 'auto',
    });
    expect(signInProps[0]?.fallback).toBeTruthy();
    expect(typeof signInProps[0]?.fallbackRedirectUrl).toBe('string');
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
  });
});
