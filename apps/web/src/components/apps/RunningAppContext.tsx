// Fullscreen interactive app instance — shared across the Apps gallery,
// pinned sidebar shortcuts, and deploy-from-project. Opening an app always
// loads the HTML in AppRunner; it never jumps into the build conversation.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { OrgApp } from '@open-design/contracts';
import { fetchProjectFileText } from '../../providers/registry';
import { navigate } from '../../router';
import { AppRunner } from './AppRunner';
import styles from './RunningAppOverlay.module.css';

export const APP_EDIT_FOCUS_STORAGE_KEY = 'od:app-edit-focus';

interface RunningApp {
  orgId: string;
  app: OrgApp;
  source: string;
}

interface RunningAppContextValue {
  /** Load the app HTML and open the fullscreen interactive runner. */
  openApp: (orgId: string, app: OrgApp) => Promise<void>;
  closeApp: () => void;
  running: RunningApp | null;
  openError: string | null;
  clearOpenError: () => void;
  /**
   * When true, the overlay leaves room for the entry nav rail so the
   * sidebar stays visible and clickable while the app runs.
   */
  sidebarVisible: boolean;
  setSidebarVisible: (visible: boolean) => void;
}

const RunningAppContext = createContext<RunningAppContextValue | null>(null);

export function useRunningApp(): RunningAppContextValue {
  const value = useContext(RunningAppContext);
  if (!value) {
    throw new Error('useRunningApp must be used within RunningAppProvider');
  }
  return value;
}

/** Safe for surfaces that may render outside the provider (tests, early boot). */
export function useOptionalRunningApp(): RunningAppContextValue | null {
  return useContext(RunningAppContext);
}

export function markAppEditWorkspaceFocus(): void {
  try {
    sessionStorage.setItem(APP_EDIT_FOCUS_STORAGE_KEY, '1');
  } catch {
    // sessionStorage may be unavailable; ProjectView still opens normally.
  }
}

export function consumeAppEditWorkspaceFocus(): boolean {
  try {
    if (sessionStorage.getItem(APP_EDIT_FOCUS_STORAGE_KEY) === '1') {
      sessionStorage.removeItem(APP_EDIT_FOCUS_STORAGE_KEY);
      return true;
    }
  } catch {
    // Ignore.
  }
  return false;
}

export function RunningAppProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState<RunningApp | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);

  const closeApp = useCallback(() => {
    setRunning(null);
    setSidebarVisible(false);
  }, []);

  const openApp = useCallback(async (orgId: string, app: OrgApp) => {
    setOpenError(null);
    try {
      const source = await fetchProjectFileText(app.projectId, app.filePath);
      if (source === null) {
        throw new Error(`could not read ${app.filePath}`);
      }
      setRunning({ orgId, app, source });
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const editApp = useCallback(() => {
    if (!running) return;
    markAppEditWorkspaceFocus();
    const { app } = running;
    setRunning(null);
    setSidebarVisible(false);
    navigate({
      kind: 'project',
      projectId: app.projectId,
      conversationId: null,
      fileName: app.filePath,
    });
  }, [running]);

  const value = useMemo<RunningAppContextValue>(
    () => ({
      openApp,
      closeApp,
      running,
      openError,
      clearOpenError: () => setOpenError(null),
      sidebarVisible,
      setSidebarVisible,
    }),
    [closeApp, openApp, openError, running, sidebarVisible],
  );

  return (
    <RunningAppContext.Provider value={value}>
      {children}
      {running ? (
        <div
          className={`${styles.overlay}${sidebarVisible ? ` ${styles.overlayWithSidebar}` : ''}`}
          data-testid="running-app-overlay"
          data-sidebar={sidebarVisible ? 'visible' : 'hidden'}
        >
          <AppRunner
            orgId={running.orgId}
            app={running.app}
            source={running.source}
            onClose={closeApp}
            onEdit={editApp}
          />
        </div>
      ) : null}
    </RunningAppContext.Provider>
  );
}
