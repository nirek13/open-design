// Who is in this organization, and how do I add someone?
//
// Three ways in: email, username, or a shareable link. Email and username
// invites are bound to that person; the link is for anyone you send it to.
// The token is shown exactly once because only its hash is stored.

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type { OrgInvite, OrgMember, OrgRole } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createOrgInvite,
  fetchOrgInvites,
  fetchOrgMembers,
  removeOrgMember,
  renameOrganization,
  revokeOrgInvite,
  updateOrgMemberRole,
} from '../../providers/registry';
import styles from './OrgMembersView.module.css';

const ROLES: OrgRole[] = ['member', 'admin', 'owner'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

function inviteTargetLabel(invite: OrgInvite, t: (key: never) => string): string {
  if (invite.kind === 'email') return invite.targetEmail ?? t('org.kind.email' as never);
  if (invite.kind === 'username') return invite.targetUsername ?? t('org.kind.username' as never);
  return t('org.kind.link' as never);
}

export function OrgMembersView({ active }: { active: boolean }) {
  const t = useT();
  const { activeOrg, activeOrgId, can, refresh } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [freshTarget, setFreshTarget] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviteTarget, setInviteTarget] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdmin = can('admin');
  const isOwner = can('owner');

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setMembers(await fetchOrgMembers(activeOrgId));
      // Invites are admin-only; a plain member seeing an empty list is
      // correct, not an error worth shouting about.
      if (isAdmin) setInvites(await fetchOrgInvites(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId, isAdmin]);

  useEffect(() => {
    if (!active) return;
    setOrgName(activeOrg?.name ?? '');
    void load();
  }, [active, activeOrg?.name, load]);

  async function mintInvite(request: { email?: string; username?: string }) {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      const created = await createOrgInvite(activeOrgId, { role: inviteRole, ...request });
      setFreshLink(created.url);
      setEmailed(Boolean(created.emailed));
      if (created.emailError) setError(created.emailError);
      setFreshTarget(
        created.invite.kind === 'email'
          ? created.invite.targetEmail
          : created.invite.kind === 'username'
            ? created.invite.targetUsername
            : null,
      );
      setCopied(false);
      try {
        await navigator.clipboard.writeText(created.url);
        setCopied(true);
      } catch {
        // Clipboard permission is not guaranteed; the link stays on screen.
      }
      if (request.email || request.username) setInviteTarget('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSendInvite() {
    const target = inviteTarget.trim();
    if (!target) {
      setError(t('org.inviteNeedTarget'));
      return;
    }
    if (looksLikeEmail(target)) await mintInvite({ email: target });
    else await mintInvite({ username: target });
  }

  async function handleCreateLink() {
    await mintInvite({});
  }

  async function handleRoleChange(member: OrgMember, role: OrgRole) {
    if (!activeOrgId) return;
    try {
      await updateOrgMemberRole(activeOrgId, member.id, role);
      await load();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleRemove(member: OrgMember) {
    if (!activeOrgId) return;
    try {
      await removeOrgMember(activeOrgId, member.id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleRename() {
    if (!activeOrgId || !orgName.trim()) return;
    try {
      await renameOrganization(activeOrgId, orgName.trim());
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="entry-section" data-testid="org-members-view">
      <header className="entry-section__head">
        <h1 className="entry-section__title">{t('org.membersTitle')}</h1>
        <p className="entry-section__subtitle">{t('org.membersSubtitle')}</p>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {isAdmin ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>{t('org.inviteTitle')}</h2>
          <p className={styles.panelHint}>{t('org.inviteHint')}</p>
          <div className={styles.row}>
            <Input
              type="text"
              value={inviteTarget}
              onChange={(event) => setInviteTarget(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSendInvite();
              }}
              placeholder={t('org.invitePlaceholder')}
              aria-label={t('org.invitePlaceholder')}
              data-testid="org-invite-target"
            />
            <Select
              value={inviteRole}
              aria-label={t('org.role')}
              onChange={(event) => setInviteRole(event.target.value as OrgRole)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`org.role.${role}` as never)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              onClick={() => void handleSendInvite()}
              disabled={busy}
              data-testid="org-send-invite"
            >
              {t('org.sendInvite')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void handleCreateLink()}
              disabled={busy}
              data-testid="org-create-invite"
            >
              {t('org.createInvite')}
            </Button>
          </div>

          {freshLink ? (
            <div className={styles.linkBox} data-testid="org-invite-link">
              <code className={styles.link}>{freshLink}</code>
              <div className={styles.linkActions}>
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(freshLink);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? t('org.copied') : t('org.copyLink')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setFreshLink(null);
                    setFreshTarget(null);
                    setEmailed(false);
                  }}
                >
                  {t('org.dismiss')}
                </Button>
              </div>
              <p className={styles.linkWarning}>
                {freshTarget
                  ? emailed
                    ? t('org.inviteEmailed', { target: freshTarget })
                    : t('org.inviteSentTo', { target: freshTarget })
                  : t('org.linkShownOnce')}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>{t('org.members')}</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('org.person')}</th>
                <th scope="col">{t('org.role')}</th>
                <th scope="col">{t('org.status')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className={styles.person}>
                      <span className={styles.personName}>{member.displayName}</span>
                      {member.email ? <span className={styles.personEmail}>{member.email}</span> : null}
                    </div>
                  </td>
                  <td>
                    {isOwner ? (
                      <Select
                        value={member.role}
                        aria-label={t('org.role')}
                        onChange={(event) => handleRoleChange(member, event.target.value as OrgRole)}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`org.role.${role}` as never)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      t(`org.role.${member.role}` as never)
                    )}
                  </td>
                  <td>{member.status === 'active' ? t('org.active') : t('org.removed')}</td>
                  <td>
                    {isOwner && member.status === 'active' ? (
                      <Button variant="ghost" onClick={() => handleRemove(member)}>
                        {t('org.remove')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && invites.length > 0 ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>{t('org.invites')}</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('org.inviteTarget')}</th>
                  <th scope="col">{t('org.role')}</th>
                  <th scope="col">{t('org.uses')}</th>
                  <th scope="col">{t('org.status')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>{inviteTargetLabel(invite, t)}</td>
                    <td>{t(`org.role.${invite.role}` as never)}</td>
                    <td>
                      {invite.useCount}
                      {invite.maxUses ? ` / ${invite.maxUses}` : ''}
                    </td>
                    <td>{invite.revokedAt ? t('org.revoked') : t('org.active')}</td>
                    <td>
                      {invite.revokedAt ? null : (
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            if (!activeOrgId) return;
                            try {
                              await revokeOrgInvite(activeOrgId, invite.id);
                              await load();
                            } catch (err) {
                              setError(errorMessage(err));
                            }
                          }}
                        >
                          {t('org.revoke')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {isAdmin ? (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>{t('org.settings')}</h2>
          <div className={styles.row}>
            <Input
              type="text"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
              aria-label={t('org.organizationName')}
            />
            <Button onClick={handleRename} disabled={!orgName.trim()}>
              {t('org.rename')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
