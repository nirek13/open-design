// Who am I, and how do I leave?
//
// Sits next to the organization switcher. The switcher is "which workspace";
// this is "which person". Sign-out is only offered when a real session can
// end — local-owner mode is this machine, so there is nothing to sign out of.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAuthActions } from '../../auth/AuthActions';
import { useOptionalOrg } from '../../org/OrgContext';
import { Icon } from '../Icon';
import styles from './AccountMenu.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`.toUpperCase();
}

export function AccountMenu() {
  const t = useT();
  const org = useOptionalOrg();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!org || org.loading) return null;
  const viewer = org.auth?.viewer;
  if (!viewer) return null;

  const canSignOut = typeof signOut === 'function';
  const subtitle = viewer.email?.trim()
    ? viewer.email
    : canSignOut
      ? t('account.signedInAs')
      : t('account.thisComputer');

  async function handleSignOut() {
    if (!signOut || busy) return;
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account.menuAria')}
        data-testid="account-menu-trigger"
      >
        <span className={styles.avatar} aria-hidden="true">
          {initials(viewer.displayName)}
        </span>
      </button>

      {open ? (
        <div className={styles.menu} role="menu" data-testid="account-menu">
          <div className={styles.identity}>
            <span className={styles.itemName}>{viewer.displayName}</span>
            <span className={styles.itemMeta}>{subtitle}</span>
          </div>
          {canSignOut ? (
            <>
              <div className={styles.divider} role="separator" />
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => void handleSignOut()}
                disabled={busy}
                data-testid="account-sign-out"
              >
                <Icon name="log-out" size={14} />
                <span>{t('account.signOut')}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
