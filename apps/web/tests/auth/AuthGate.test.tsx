// @vitest-environment jsdom

// The gate is the first thing a person sees. These cases pin the three
// readings it must never mix up: a keyless local daemon (pass through), a
// clerk deployment with no session (show sign-in), and a daemon that is
// simply not there (a reachability message, not a hung spinner).

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from '../../src/auth/AuthGate';
import * as registry from '../../src/providers/registry';

vi.mock('../../src/auth/ClerkSession', () => ({
  default: ({ publishableKey, children }: { publishableKey: string; children: React.ReactNode }) => (
    <div data-testid="clerk-session" data-pk={publishableKey}>
      {children}
    </div>
  ),
}));

const LOCAL = {
  mode: 'local-owner' as const,
  viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null },
  organizations: [],
};

describe('AuthGate', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lets a keyless local daemon through without loading Clerk', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue(LOCAL);
    render(
      <AuthGate>
        <div data-testid="app">app</div>
      </AuthGate>,
    );
    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(screen.queryByTestId('clerk-session')).toBeNull();
    expect(screen.queryByTestId('clerk-sign-in')).toBeNull();
  });

  it('mounts Clerk when the daemon requires a real session', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: null,
      organizations: [],
    });
    render(
      <AuthGate>
        <div data-testid="app">app</div>
      </AuthGate>,
    );
    const session = await screen.findByTestId('clerk-session');
    expect(session).toHaveAttribute('data-pk', 'pk_test_x');
  });

  it('refuses to start Clerk without a publishable key', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'clerk',
      viewer: null,
      organizations: [],
    });
    render(
      <AuthGate>
        <div data-testid="app">app</div>
      </AuthGate>,
    );
    expect(await screen.findByText(/sign-in is not finished being set up/i)).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();
    expect(screen.queryByTestId('clerk-session')).toBeNull();
  });

  it('explains a missing daemon instead of spinning forever', async () => {
    vi.spyOn(registry, 'fetchAuthContext').mockRejectedValue(new Error('ECONNREFUSED'));
    render(
      <AuthGate>
        <div data-testid="app">app</div>
      </AuthGate>,
    );
    expect(await screen.findByText(/cannot reach open design/i)).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('shows a loading shell until the daemon answers', () => {
    vi.spyOn(registry, 'fetchAuthContext').mockReturnValue(new Promise(() => {}));
    render(
      <AuthGate>
        <div data-testid="app">app</div>
      </AuthGate>,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTestId('app')).toBeNull();
  });
});
