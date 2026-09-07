// Sign-in, when the daemon asks for it.
//
// The daemon decides whether identity is real: `/api/auth/context` reports
// `clerk` (a verified session required — the default) or `local-owner` (this
// machine's owner, no sign-in, only when the daemon opted in). The browser
// does not get a vote — it reads the mode and renders accordingly, so a
// tampered client cannot talk its way past the gate; the daemon rejects
// unauthenticated API calls regardless of what the UI decided to show.
//
// In clerk mode nothing inside the app renders until a session exists, which
// is why this sits above the org provider: "which organization am I in" has
// no meaning before "who am I".
//
// The Clerk SDK itself is behind a lazy boundary (./ClerkSession). A
// local-owner install never loads it, and if it fails to load this shows a
// message rather than leaving the app stuck on its loading shell.

import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import type { AuthContextResponse } from '@open-design/contracts';
import { fetchAuthContext } from '../providers/registry';
import styles from './AuthGate.module.css';

const ClerkSession = lazy(() => import('./ClerkSession'));

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.body}>{children}</p>
      </div>
    </div>
  );
}

/** A failed sign-in SDK must not present as a hung app. */
class SignInBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <Notice title="Sign-in could not load">
          The authentication provider failed to load. Check your network connection and reload; if
          it persists, verify <code>OD_CLERK_PUBLISHABLE_KEY</code> is the key for{' '}
          <code>OD_CLERK_ISSUER</code>.
        </Notice>
      );
    }
    return <>{this.props.children}</>;
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<AuthContextResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchAuthContext();
        if (!cancelled) setContext(next);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The daemon is unreachable. Rendering the app would only produce a wall of
  // failed requests, and rendering a sign-in screen would be a guess.
  if (failed) {
    return (
      <Notice title="Cannot reach Plyxl">
        The daemon is not responding. Start it with <code>pnpm tools-dev start web</code> and
        reload.
      </Notice>
    );
  }

  if (!context) return <div className={styles.loading}>Loading…</div>;

  // Local-owner is an explicit daemon opt-in. Nothing to sign in to, and the
  // Clerk SDK is never loaded.
  if (context.mode !== 'clerk') return <>{children}</>;

  if (!context.publishableKey) {
    return (
      <Notice title="Sign-in is not finished being set up">
        The daemon requires sign-in but no Clerk publishable key was configured. Set{' '}
        <code>OD_CLERK_PUBLISHABLE_KEY</code> alongside <code>OD_CLERK_ISSUER</code> and restart.
      </Notice>
    );
  }

  return (
    <SignInBoundary>
      <Suspense fallback={<div className={styles.loading}>Loading…</div>}>
        <ClerkSession appOrigin={context.appOrigin} publishableKey={context.publishableKey}>
          {children}
        </ClerkSession>
      </Suspense>
    </SignInBoundary>
  );
}
