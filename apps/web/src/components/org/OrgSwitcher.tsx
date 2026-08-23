// Which organization am I in, and how do I get to another one?
//
// Sits in the workspace tab chrome. Shows the active organization at a glance, and
// opens a menu to switch, create, or manage. This is the anchor of the whole
// org model in the UI — everything else in the app is "inside" whatever this
// says.

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@open-design/components';
import type { OrgPendingInvite } from '@open-design/contracts';
import { useT } from '../../i18n';
import { useOptionalOrg } from '../../org/OrgContext';
import { acceptPendingInvite, fetchPendingInvites } from '../../providers/registry';
import styles from './OrgSwitcher.module.css';

interface Props {
  onManage: () => void;
}

export function OrgSwitcher({ onManage }: Props) {
  const t = useT();
  const org = useOptionalOrg();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<OrgPendingInvite[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    void (async () => {
      try {
        const invites = await fetchPendingInvites();
        if (!cancelled) setPending(invites);
      } catch {
        if (!cancelled) setPending([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

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

  // Rendered outside a provider (an embedded shell, a narrow test harness):
  // show nothing rather than throwing and blanking everything around us.
  if (!org) return null;
  const { organizations, activeOrg, setActiveOrg, createOrganization, loading, refresh } = org;

  async function handleCreate() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createOrganization(name.trim());
      setName('');
      setCreating(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptPending(invite: OrgPendingInvite) {
    if (acceptingId) return;
    setAcceptingId(invite.id);
    try {
      await acceptPendingInvite(invite.id);
      setPending((current) => current.filter((item) => item.id !== invite.id));
      await refresh();
      setActiveOrg(invite.orgId);
      setOpen(false);
    } finally {
      setAcceptingId(null);
    }
  }

  if (loading) return null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="org-switcher-trigger"
      >
        <span className={styles.avatar} aria-hidden="true">
          {(activeOrg?.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.name}>{activeOrg?.name ?? t('org.noOrganization')}</span>
        {pending.length > 0 ? (
          <span className={styles.badge} data-testid="org-pending-badge">
            {pending.length}
          </span>
        ) : null}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className={styles.menu} role="menu" data-testid="org-switcher-menu">
          <div className={styles.menuLabel}>{t('org.switcherLabel')}</div>
          {organizations.map((org) => (
            <button
              key={org.id}
              type="button"
              role="menuitem"
              className={`${styles.item}${org.id === activeOrg?.id ? ` ${styles.itemActive}` : ''}`}
              onClick={() => {
                if (org.id !== activeOrg?.id) setActiveOrg(org.id);
                setOpen(false);
              }}
            >
              <span className={styles.itemName}>{org.name}</span>
              <span className={styles.itemMeta}>
                {org.role} · {t('org.memberCount', { count: String(org.memberCount) })}
              </span>
            </button>
          ))}

          {pending.length > 0 ? (
            <>
              <div className={styles.divider} role="separator" />
              <div className={styles.menuLabel}>{t('org.pendingInvites')}</div>
              {pending.map((invite) => (
                <div key={invite.id} className={styles.pending} data-testid="org-pending-invite">
                  <div className={styles.pendingText}>
                    <span className={styles.itemName}>{invite.orgName}</span>
                    <span className={styles.itemMeta}>
                      {t(`org.role.${invite.role}` as never)} · {t(`org.kind.${invite.kind}` as never)}
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => void handleAcceptPending(invite)}
                    disabled={acceptingId === invite.id}
                    data-testid="org-accept-pending"
                  >
                    {t('org.acceptInvite')}
                  </Button>
                </div>
              ))}
            </>
          ) : null}

          <div className={styles.divider} role="separator" />

          {creating ? (
            <div className={styles.createRow}>
              <Input
                type="text"
                autoFocus
                value={name}
                placeholder={t('org.newOrgName')}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleCreate();
                }}
                data-testid="org-create-name"
              />
              <Button variant="primary" onClick={handleCreate} disabled={!name.trim() || busy}>
                {t('org.create')}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => setCreating(true)}
              data-testid="org-create-open"
            >
              {t('org.createOrganization')}
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            data-testid="org-manage"
          >
            {t('org.manage')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
