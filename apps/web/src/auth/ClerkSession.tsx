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
import {
  clerkRedirectUrl,
  isHttpLocation,
  stayOnPackagedApp,
} from './clerk-redirect-url';
import { installSessionFetch, plantSessionCookie, setSessionTokenProvider } from './session';
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

function stayOnThisPage(appOrigin?: string): string {
  if (typeof window === 'undefined') return '/';
  return clerkRedirectUrl(window.location, appOrigin);
}

/** Registers Clerk's token getter with the fetch wrapper. Must render inside
 * ClerkProvider — that is the only place `useAuth` is valid. */
function SessionBridge({
  children,
  redirectUrl,
}: {
  children: ReactNode;
  redirectUrl: string;
}) {
  const { getToken, isLoaded } = useAuth();
  const { signOut } = useClerk();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    installSessionFetch();
    setSessionTokenProvider(() => getToken());
    let cancelled = false;
    void getToken()
      .then((token) => {
        if (!cancelled) plantSessionCookie(token);
      })
      .catch(() => {
        // A token we cannot mint is the same as no token: render the app and
        // let API calls 401 rather than hang the shell on Clerk.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    // Clerk session JWTs expire in about a minute. Refresh the cookie so an
    // idle preview iframe can still authenticate on reload.
    const refresh = window.setInterval(() => {
      void getToken()
        .then((token) => {
          if (!cancelled && token) plantSessionCookie(token);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
      setSessionTokenProvider(null);
      plantSessionCookie(null);
    };
  }, [getToken]);

  // Holding the first render until the token provider is registered avoids a
  // burst of 401s from components that fetch the moment they mount.
  if (!isLoaded || !ready) return <div className={styles.loading}>Loading…</div>;
  return (
    <AuthActionsProvider
      signOut={async () => {
        plantSessionCookie(null);
        await signOut({ redirectUrl });
      }}
    >
      {children}
    </AuthActionsProvider>
  );
}

function SignInScreen({
  oauthFlow,
  redirect,
}: {
  oauthFlow: 'auto' | 'popup';
  redirect: string;
}) {
  const t = useT();
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
          oauthFlow={oauthFlow}
          fallbackRedirectUrl={redirect}
          signUpFallbackRedirectUrl={redirect}
          fallback={<p className={styles.body}>Loading sign-in…</p>}
        />
      </div>
    </div>
  );
}

export default function ClerkSession({
  appOrigin,
  publishableKey,
  children,
}: {
  appOrigin?: string;
  publishableKey: string;
  children: ReactNode;
}) {
  const customScheme = typeof window !== 'undefined' && !isHttpLocation(window.location);
  const redirect = useMemo(() => stayOnThisPage(appOrigin), [appOrigin]);
  const session = (
    <>
      <SignedOut>
        <SignInScreen oauthFlow={customScheme ? 'popup' : 'auto'} redirect={redirect} />
      </SignedOut>
      <SignedIn>
        <SessionBridge redirectUrl={redirect}>{children}</SessionBridge>
      </SignedIn>
    </>
  );

  if (customScheme) {
    const navigate = (to: string) => stayOnPackagedApp(to, window.location);
    return (
      <ClerkProvider
        publishableKey={publishableKey}
        appearance={CLERK_APPEARANCE}
        afterSignOutUrl={redirect}
        signInFallbackRedirectUrl={redirect}
        signUpFallbackRedirectUrl={redirect}
        allowedRedirectProtocols={['http', 'https', 'od']}
        routerPush={navigate}
        routerReplace={navigate}
      >
        {session}
      </ClerkProvider>
    );
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={CLERK_APPEARANCE}
      afterSignOutUrl={redirect}
      signInFallbackRedirectUrl={redirect}
      signUpFallbackRedirectUrl={redirect}
    >
      {session}
    </ClerkProvider>
  );
}
