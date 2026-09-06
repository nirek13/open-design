'use client';

// Deploy a project file as an org app — optimized for the common case:
// one click deploys to your workspace (org gallery + optional sidebar pin).
// Public web hosting stays one secondary choice away.

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import {
  alignAppScopesToTables,
  appRequestsTableWrites,
  inferAppScopesFromHtml,
  type AppAccessMode,
  type AppDataScope,
  type AppGrantRole,
  type OrgApp,
  type OrgMember,
  type OrgTeam,
  type ProjectFile,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchOrgMembers,
  fetchOrgTeams,
  fetchProjectFileText,
  fetchProjectFiles,
  fetchWorkspaceTables,
  publishApp,
  publishAppToWeb,
} from '../../providers/registry';
import {
  AppDataScopePicker,
  applyOrgDataWriteConsent,
  splitGmailScope,
  withGmailScope,
} from './AppDataScopePicker';
import { SendAppPicker } from './SendAppPicker';
import styles from './CreateAppFlow.module.css';

type Mode = 'choose' | 'workspace' | 'public';

export interface CreateAppFlowProps {
  orgId: string;
  projectId?: string;
  projectName?: string;
  filePath?: string;
  /** HTML of the file being published — used to propose data scopes. */
  htmlSource?: string | null;
  /** Skip the audience chooser when the caller already knows the destination. */
  initialMode?: Mode;
  onClose: () => void;
  onCreated?: (app: OrgApp) => void;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface DraftGrant {
  memberId: string;
  role: AppGrantRole;
}

interface DraftTeamGrant {
  teamId: string;
  role: AppGrantRole;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultAppName(filePath: string | undefined): string {
  if (!filePath) return '';
  return filePath.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled app';
}

function readOnlyInferredTables(inferred: readonly AppDataScope[]): AppDataScope[] {
  return splitGmailScope(inferred).tables.filter((scope) => scope.mode === 'read');
}

export function CreateAppFlow({
  orgId,
  projectId: initialProjectId,
  projectName: initialProjectName,
  filePath: initialFilePath,
  htmlSource,
  initialMode,
  onClose,
  onCreated,
}: CreateAppFlowProps) {
  const t = useT();
  const { organizations } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const orgName = organizations.find((org) => org.id === orgId)?.name ?? '';

  const lockedFile = Boolean(initialProjectId && initialFilePath);
  // Locked file (from the design you're looking at) → go straight to workspace
  // deploy form so "Deploy to workspace" is one confirm away.
  const [mode, setMode] = useState<Mode>(initialMode ?? (lockedFile ? 'workspace' : 'choose'));

  const [name, setName] = useState(() => defaultAppName(initialFilePath));
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [projectName, setProjectName] = useState(initialProjectName ?? '');
  const [filePath, setFilePath] = useState(initialFilePath ?? '');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [accessMode, setAccessMode] = useState<AppAccessMode>('org');
  const [pinned, setPinned] = useState(true);
  const [allowGmail, setAllowGmail] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [grants, setGrants] = useState<DraftGrant[]>([]);
  const [teamGrants, setTeamGrants] = useState<DraftTeamGrant[]>([]);
  const [denials, setDenials] = useState<string[]>([]);
  const [tableScopes, setTableScopes] = useState<AppDataScope[]>(() =>
    readOnlyInferredTables(inferAppScopesFromHtml(htmlSource)),
  );
  const [inferredScopes, setInferredScopes] = useState<AppDataScope[]>(() =>
    inferAppScopesFromHtml(htmlSource),
  );
  const [allowOrgWrites, setAllowOrgWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [createdApp, setCreatedApp] = useState<OrgApp | null>(null);

  useEffect(() => {
    if (lockedFile) return;
    void (async () => {
      try {
        const resp = await fetch('/api/projects');
        if (!resp.ok) return;
        const data = (await resp.json()) as { projects?: Array<{ id: string; name: string }> };
        setProjects((data.projects ?? []).map((p) => ({ id: p.id, name: p.name })));
      } catch {
        // Picker stays empty; user can still cancel.
      }
    })();
  }, [lockedFile]);

  useEffect(() => {
    if (!projectId || lockedFile) return;
    void (async () => {
      try {
        const next = await fetchProjectFiles(projectId);
        setFiles(next.filter((file) => /\.html?$/i.test(file.name) || /\.html?$/i.test(file.path ?? '')));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [lockedFile, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text =
        htmlSource ??
        (projectId && filePath ? await fetchProjectFileText(projectId, filePath) : null);
      const tables = await fetchWorkspaceTables(orgId).catch(() => []);
      if (cancelled) return;
      const inferred = alignAppScopesToTables(inferAppScopesFromHtml(text), tables);
      setInferredScopes(inferred);
      setAllowOrgWrites(false);
      setTableScopes(readOnlyInferredTables(inferred));
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, htmlSource, orgId, projectId]);

  useEffect(() => {
    if (!showAdvanced) return;
    void (async () => {
      try {
        const [nextMembers, nextTeams] = await Promise.all([
          fetchOrgMembers(orgId),
          fetchOrgTeams(orgId).catch(() => [] as OrgTeam[]),
        ]);
        setMembers(nextMembers);
        setTeams(nextTeams);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [orgId, showAdvanced]);

  const toggleGrant = (memberId: string, role: AppGrantRole) => {
    setGrants((prev) => {
      const existing = prev.find((g) => g.memberId === memberId);
      if (existing?.role === role) return prev.filter((g) => g.memberId !== memberId);
      const without = prev.filter((g) => g.memberId !== memberId);
      return [...without, { memberId, role }];
    });
    setDenials((prev) => prev.filter((id) => id !== memberId));
  };

  const toggleTeamGrant = (teamId: string, role: AppGrantRole) => {
    setTeamGrants((prev) => {
      const existing = prev.find((g) => g.teamId === teamId);
      if (existing?.role === role) return prev.filter((g) => g.teamId !== teamId);
      const without = prev.filter((g) => g.teamId !== teamId);
      return [...without, { teamId, role }];
    });
  };

  const toggleDenial = (memberId: string) => {
    setDenials((prev) => (prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]));
    setGrants((prev) => prev.filter((g) => g.memberId !== memberId));
  };

  const inferredWrites = splitGmailScope(inferredScopes).tables.filter((scope) => scope.mode === 'write');
  const needsWriteConsent = inferredWrites.length > 0 || appRequestsTableWrites(tableScopes);

  const setOrgWriteConsent = (allow: boolean) => {
    setAllowOrgWrites(allow);
    setTableScopes((current) => applyOrgDataWriteConsent(current, inferredScopes, allow));
  };

  const submitOrgApp = useCallback(async () => {
    if (!projectId || !filePath || !name.trim()) {
      setError(t('apps.create.needFile'));
      return;
    }
    const grantedTables = allowOrgWrites
      ? applyOrgDataWriteConsent(tableScopes, inferredScopes, true)
      : tableScopes;
    if ((inferredWrites.length > 0 || appRequestsTableWrites(grantedTables)) && !allowOrgWrites) {
      setError(t('apps.create.dataAccessNeedConsent'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tables = await fetchWorkspaceTables(orgId).catch(() => []);
      const alignedTables = alignAppScopesToTables(grantedTables, tables);
      const app = await publishApp(orgId, {
        name: name.trim(),
        description: description.trim() || undefined,
        projectId,
        filePath,
        visibility: 'org',
        accessMode,
        pinned,
        dataScopes: withGmailScope(alignedTables, allowGmail),
        ...(accessMode === 'restricted' ? { grants, teamGrants } : {}),
        ...(denials.length ? { denials: denials.map((memberId) => ({ memberId })) } : {}),
      });
      onCreated?.(app);
      setCreatedApp(app);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    accessMode,
    allowGmail,
    allowOrgWrites,
    denials,
    description,
    filePath,
    grants,
    inferredScopes,
    inferredWrites.length,
    teamGrants,
    name,
    onCreated,
    orgId,
    pinned,
    projectId,
    t,
    tableScopes,
  ]);

  const submitPublic = useCallback(async () => {
    const resolvedProjectId = projectId || initialProjectId;
    const resolvedFilePath = filePath || initialFilePath;
    if (!resolvedProjectId || !resolvedFilePath) {
      setError(t('apps.create.needFile'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const app = await publishApp(orgId, {
        name: name.trim() || defaultAppName(resolvedFilePath),
        description: description.trim() || undefined,
        projectId: resolvedProjectId,
        filePath: resolvedFilePath,
        visibility: 'link',
        pinned: true,
      });
      const published = await publishAppToWeb(orgId, app.id);
      setLiveUrl(published.url);
      setCopied(false);
      try {
        await navigator.clipboard.writeText(published.url);
        setCopied(true);
      } catch {
        // Clipboard is optional; the URL is still on screen.
      }
      onCreated?.(published.app);
      setCreatedApp(published.app);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    description,
    filePath,
    initialFilePath,
    initialProjectId,
    name,
    onCreated,
    orgId,
    projectId,
    t,
  ]);

  return (
    <div className={styles.panel} data-testid="create-app-flow">
      <header className={styles.head}>
        <h2 className={styles.title}>{t('apps.create.title')}</h2>
        <p className={styles.lead}>{t('apps.create.lead')}</p>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('apps.close')}>
          ✕
        </button>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {createdApp ? (
        <div className={styles.form} data-testid="create-app-send">
          {liveUrl ? (
            <>
              <p className={styles.hint}>{t('apps.create.liveUrl')}</p>
              <code className={styles.liveUrl}>{liveUrl}</code>
            </>
          ) : null}
          <SendAppPicker
            orgId={orgId}
            app={createdApp}
            title={t('apps.send.created', { name: createdApp.name })}
            lead={t('apps.send.createdLead')}
            onSkip={onClose}
          />
        </div>
      ) : null}

      {!createdApp && mode === 'choose' ? (
        <div className={styles.choices}>
          <button
            type="button"
            className={styles.choice}
            onClick={() => setMode('workspace')}
            data-testid="create-app-audience-org"
          >
            <strong>{t('apps.create.audienceOrg')}</strong>
            <span>{t('apps.create.audienceOrgDetail', { org: orgName || t('apps.create.thisOrg') })}</span>
          </button>
          <button
            type="button"
            className={styles.choice}
            onClick={() => setMode('public')}
            data-testid="create-app-audience-public"
          >
            <strong>{t('apps.create.audiencePublic')}</strong>
            <span>{t('apps.create.audiencePublicDetail')}</span>
          </button>
        </div>
      ) : null}

      {!createdApp && mode === 'public' && (projectId || initialProjectId) && (filePath || initialFilePath) ? (
        liveUrl ? (
          <div className={styles.form} data-testid="create-app-live">
            <p className={styles.hint}>{t('apps.create.liveUrl')}</p>
            <code className={styles.liveUrl}>{liveUrl}</code>
            <p className={styles.hint}>{t('apps.publishToWebHint')}</p>
            <div className={styles.footer}>
              <Button
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(liveUrl).then(() => setCopied(true)).catch(() => {});
                }}
              >
                {copied ? t('apps.copiedWebLink') : t('apps.copyWebLink')}
              </Button>
              <Button onClick={onClose}>{t('apps.dismiss')}</Button>
            </div>
          </div>
        ) : (
          <div className={styles.form}>
            <p className={styles.hint}>{t('apps.create.publishToWebHint')}</p>
            <p className={styles.hint}>{t('apps.create.publicNoData')}</p>
            <label className={styles.label}>
              {t('apps.create.name')}
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <div className={styles.footer}>
              {!lockedFile ? (
                <Button variant="ghost" onClick={() => setMode('choose')}>
                  {t('apps.create.back')}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setMode('workspace')}>
                  {t('apps.create.audienceOrg')}
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() => void submitPublic()}
                data-testid="create-app-publish-web"
              >
                {busy ? t('apps.publishingToWeb') : t('apps.create.publishToWeb')}
              </Button>
            </div>
          </div>
        )
      ) : null}

      {!createdApp && mode === 'public' && !(projectId && filePath) && !lockedFile ? (
        <div className={styles.form}>
          <p className={styles.hint}>{t('apps.create.pickFileFirst')}</p>
          <label className={styles.label}>
            {t('apps.create.project')}
            <Select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setProjectName(projects.find((p) => p.id === event.target.value)?.name ?? '');
                setFilePath('');
              }}
            >
              <option value="">{t('apps.create.pickProject')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.label}>
            {t('apps.create.file')}
            <Select value={filePath} onChange={(event) => setFilePath(event.target.value)} disabled={!projectId}>
              <option value="">{t('apps.create.pickFile')}</option>
              {files.map((file) => (
                <option key={file.path || file.name} value={file.path || file.name}>
                  {file.path || file.name}
                </option>
              ))}
            </Select>
          </label>
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setMode('choose')}>
              {t('apps.create.back')}
            </Button>
            <Button disabled={!projectId || !filePath} onClick={() => setMode('public')}>
              {t('apps.create.continue')}
            </Button>
          </div>
        </div>
      ) : null}

      {!createdApp && mode === 'workspace' ? (
        <div className={styles.form}>
          <p className={styles.hint}>
            {t('apps.create.workspaceHint', { org: orgName || t('apps.create.thisOrg') })}
          </p>

          {!lockedFile ? (
            <>
              <label className={styles.label}>
                {t('apps.create.project')}
                <Select
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setFilePath('');
                  }}
                >
                  <option value="">{t('apps.create.pickProject')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={styles.label}>
                {t('apps.create.file')}
                <Select
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  disabled={!projectId}
                >
                  <option value="">{t('apps.create.pickFile')}</option>
                  {files.map((file) => (
                    <option key={file.path || file.name} value={file.path || file.name}>
                      {file.path || file.name}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          ) : null}

          <label className={styles.label}>
            {t('apps.create.name')}
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>

          <AppDataScopePicker
            orgId={orgId}
            value={tableScopes}
            onChange={setTableScopes}
            allowGmail={allowGmail}
            onAllowGmailChange={setAllowGmail}
            suggested={inferredScopes}
          />

          {needsWriteConsent ? (
            <div className={styles.consent} data-testid="app-data-write-consent">
              <p className={styles.consentAsk}>
                {t('apps.create.dataAccessAsk', { org: orgName || t('apps.create.thisOrg') })}
              </p>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={allowOrgWrites}
                  onChange={(event) => setOrgWriteConsent(event.target.checked)}
                  data-testid="app-data-write-consent-check"
                />
                <span>{t('apps.create.dataAccessConsent')}</span>
              </label>
              <p className={styles.hint}>{t('apps.create.dataAccessConsentHint')}</p>
            </div>
          ) : null}

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            <span>{t('apps.create.pin')}</span>
          </label>

          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? t('apps.create.hideAdvanced') : t('apps.create.showAdvanced')}
          </button>

          {showAdvanced ? (
            <>
              <label className={styles.label}>
                {t('apps.create.description')}
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('apps.create.descriptionPlaceholder')}
                />
              </label>
              <fieldset className={styles.fieldset}>
                <legend>{t('apps.create.access')}</legend>
                <label className={styles.radio}>
                  <input
                    type="radio"
                    name="access"
                    checked={accessMode === 'org'}
                    onChange={() => setAccessMode('org')}
                  />
                  <span>{t('apps.create.accessOrg')}</span>
                </label>
                <label className={styles.radio}>
                  <input
                    type="radio"
                    name="access"
                    checked={accessMode === 'restricted'}
                    onChange={() => setAccessMode('restricted')}
                  />
                  <span>{t('apps.create.accessRestricted')}</span>
                </label>
              </fieldset>
              {accessMode === 'restricted' ? (
                <div className={styles.grants}>
                  {members.map((member) => {
                    const grant = grants.find((g) => g.memberId === member.id);
                    return (
                      <div key={member.id} className={styles.grantRow}>
                        <span>{member.displayName || member.email || member.id}</span>
                        <div className={styles.grantRoles}>
                          <button
                            type="button"
                            className={grant?.role === 'view' ? styles.roleActive : styles.role}
                            onClick={() => toggleGrant(member.id, 'view')}
                          >
                            {t('apps.create.roleViewer')}
                          </button>
                          <button
                            type="button"
                            className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                            onClick={() => toggleGrant(member.id, 'edit')}
                          >
                            {t('apps.create.roleEditor')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {teams.map((team) => {
                    const grant = teamGrants.find((g) => g.teamId === team.id);
                    return (
                      <div key={team.id} className={styles.grantRow}>
                        <span>{team.name}</span>
                        <div className={styles.grantRoles}>
                          <button
                            type="button"
                            className={grant?.role === 'view' ? styles.roleActive : styles.role}
                            onClick={() => toggleTeamGrant(team.id, 'view')}
                          >
                            {t('apps.create.roleViewer')}
                          </button>
                          <button
                            type="button"
                            className={grant?.role === 'edit' ? styles.roleActive : styles.role}
                            onClick={() => toggleTeamGrant(team.id, 'edit')}
                          >
                            {t('apps.create.roleEditor')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <fieldset className={styles.fieldset}>
                <legend>{t('apps.except')}</legend>
                <p className={styles.hint}>{t('apps.exceptHint')}</p>
                <div className={styles.grants}>
                  {members
                    .filter((member) => member.status === 'active')
                    .map((member) => {
                      const on = denials.includes(member.id);
                      return (
                        <button
                          key={member.id}
                          type="button"
                          className={on ? styles.exceptOn : styles.role}
                          aria-pressed={on}
                          data-testid={`create-app-except-${member.id}`}
                          onClick={() => toggleDenial(member.id)}
                        >
                          {member.displayName || member.email || member.id}
                        </button>
                      );
                    })}
                </div>
              </fieldset>
            </>
          ) : null}

          <div className={styles.footer}>
            {!lockedFile ? (
              <Button variant="ghost" onClick={() => setMode('choose')}>
                {t('apps.create.back')}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setMode('public')}>
                {t('apps.create.audiencePublic')}
              </Button>
            )}
            <Button
              disabled={busy || !projectId || !filePath || !name.trim()}
              onClick={() => void submitOrgApp()}
              data-testid="create-app-deploy-workspace"
            >
              {busy ? t('apps.create.deploying') : t('apps.create.deployWorkspace')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
