'use client';

// Deploy a project file as an org app — optimized for the common case:
// one click deploys to your workspace (org gallery + optional sidebar pin).
// Public web hosting stays one secondary choice away.

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type { AppAccessMode, AppGrantRole, OrgApp, OrgMember, ProjectFile } from '@open-design/contracts';
import { APP_GMAIL_SCOPE_TABLE } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchOrgMembers,
  fetchProjectFiles,
  publishApp,
} from '../../providers/registry';
import { PublishPanel } from '../hosting/PublishPanel';
import styles from './CreateAppFlow.module.css';

export interface CreateAppFlowProps {
  orgId: string;
  projectId?: string;
  projectName?: string;
  filePath?: string;
  onClose: () => void;
  onCreated?: (app: OrgApp) => void;
}

type Mode = 'choose' | 'workspace' | 'public';

interface ProjectOption {
  id: string;
  name: string;
}

interface DraftGrant {
  memberId: string;
  role: AppGrantRole;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultAppName(filePath: string | undefined): string {
  if (!filePath) return '';
  return filePath.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Untitled app';
}

export function CreateAppFlow({
  orgId,
  projectId: initialProjectId,
  projectName: initialProjectName,
  filePath: initialFilePath,
  onClose,
  onCreated,
}: CreateAppFlowProps) {
  const t = useT();
  const { organizations } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const orgName = organizations.find((org) => org.id === orgId)?.name ?? '';

  const lockedFile = Boolean(initialProjectId && initialFilePath);
  // Locked file (from the design you're looking at) → go straight to workspace
  // deploy form so "Deploy to workspace" is one confirm away.
  const [mode, setMode] = useState<Mode>(lockedFile ? 'workspace' : 'choose');

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
  const [grants, setGrants] = useState<DraftGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (accessMode !== 'restricted') return;
    void (async () => {
      try {
        setMembers(await fetchOrgMembers(orgId));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [accessMode, orgId]);

  const toggleGrant = (memberId: string, role: AppGrantRole) => {
    setGrants((prev) => {
      const existing = prev.find((g) => g.memberId === memberId);
      if (existing?.role === role) return prev.filter((g) => g.memberId !== memberId);
      const without = prev.filter((g) => g.memberId !== memberId);
      return [...without, { memberId, role }];
    });
  };

  const submitOrgApp = useCallback(async () => {
    if (!projectId || !filePath || !name.trim()) {
      setError(t('apps.create.needFile'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const app = await publishApp(orgId, {
        name: name.trim(),
        description: description.trim() || undefined,
        projectId,
        filePath,
        visibility: 'org',
        accessMode,
        pinned,
        ...(allowGmail ? { dataScopes: [{ table: APP_GMAIL_SCOPE_TABLE, mode: 'write' as const }] } : {}),
        ...(accessMode === 'restricted' ? { grants } : {}),
      });
      onCreated?.(app);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    accessMode,
    allowGmail,
    description,
    filePath,
    grants,
    name,
    onClose,
    onCreated,
    orgId,
    pinned,
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

      {mode === 'choose' ? (
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

      {mode === 'public' && (projectId || initialProjectId) && (filePath || initialFilePath) ? (
        <PublishPanel
          projectId={projectId || initialProjectId!}
          projectName={projectName || initialProjectName || name || 'App'}
          fileName={filePath || initialFilePath!}
          onClose={onClose}
        />
      ) : null}

      {mode === 'public' && !(projectId && filePath) && !lockedFile ? (
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

      {mode === 'workspace' ? (
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

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowGmail}
              onChange={(event) => setAllowGmail(event.target.checked)}
            />
            <span>{t('apps.create.gmailSend')}</span>
          </label>
          {allowGmail ? <p className={styles.hint}>{t('apps.create.gmailSendHint')}</p> : null}

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
                </div>
              ) : null}
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
