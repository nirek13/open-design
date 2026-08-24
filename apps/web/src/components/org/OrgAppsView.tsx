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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreateAppFlow } from '../apps/CreateAppFlow';
import { SendAppPicker } from '../apps/SendAppPicker';
import { useOptionalRunningApp, markAppEditWorkspaceFocus } from '../apps/RunningAppContext';
import { Badge, Button, EmptyState, Select } from '@open-design/components';
import type {
  AppAccessMode,
  AppAccessPolicy,
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

  async function openManage(orgApp: OrgAppWithOrgName) {
    setSendingId(null);
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

  async function handlePublishToWeb(orgApp: OrgAppWithOrgName) {
    try {
      const published = await publishAppToWeb(orgApp.orgId, orgApp.id);
      setShareLink({ appId: orgApp.id, url: published.url });
      try {
        await navigator.clipboard.writeText(published.url);
      } catch {
        // Clipboard optional.
      }
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
          {shown.map((orgApp) => (
            <article key={orgApp.id} className={styles.card} data-testid="org-app-card">
              <button type="button" className={styles.cardMain} onClick={() => handleOpen(orgApp)}>
                <span className={styles.cardTop}>
                  <span className={styles.cardName}>{orgApp.name}</span>
                  {orgApp.pinned ? <Badge tone="positive">{t('apps.pinned')}</Badge> : null}
                  {spansOrgs ? (
                    <Badge tone="neutral" data-testid="org-app-org-name">
                      {orgApp.orgName}
                    </Badge>
                  ) : null}
                </span>
                {orgApp.description ? (
                  <span className={styles.cardDescription}>{orgApp.description}</span>
                ) : null}
                <span className={styles.cardMeta}>
                  {orgApp.createdByName
                    ? t('apps.byline', { name: orgApp.createdByName })
                    : t('apps.bylineUnknown')}
                  {orgApp.lastOpenedAt ? ` · ${relativeTime(orgApp.lastOpenedAt, t)}` : ''}
                  {` · ${t(`apps.access.${orgApp.accessMode}` as never)}`}
                </span>
              </button>

              <div className={styles.cardActions}>
                <Button variant="ghost" onClick={() => void handleOpen(orgApp)}>
                  {t('apps.open')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setManagingId(null);
                    setSendingId((current) => (current === orgApp.id ? null : orgApp.id));
                  }}
                  data-testid="org-app-send"
                >
                  {t('apps.send')}
                </Button>
                <Button variant="ghost" onClick={() => handleEdit(orgApp)}>
                  {t('apps.edit')}
                </Button>
                <Button variant="ghost" onClick={() => void handlePin(orgApp, !orgApp.pinned)}>
                  {orgApp.pinned ? t('apps.unpin') : t('apps.pin')}
                </Button>
                <Button variant="ghost" onClick={() => void openManage(orgApp)}>
                  {t('apps.manageAccess')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void handlePublishToWeb(orgApp)}
                  data-testid="org-app-publish-web"
                >
                  {orgApp.webUrl ? t('apps.copyWebLink') : t('apps.publishToWeb')}
                </Button>
                <Button variant="ghost" onClick={() => void handleArchive(orgApp)}>
                  {t('apps.archive')}
                </Button>
              </div>

              {managingId === orgApp.id ? (
                <div className={styles.manageBox} data-testid="org-app-access">
                  <fieldset className={styles.fieldset}>
                    <legend>{t('apps.create.access')}</legend>
                    <label className={styles.radio}>
                      <input
                        type="radio"
                        checked={orgApp.accessMode === 'org'}
                        onChange={() => void handleAccessMode(orgApp, 'org')}
                      />
                      {t('apps.access.org')}
                    </label>
                    <label className={styles.radio}>
                      <input
                        type="radio"
                        checked={orgApp.accessMode === 'restricted'}
                        onChange={() => void handleAccessMode(orgApp, 'restricted')}
                      />
                      {t('apps.access.restricted')}
                    </label>
                  </fieldset>
                  {orgApp.accessMode === 'restricted' ? (
                    <div className={styles.grants}>
                      {(membersByOrg[orgApp.orgId] ?? []).map((member) => {
                        const grant = currentAccess(orgApp.id).grants.find((g) => g.memberId === member.id);
                        return (
                          <div key={member.id} className={styles.grantRow}>
                            <span>{member.displayName}</span>
                            <div className={styles.grantRoles}>
                              <button
                                type="button"
                                className={grant?.role === 'view' ? styles.roleActive : styles.role}
                                onClick={() => void toggleGrant(orgApp, member.id, 'view')}
                              >
                                {t('apps.grant.view')}
                              </button>
                              <button
                                type="button"
                                className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                                onClick={() => void toggleGrant(orgApp, member.id, 'edit')}
                              >
                                {t('apps.grant.edit')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {(teamsByOrg[orgApp.orgId] ?? []).map((team) => {
                        const grant = currentAccess(orgApp.id).teamGrants.find((g) => g.teamId === team.id);
                        return (
                          <div key={team.id} className={styles.grantRow}>
                            <span>{team.name}</span>
                            <div className={styles.grantRoles}>
                              <button
                                type="button"
                                className={grant?.role === 'view' ? styles.roleActive : styles.role}
                                onClick={() => void toggleTeamGrant(orgApp, team.id, 'view')}
                              >
                                {t('apps.grant.view')}
                              </button>
                              <button
                                type="button"
                                className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                                onClick={() => void toggleTeamGrant(orgApp, team.id, 'edit')}
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
                      {(membersByOrg[orgApp.orgId] ?? [])
                        .filter((member) => member.status === 'active')
                        .map((member) => {
                          const on = currentAccess(orgApp.id).denials.some((row) => row.memberId === member.id);
                          return (
                            <button
                              key={member.id}
                              type="button"
                              className={on ? styles.exceptOn : styles.role}
                              aria-pressed={on}
                              data-testid={`org-app-except-${member.id}`}
                              onClick={() => void toggleDenial(orgApp, member.id)}
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
              ) : null}

              {sendingId === orgApp.id ? (
                <div className={styles.manageBox} data-testid="org-app-send-picker">
                  <SendAppPicker
                    orgId={orgApp.orgId}
                    app={orgApp}
                    onSkip={() => setSendingId(null)}
                    onSent={() => setSendingId(null)}
                  />
                </div>
              ) : null}

              {shareLink?.appId === orgApp.id || orgApp.webUrl ? (
                <div className={styles.shareBox} data-testid="org-app-share-link">
                  <code className={styles.shareUrl}>
                    {shareLink?.appId === orgApp.id ? shareLink.url : orgApp.webUrl}
                  </code>
                  <p className={styles.shareWarning}>{t('apps.publishToWebHint')}</p>
                  <Button variant="ghost" onClick={() => setShareLink(null)}>
                    {t('apps.dismiss')}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

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
