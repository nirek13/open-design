// Organization context: which organization the app is currently acting in.
//
// Every org-scoped request sends the active organization as a header, so this
// provider is the single place that decides what "here" means. Switching
// organizations changes what projects, apps, tables, and members the whole
// app shows, so the switch is deliberately a full reload of org-scoped state
// rather than a partial refresh.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthContextResponse, OrganizationMembershipView, OrgRole } from '@open-design/contracts';
import { fetchAuthContext, createOrganization as createOrganizationRequest } from '../providers/registry';

const ACTIVE_ORG_STORAGE_KEY = 'open-design:active-org:v1';

export interface OrgContextValue {
  loading: boolean;
  /** How the daemon authenticates callers, and who it thinks we are. */
  auth: AuthContextResponse | null;
  organizations: OrganizationMembershipView[];
  activeOrg: OrganizationMembershipView | null;
  activeOrgId: string | null;
  /** The signed-in person's role in the active organization. */
  role: OrgRole | null;
  /** True when the caller may perform an action needing at least `minimum`. */
  can: (minimum: OrgRole) => boolean;
  setActiveOrg: (orgId: string) => void;
  createOrganization: (name: string) => Promise<OrganizationMembershipView | null>;
  refresh: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

const ROLE_ORDER: OrgRole[] = ['member', 'admin', 'owner'];

function readStoredOrgId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeOrgId(orgId: string | null): void {
  try {
    if (orgId) window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    else window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    // Private browsing or a full quota should never break org switching.
  }
}

/** Read by the fetch helpers so every org-scoped call agrees with the UI. */
let currentOrgId: string | null = readStoredOrgId();

export function activeOrgIdForRequests(): string | null {
  return currentOrgId;
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState<AuthContextResponse | null>(null);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(() => readStoredOrgId());

  const organizations = auth?.organizations ?? [];

  const load = useCallback(async () => {
    try {
      const context = await fetchAuthContext();
      setAuth(context);
      setActiveOrgIdState((current) => {
        // Keep the stored choice only while it is still one of ours —
        // otherwise a removed member would stay pinned to an org they can no
        // longer read, and every request would 403.
        const stillAMember = current && context.organizations.some((org) => org.id === current);
        const next = stillAMember ? current : (context.organizations[0]?.id ?? null);
        currentOrgId = next;
        storeOrgId(next);
        return next;
      });
    } catch {
      setAuth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setActiveOrg = useCallback((orgId: string) => {
    currentOrgId = orgId;
    storeOrgId(orgId);
    setActiveOrgIdState(orgId);
    // Org-scoped state lives all over the app (projects, apps, tables, the
    // open project tabs). Rather than thread invalidation through every one
    // of them, switching organizations reloads — it is a rare, deliberate
    // action and a clean slate is the honest result.
    window.location.assign('/');
  }, []);

  const createOrganization = useCallback(
    async (name: string) => {
      const created = await createOrganizationRequest(name);
      if (!created) return null;
      currentOrgId = created.id;
      storeOrgId(created.id);
      setActiveOrgIdState(created.id);
      // Re-read rather than synthesizing the membership view, so the row we
      // hand back is the same one the server will keep returning.
      const context = await fetchAuthContext();
      setAuth(context);
      return context.organizations.find((org) => org.id === created.id) ?? null;
    },
    [load],
  );

  const value = useMemo<OrgContextValue>(() => {
    const activeOrg = organizations.find((org) => org.id === activeOrgId) ?? null;
    const role = activeOrg?.role ?? null;
    return {
      loading,
      auth,
      organizations,
      activeOrg,
      activeOrgId,
      role,
      can: (minimum: OrgRole) =>
        role !== null && ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum),
      setActiveOrg,
      createOrganization,
      refresh: load,
    };
  }, [loading, auth, organizations, activeOrgId, setActiveOrg, createOrganization, load]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) {
    throw new Error('useOrg must be used inside an OrgProvider');
  }
  return value;
}
