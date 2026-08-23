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
import { useOptionalRunningApp, markAppEditWorkspaceFocus } from '../apps/RunningAppContext';
import { Badge, Button, EmptyState, Select } from '@open-design/components';
import type {
  AppAccessMode,
  AppGrant,
  AppGrantRole,
  OrgAppWithOrgName,
  OrgMember,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createAppShareLink,
  fetchAllOrgApps,
  fetchAppGrants,
  fetchOrgMembers,
  recordOrgAppOpen,
  setAppGrants,
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
  const [membersByOrg, setMembersByOrg] = useState<Record<string, OrgMember[]>>({});
  const [grantsByApp, setGrantsByApp] = useState<Record<string, AppGrant[]>>({});

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
    setManagingId(orgApp.id);
    try {
      if (!membersByOrg[orgApp.orgId]) {
        const members = await fetchOrgMembers(orgApp.orgId);
        setMembersByOrg((prev) => ({ ...prev, [orgApp.orgId]: members }));
      }
      const grants = await fetchAppGrants(orgApp.orgId, orgApp.id);
      setGrantsByApp((prev) => ({ ...prev, [orgApp.id]: grants }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleGrant(orgApp: OrgAppWithOrgName, memberId: string, role: AppGrantRole) {
    const current = grantsByApp[orgApp.id] ?? [];
    const existing = current.find((g) => g.memberId === memberId);
    let next: Array<{ memberId: string; role: AppGrantRole }>;
    if (existing?.role === role) {
      next = current.filter((g) => g.memberId !== memberId).map((g) => ({ memberId: g.memberId, role: g.role }));
    } else {
      next = [
        ...current.filter((g) => g.memberId !== memberId).map((g) => ({ memberId: g.memberId, role: g.role })),
        { memberId, role },
      ];
    }
    try {
      const saved = await setAppGrants(orgApp.orgId, orgApp.id, next);
      setGrantsByApp((prev) => ({ ...prev, [orgApp.id]: saved }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handlePreviewLink(orgApp: OrgAppWithOrgName) {
    try {
      const created = await createAppShareLink(orgApp.orgId, orgApp.id);
      setShareLink({ appId: orgApp.id, url: created.url });
      try {
        await navigator.clipboard.writeText(created.url);
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
                <Button variant="ghost" onClick={() => handleEdit(orgApp)}>
                  {t('apps.edit')}
                </Button>
                <Button variant="ghost" onClick={() => void handlePin(orgApp, !orgApp.pinned)}>
                  {orgApp.pinned ? t('apps.unpin') : t('apps.pin')}
                </Button>
                <Button variant="ghost" onClick={() => void openManage(orgApp)}>
                  {t('apps.manageAccess')}
                </Button>
                <Button variant="ghost" onClick={() => void handlePreviewLink(orgApp)}>
                  {t('apps.previewLink')}
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
                        const grant = (grantsByApp[orgApp.id] ?? []).find((g) => g.memberId === member.id);
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
                    </div>
                  ) : null}
                  <Button variant="ghost" onClick={() => setManagingId(null)}>
                    {t('apps.dismiss')}
                  </Button>
                </div>
              ) : null}

              {shareLink?.appId === orgApp.id ? (
                <div className={styles.shareBox} data-testid="org-app-share-link">
                  <code className={styles.shareUrl}>{shareLink.url}</code>
                  <p className={styles.shareWarning}>{t('apps.previewLinkWarning')}</p>
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
