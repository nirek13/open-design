// Sign-out is a Clerk SDK call, but the account menu lives in product chrome
// that also renders in local-owner mode (where Clerk is never loaded). This
// context is the seam: SessionBridge fills it in when a real session exists;
// everywhere else `signOut` is null and the menu hides that action.

import { createContext, useContext, type ReactNode } from 'react';

export interface AuthActions {
  signOut: (() => Promise<void>) | null;
}

const AuthActionsContext = createContext<AuthActions>({ signOut: null });

export function AuthActionsProvider({
  signOut,
  children,
}: {
  signOut: (() => Promise<void>) | null;
  children: ReactNode;
}) {
  return <AuthActionsContext.Provider value={{ signOut }}>{children}</AuthActionsContext.Provider>;
}

export function useAuthActions(): AuthActions {
  return useContext(AuthActionsContext);
}
