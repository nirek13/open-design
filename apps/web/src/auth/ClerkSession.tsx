// Everything that touches the Clerk SDK, isolated in one module.
//
// This file is imported lazily and only when the daemon reports clerk mode,
// for two reasons. A local-owner install should never download or parse an
// authentication SDK it will not use. And more importantly, the SDK loading
// must not be able to take the app down: it sits behind a lazy boundary with
// a fallback, so a failure here shows a message instead of an app that hangs
// forever on its loading shell.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AuthenticateWithRedirectCallback,
  ClerkProvider,
  SignIn,
  SignedIn,
  SignedOut,
  useAuth,
  useClerk,
} from '@clerk/clerk-react';
import { useT } from '../i18n';
import { AuthActionsProvider } from './AuthActions';
import { installSessionFetch, setSessionTokenProvider } from './session';
import styles from './AuthGate.module.css';

/** Clerk's hosted UI, tinted to match the product chrome. */
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#c96442',
    colorBackground: '#fdfcfa',
    colorText: '#1a1916',
    colorTextSecondary: '#74716b',
    colorInputBackground: '#fdfcfa',
    colorInputText: '#1a1916',
    borderRadius: '0.5rem',
    fontFamily: 'inherit',
  },
};

/** True when Clerk sent the browser back here after an OAuth/SSO redirect.
 *
 * The prebuilt `<SignIn />` is the wrong component for that moment — the
 * handshake has to finish first or the session never becomes active. */
export function isClerkOAuthReturn(search: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  return (
    params.has('__clerk_handshake') ||
    params.has('__clerk_created_session') ||
    params.has('rotating_token_nonce')
  );
}

function stayOnThisPage(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}` || '/';
}

/** Registers Clerk's token getter with the fetch wrapper. Must render inside
 * ClerkProvider — that is the only place `useAuth` is valid. */
function SessionBridge({ children }: { children: ReactNode }) {
  const { getToken, isLoaded } = useAuth();
  const { signOut } = useClerk();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    installSessionFetch();
    setSessionTokenProvider(() => getToken());
    setReady(true);
    return () => setSessionTokenProvider(null);
  }, [getToken]);

  // Holding the first render until the token provider is registered avoids a
  // burst of 401s from components that fetch the moment they mount.
  if (!isLoaded || !ready) return <div className={styles.loading}>Loading…</div>;
  return (
    <AuthActionsProvider
      signOut={async () => {
        await signOut({ redirectUrl: '/' });
      }}
    >
      {children}
    </AuthActionsProvider>
  );
}

function SignInScreen() {
  const t = useT();
  const redirect = useMemo(() => stayOnThisPage(), []);
  const oauthReturn = typeof window !== 'undefined' && isClerkOAuthReturn(window.location.search);

  if (oauthReturn) {
    return (
      <div className={styles.loading} data-testid="clerk-sso-callback">
        Signing in…
        <AuthenticateWithRedirectCallback />
      </div>
    );
  }

  return (
    <div className={styles.screen} data-testid="clerk-sign-in">
      <div className={styles.signIn}>
        <div className={styles.signInIntro}>
          <h1 className={styles.title}>{t('account.signInTitle')}</h1>
          <p className={styles.body}>{t('account.signInLead')}</p>
        </div>
        <SignIn
          routing="virtual"
          withSignUp
          oauthFlow="auto"
          fallbackRedirectUrl={redirect}
          signUpFallbackRedirectUrl={redirect}
          fallback={<p className={styles.body}>Loading sign-in…</p>}
        />
      </div>
    </div>
  );
}

export default function ClerkSession({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={CLERK_APPEARANCE} afterSignOutUrl="/">
      <SignedOut>
        <SignInScreen />
      </SignedOut>
      <SignedIn>
        <SessionBridge>{children}</SessionBridge>
      </SignedIn>
    </ClerkProvider>
  );
}
