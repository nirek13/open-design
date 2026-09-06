// Apps, across every organization you belong to.
//
// People do not think of their work as living inside whichever organization
// happens to be selected — they think of it as theirs. So this view spans all
// of them by default and lets you narrow to one, rather than making you
// switch organizations to find something you know exists.
//
// The important detail is that every action targets the app's *own*
// organization, taken from the row, never the globally active one. Using the
// active org here would silently archive or reshare the wrong thing the
// moment the list spans more than one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateAppFlow } from '../apps/CreateAppFlow';
import { SendAppPicker } from '../apps/SendAppPicker';
import { AppDataScopePicker, splitGmailScope, withGmailScope } from '../apps/AppDataScopePicker';
import { AppPreviewThumb } from '../apps/AppPreviewThumb';
import { useOptionalRunningApp, markAppEditWorkspaceFocus } from '../apps/RunningAppContext';
import { Badge, Button, Dialog, DialogTitle, EmptyState, Select } from '@open-design/components';
import { Icon } from '../Icon';
import type {
  AppAccessMode,
  AppAccessPolicy,
  AppDataScope,
  AppGrantRole,
  OrgAppWithOrgName,
  OrgMember,
  OrgTeam,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchAllOrgApps,
  fetchAppAccess,
  fetchOrgMembers,
  fetchOrgTeams,
  publishAppToWeb,
  recordOrgAppOpen,
  setAppAccess,
  updateOrgApp,
} from '../../providers/registry';
import { navigate } from '../../router';
import styles from './OrgAppsView.module.css';

const ALL_ORGS = '__all__';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relativeTime(timestamp: number, t: ReturnType<typeof useT>): string {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return t('apps.minutesAgo', { count: String(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('apps.hoursAgo', { count: String(hours) });
  return t('apps.daysAgo', { count: String(Math.round(hours / 24)) });
}

export function OrgAppsView({ active }: { active: boolean }) {
  const t = useT();
  const runningApp = useOptionalRunningApp();
  const { organizations, activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [apps, setApps] = useState<OrgAppWithOrgName[]>([]);
  const [filter, setFilter] = useState<string>(ALL_ORGS);
  const [error, setError] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<{ appId: string; url: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [membersByOrg, setMembersByOrg] = useState<Record<string, OrgMember[]>>({});
  const [teamsByOrg, setTeamsByOrg] = useState<Record<string, OrgTeam[]>>({});
  const [accessByApp, setAccessByApp] = useState<Record<string, AppAccessPolicy>>({});

  const load = useCallback(async () => {
    try {
      setApps(await fetchAllOrgApps());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  useEffect(() => {
    if (!menuOpenId) return;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpenId(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpenId]);

  const shown = useMemo(
    () => (filter === ALL_ORGS ? apps : apps.filter((orgApp) => orgApp.orgId === filter)),
    [apps, filter],
  );
  const spansOrgs = filter === ALL_ORGS && new Set(apps.map((a) => a.orgId)).size > 1;

  async function handleOpen(orgApp: OrgAppWithOrgName) {
    void recordOrgAppOpen(orgApp.orgId, orgApp.id).catch(() => {});
    if (!runningApp) {
      setError(t('apps.failedToRun'));
      return;
    }
    try {
      await runningApp.openApp(orgApp.orgId, orgApp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleEdit(orgApp: OrgAppWithOrgName) {
    markAppEditWorkspaceFocus();
    navigate({
      kind: 'project',
      projectId: orgApp.projectId,
      conversationId: null,
      fileName: orgApp.filePath,
    });
  }

  async function handlePin(orgApp: OrgAppWithOrgName, pinned: boolean) {
    try {
      await updateOrgApp(orgApp.orgId, orgApp.id, { pinned });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleAccessMode(orgApp: OrgAppWithOrgName, accessMode: AppAccessMode) {
    try {
      await updateOrgApp(orgApp.orgId, orgApp.id, { accessMode });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDataScopes(orgApp: OrgAppWithOrgName, next: AppDataScope[]) {
    try {
      await updateOrgApp(orgApp.orgId, orgApp.id, { dataScopes: next });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openManage(orgApp: OrgAppWithOrgName) {
    setSendingId(null);
    setMenuOpenId(null);
    setManagingId(orgApp.id);
    try {
      if (!membersByOrg[orgApp.orgId]) {
        const members = await fetchOrgMembers(orgApp.orgId);
        setMembersByOrg((prev) => ({ ...prev, [orgApp.orgId]: members }));
      }
      if (!teamsByOrg[orgApp.orgId]) {
        const teams = await fetchOrgTeams(orgApp.orgId).catch(() => [] as OrgTeam[]);
        setTeamsByOrg((prev) => ({ ...prev, [orgApp.orgId]: teams }));
      }
      const access = await fetchAppAccess(orgApp.orgId, orgApp.id);
      setAccessByApp((prev) => ({ ...prev, [orgApp.id]: access }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function currentAccess(appId: string): AppAccessPolicy {
    return accessByApp[appId] ?? { grants: [], teamGrants: [], denials: [] };
  }

  async function saveAccess(
    orgApp: OrgAppWithOrgName,
    next: {
      grants: Array<{ memberId: string; role: AppGrantRole }>;
      teamGrants: Array<{ teamId: string; role: AppGrantRole }>;
      denials: Array<{ memberId: string }>;
    },
  ) {
    const saved = await setAppAccess(orgApp.orgId, orgApp.id, next);
    setAccessByApp((prev) => ({ ...prev, [orgApp.id]: saved }));
  }

  async function toggleGrant(orgApp: OrgAppWithOrgName, memberId: string, role: AppGrantRole) {
    const current = currentAccess(orgApp.id);
    const existing = current.grants.find((g) => g.memberId === memberId);
    const grants =
      existing?.role === role
        ? current.grants.filter((g) => g.memberId !== memberId)
        : [...current.grants.filter((g) => g.memberId !== memberId), { memberId, role }];
    try {
      await saveAccess(orgApp, {
        grants: grants.map((g) => ({ memberId: g.memberId, role: g.role })),
        teamGrants: current.teamGrants.map((g) => ({ teamId: g.teamId, role: g.role })),
        denials: current.denials.filter((row) => row.memberId !== memberId).map((row) => ({ memberId: row.memberId })),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleTeamGrant(orgApp: OrgAppWithOrgName, teamId: string, role: AppGrantRole) {
    const current = currentAccess(orgApp.id);
    const existing = current.teamGrants.find((g) => g.teamId === teamId);
    const teamGrants =
      existing?.role === role
        ? current.teamGrants.filter((g) => g.teamId !== teamId)
        : [...current.teamGrants.filter((g) => g.teamId !== teamId), { teamId, role }];
    try {
      await saveAccess(orgApp, {
        grants: current.grants.map((g) => ({ memberId: g.memberId, role: g.role })),
        teamGrants: teamGrants.map((g) => ({ teamId: g.teamId, role: g.role })),
        denials: current.denials.map((row) => ({ memberId: row.memberId })),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleDenial(orgApp: OrgAppWithOrgName, memberId: string) {
    const current = currentAccess(orgApp.id);
    const on = current.denials.some((row) => row.memberId === memberId);
    const denials = on
      ? current.denials.filter((row) => row.memberId !== memberId)
      : [...current.denials, { memberId }];
    try {
      await saveAccess(orgApp, {
        grants: current.grants
          .filter((g) => g.memberId !== memberId)
          .map((g) => ({ memberId: g.memberId, role: g.role })),
        teamGrants: current.teamGrants.map((g) => ({ teamId: g.teamId, role: g.role })),
        denials: denials.map((row) => ({ memberId: row.memberId })),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyUrl(url: string, appId: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard optional — the dialog still shows the URL.
    }
    setShareLink({ appId, url });
  }

  async function handlePublishToWeb(orgApp: OrgAppWithOrgName) {
    setMenuOpenId(null);
    if (orgApp.webUrl) {
      await copyUrl(orgApp.webUrl, orgApp.id);
      return;
    }
    try {
      const published = await publishAppToWeb(orgApp.orgId, orgApp.id);
      await copyUrl(published.url, orgApp.id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleArchive(orgApp: OrgAppWithOrgName) {
    try {
      await updateOrgApp(orgApp.orgId, orgApp.id, { status: 'archived' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const createOrgId = filter !== ALL_ORGS ? filter : activeOrgId;
  const managingApp = shown.find((orgApp) => orgApp.id === managingId) ?? null;
  const sendingApp = shown.find((orgApp) => orgApp.id === sendingId) ?? null;

  return (
    <div className="entry-section" data-testid="org-apps-view">
      <header className="entry-section__head">
        <div className={styles.headRow}>
          <div>
            <h1 className="entry-section__title">{t('apps.title')}</h1>
            <p className="entry-section__subtitle">{t('apps.subtitleAcrossOrgs')}</p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            disabled={!createOrgId}
            data-testid="apps-new"
          >
            {t('apps.create.new')}
          </Button>
        </div>
      </header>

      {organizations.length > 1 ? (
        <div className={styles.filterRow}>
          <Select
            value={filter}
            aria-label={t('apps.filterByOrg')}
            onChange={(event) => setFilter(event.target.value)}
            data-testid="apps-org-filter"
          >
            <option value={ALL_ORGS}>{t('apps.allOrganizations')}</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
          <span className={styles.filterCount}>
            {t('apps.countShown', { count: String(shown.length) })}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState title={t('apps.empty')} description={t('apps.emptyBody')} />
      ) : (
        <div className={styles.grid}>
          {shown.map((orgApp) => {
            const menuOpen = menuOpenId === orgApp.id;
            return (
              <article
                key={orgApp.id}
                className={`${styles.card}${menuOpen ? ` ${styles.cardMenuOpen}` : ''}`}
                data-testid="org-app-card"
              >
                <div className={styles.previewWrap}>
                  <AppPreviewThumb
                    projectId={orgApp.projectId}
                    filePath={orgApp.filePath}
                    name={orgApp.name}
                  />
                  <button
                    type="button"
                    className={styles.previewHit}
                    onClick={() => void handleOpen(orgApp)}
                    aria-label={`${t('apps.open')} ${orgApp.name}`}
                  />
                </div>

                <div className={styles.cardBody}>
                  <div className={styles.cardCopy}>
                    <div className={styles.cardTop}>
                      <button
                        type="button"
                        className={styles.cardName}
                        onClick={() => void handleOpen(orgApp)}
                      >
                        {orgApp.name}
                      </button>
                      {orgApp.pinned ? <Badge tone="positive">{t('apps.pinned')}</Badge> : null}
                      {spansOrgs ? (
                        <Badge tone="neutral" data-testid="org-app-org-name">
                          {orgApp.orgName}
                        </Badge>
                      ) : null}
                    </div>
                    {orgApp.description ? (
                      <p className={styles.cardDescription}>{orgApp.description}</p>
                    ) : null}
                    <p className={styles.cardMeta}>
                      {orgApp.createdByName
                        ? t('apps.byline', { name: orgApp.createdByName })
                        : t('apps.bylineUnknown')}
                      {orgApp.lastOpenedAt ? ` · ${relativeTime(orgApp.lastOpenedAt, t)}` : ''}
                      {` · ${t(`apps.access.${orgApp.accessMode}` as never)}`}
                    </p>
                  </div>

                  <div
                    className={styles.moreWrap}
                    ref={menuOpen ? menuRef : undefined}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className={styles.moreTrigger}
                      aria-label={t('apps.more')}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      data-testid="org-app-more"
                      onClick={() =>
                        setMenuOpenId((current) => (current === orgApp.id ? null : orgApp.id))
                      }
                    >
                      <Icon name="more-horizontal" size={16} />
                    </Button>
                    {menuOpen ? (
                      <div
                        className={styles.moreMenu}
                        role="menu"
                        aria-label={t('apps.more')}
                        data-testid="org-app-more-menu"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="org-app-send"
                          onClick={() => {
                            setManagingId(null);
                            setMenuOpenId(null);
                            setSendingId(orgApp.id);
                          }}
                        >
                          {t('apps.send')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpenId(null);
                            handleEdit(orgApp);
                          }}
                        >
                          {t('apps.edit')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpenId(null);
                            void handlePin(orgApp, !orgApp.pinned);
                          }}
                        >
                          {orgApp.pinned ? t('apps.unpin') : t('apps.pin')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void openManage(orgApp)}
                        >
                          {t('apps.manageAccess')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="org-app-publish-web"
                          onClick={() => void handlePublishToWeb(orgApp)}
                        >
                          {orgApp.webUrl ? t('apps.copyWebLink') : t('apps.publishToWeb')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.moreDanger}
                          onClick={() => {
                            setMenuOpenId(null);
                            void handleArchive(orgApp);
                          }}
                        >
                          {t('apps.archive')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {managingApp ? (
        <Dialog
          onClose={() => setManagingId(null)}
          ariaLabel={t('apps.manageAccess')}
          closeOnEscape
        >
          <DialogTitle>{managingApp.name}</DialogTitle>
          <div className={styles.manageBox} data-testid="org-app-access">
            <AppDataScopePicker
              orgId={managingApp.orgId}
              value={splitGmailScope(managingApp.dataScopes ?? []).tables}
              onChange={(tables) => {
                const current = splitGmailScope(managingApp.dataScopes ?? []);
                void handleDataScopes(managingApp, withGmailScope(tables, current.allowGmail));
              }}
              allowGmail={splitGmailScope(managingApp.dataScopes ?? []).allowGmail}
              onAllowGmailChange={(allow) => {
                const current = splitGmailScope(managingApp.dataScopes ?? []);
                void handleDataScopes(managingApp, withGmailScope(current.tables, allow));
              }}
            />
            <fieldset className={styles.fieldset}>
              <legend>{t('apps.create.access')}</legend>
              <label className={styles.radio}>
                <input
                  type="radio"
                  checked={managingApp.accessMode === 'org'}
                  onChange={() => void handleAccessMode(managingApp, 'org')}
                />
                {t('apps.access.org')}
              </label>
              <label className={styles.radio}>
                <input
                  type="radio"
                  checked={managingApp.accessMode === 'restricted'}
                  onChange={() => void handleAccessMode(managingApp, 'restricted')}
                />
                {t('apps.access.restricted')}
              </label>
            </fieldset>
            {managingApp.accessMode === 'restricted' ? (
              <div className={styles.grants}>
                {(membersByOrg[managingApp.orgId] ?? []).map((member) => {
                  const grant = currentAccess(managingApp.id).grants.find((g) => g.memberId === member.id);
                  return (
                    <div key={member.id} className={styles.grantRow}>
                      <span>{member.displayName}</span>
                      <div className={styles.grantRoles}>
                        <button
                          type="button"
                          className={grant?.role === 'view' ? styles.roleActive : styles.role}
                          onClick={() => void toggleGrant(managingApp, member.id, 'view')}
                        >
                          {t('apps.grant.view')}
                        </button>
                        <button
                          type="button"
                          className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                          onClick={() => void toggleGrant(managingApp, member.id, 'edit')}
                        >
                          {t('apps.grant.edit')}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {(teamsByOrg[managingApp.orgId] ?? []).map((team) => {
                  const grant = currentAccess(managingApp.id).teamGrants.find((g) => g.teamId === team.id);
                  return (
                    <div key={team.id} className={styles.grantRow}>
                      <span>{team.name}</span>
                      <div className={styles.grantRoles}>
                        <button
                          type="button"
                          className={grant?.role === 'view' ? styles.roleActive : styles.role}
                          onClick={() => void toggleTeamGrant(managingApp, team.id, 'view')}
                        >
                          {t('apps.grant.view')}
                        </button>
                        <button
                          type="button"
                          className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                          onClick={() => void toggleTeamGrant(managingApp, team.id, 'edit')}
                        >
                          {t('apps.grant.edit')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <fieldset className={styles.fieldset}>
              <legend>{t('apps.except')}</legend>
              <p className={styles.shareWarning}>{t('apps.exceptHint')}</p>
              <div className={styles.grants}>
                {(membersByOrg[managingApp.orgId] ?? [])
                  .filter((member) => member.status === 'active')
                  .map((member) => {
                    const on = currentAccess(managingApp.id).denials.some((row) => row.memberId === member.id);
                    return (
                      <button
                        key={member.id}
                        type="button"
                        className={on ? styles.exceptOn : styles.role}
                        aria-pressed={on}
                        data-testid={`org-app-except-${member.id}`}
                        onClick={() => void toggleDenial(managingApp, member.id)}
                      >
                        {member.displayName}
                      </button>
                    );
                  })}
              </div>
            </fieldset>
            <Button variant="ghost" onClick={() => setManagingId(null)}>
              {t('apps.dismiss')}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {sendingApp ? (
        <Dialog
          onClose={() => setSendingId(null)}
          ariaLabel={t('apps.send')}
          closeOnEscape
        >
          <div data-testid="org-app-send-picker">
            <SendAppPicker
              orgId={sendingApp.orgId}
              app={sendingApp}
              onSkip={() => setSendingId(null)}
              onSent={() => setSendingId(null)}
            />
          </div>
        </Dialog>
      ) : null}

      {shareLink ? (
        <Dialog
          onClose={() => setShareLink(null)}
          ariaLabel={t('apps.liveOnWeb')}
          closeOnEscape
        >
          <div className={styles.shareBox} data-testid="org-app-share-link">
            <code className={styles.shareUrl}>{shareLink.url}</code>
            <p className={styles.shareWarning}>{t('apps.publishToWebHint')}</p>
            <Button variant="ghost" onClick={() => setShareLink(null)}>
              {t('apps.dismiss')}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {createOpen && createOrgId ? (
        <div
          className={styles.modalScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setCreateOpen(false);
          }}
        >
          <CreateAppFlow
            orgId={createOrgId}
            onClose={() => setCreateOpen(false)}
            onCreated={(app) => {
              void load();
              if (runningApp) {
                void runningApp.openApp(createOrgId, app).catch((err) => {
                  setError(err instanceof Error ? err.message : String(err));
                });
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
