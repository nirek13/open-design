// The company hub: a full-viewport ask box.
//
// Enter / Ask changes the company or starts visual work. Finding records
// lives on Search. Magic import lives in the page header, and dropping a
// spreadsheet anywhere on the hub opens it.
//
// Everything here is org-scoped. With no organization resolved the page shows
// its empty shape rather than failing, because the shell mounts this view
// whether or not the org layer answered yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button } from '@open-design/components';
import type { HubStatus, Proposal, WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  decideProposal,
  fetchHubStatus,
  fetchProposals,
  fetchWorkspaceTables,
  setUpHub,
} from '../../providers/registry';
import { navigate } from '../../router';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import { RecommendedStartRegion } from '../RecommendedStartRegion';
import type { Recommendation } from '../../onboarding/recommendation';
import type { OnboardingEntry } from '../../onboarding/onboarding-entry';
import type { ProjectMetadata } from '../../types';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { singularize } from '../workspace/format';
import { Icon } from '../Icon';
import { HubAskComposer } from './HubAskComposer';
import { RecordEditor } from './RecordEditor';
import { ToolBuilder } from './ToolBuilder';
import { LibraryUploadModal } from '../LibraryUploadModal';
import styles from './WorkspaceHome.module.css';

interface Props {
  active: boolean;
  defaultDesignSystemId?: string | null;
  initialPrompt?: string;
  onAskProject?: (
    payload: PluginLoopSubmit,
  ) => Promise<boolean | 'blocked' | void> | boolean | 'blocked' | void;
  recommendation?: Recommendation | null;
  onRecommendationStart?: (input: {
    name: string;
    prompt: string;
    metadata: ProjectMetadata;
    onboardingEntry: OnboardingEntry;
  }) => boolean | void | Promise<boolean | void>;
  onRecommendationDismiss?: () => void;
}

/** The documents a business runs on, in the order work flows through them. */
const DOCUMENT_TABLES = ['quotes', 'orders', 'invoices', 'payments'];
const HUB_TABLES = [...DOCUMENT_TABLES, 'customers'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.types).includes('Files');
}

function firstDroppedFile(dataTransfer: DataTransfer | null | undefined): File | null {
  const file = dataTransfer?.files?.[0];
  return file ?? null;
}

export function WorkspaceHome({
  active,
  defaultDesignSystemId,
  initialPrompt,
  onAskProject,
  recommendation,
  onRecommendationStart,
  onRecommendationDismiss,
}: Props) {
  const t = useT();
  // The entry shell mounts this view, so it must survive rendering without a
  // provider above it — every load path below already treats a null org as
  // "nothing to show yet", which is the right thing to fall back to.
  const { activeOrgId, activeOrg, auth } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const greetingName = auth?.viewer?.displayName?.trim().split(/\s+/)[0] ?? '';

  const [query, setQuery] = useState(initialPrompt ?? '');
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<{ tableRef: string; recordId?: string } | null>(null);
  const [buildingTool, setBuildingTool] = useState(false);
  const [builderMode, setBuilderMode] = useState<'choose' | 'import'>('choose');
  const [importSeedUrl, setImportSeedUrl] = useState<string | null>(null);
  const [importSeedFile, setImportSeedFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [nextTables, nextHub, nextProposals] = await Promise.all([
        fetchWorkspaceTables(activeOrgId),
        fetchHubStatus(activeOrgId),
        fetchProposals(activeOrgId, 'pending'),
      ]);
      setTables(nextTables);
      setHub(nextHub);
      setProposals(nextProposals);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  useEffect(() => {
    if (initialPrompt) setQuery(initialPrompt);
  }, [initialPrompt]);

  useEffect(() => {
    if (!createOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (createMenuRef.current && target && createMenuRef.current.contains(target)) return;
      setCreateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreateOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [createOpen]);

  useEffect(() => {
    if (!active || uploading) {
      setDropping(false);
      return;
    }
    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    };
    const onDrop = (event: DragEvent) => {
      const file = firstDroppedFile(event.dataTransfer);
      if (!file) {
        setDropping(false);
        return;
      }
      event.preventDefault();
      setDropping(false);
      setImportSeedUrl(null);
      setImportSeedFile(file);
      setBuilderMode('import');
      setBuildingTool(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (
        event.clientX <= 0
        || event.clientY <= 0
        || event.clientX >= window.innerWidth
        || event.clientY >= window.innerHeight
      ) {
        setDropping(false);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onDragLeave);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onDragLeave);
    };
  }, [active, uploading]);

  const documentTables = useMemo(
    () => DOCUMENT_TABLES.map((name) => tables.find((table) => table.name === name)).filter(Boolean) as WorkspaceTable[],
    [tables],
  );
  const customTables = useMemo(
    () => tables.filter((table) => !HUB_TABLES.includes(table.name)),
    [tables],
  );

  async function handleSetUpHub() {
    if (!activeOrgId || busy) return;
    setBusy(true);
    try {
      await setUpHub(activeOrgId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecide(proposal: Proposal, decision: 'approve' | 'reject') {
    if (!activeOrgId) return;
    try {
      await decideProposal(activeOrgId, proposal.id, decision);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function openCreate(action: () => void) {
    setCreateOpen(false);
    action();
  }

  const createItems = [
    ...documentTables.map((table) => ({
      key: table.id,
      testId: `workspace-new-${table.name}`,
      label: t('workspace.newOf', { name: singularize(table.displayName || table.name) }),
      onClick: () => openCreate(() => setEditing({ tableRef: table.name })),
    })),
    ...customTables.map((table) => ({
      key: table.id,
      testId: `workspace-new-${table.name}`,
      label: t('workspace.newOf', { name: singularize(table.displayName || table.name) }),
      onClick: () => openCreate(() => setEditing({ tableRef: table.name })),
    })),
    {
      key: 'build',
      testId: 'workspace-build-tool',
      label: t('workspace.buildTool'),
      onClick: () => openCreate(() => {
        setImportSeedUrl(null);
        setBuilderMode('choose');
        setBuildingTool(true);
      }),
    },
    {
      key: 'upload',
      testId: 'workspace-upload-assets',
      label: t('workspace.uploadAssets'),
      onClick: () => openCreate(() => setUploading(true)),
    },
  ];

  function openMagicImport() {
    setImportSeedUrl(null);
    setImportSeedFile(null);
    setBuilderMode('import');
    setBuildingTool(true);
  }

  async function handleAskProject(payload: PluginLoopSubmit) {
    if (!onAskProject) return;
    try {
      const result = await onAskProject(payload);
      if (result === 'blocked' || result === false) setLaunching(false);
      return result;
    } catch (err) {
      setLaunching(false);
      throw err;
    }
  }

  return (
    <>
      <WorkspacePage
      testId="workspace-home"
      fill
      studio
      launching={launching}
      eyebrow={activeOrg?.name}
      title={t('workspace.title')}
      lead={t('workspace.subtitle')}
      actions={
        <div className={styles.headActions}>
          {hub && !hub.ready ? (
            <Button
              variant="ghost"
              data-testid="workspace-hub-setup"
              onClick={() => void handleSetUpHub()}
              disabled={busy}
            >
              {busy ? t('workspace.settingUp') : t('workspace.setUpAction')}
            </Button>
          ) : null}
          <Button
            className={styles.importBtn}
            data-testid="workspace-magic-import"
            title={t('workspace.magicImportHint')}
            onClick={openMagicImport}
          >
            <Icon name="sparkles" size={16} />
            {t('workspace.magicImport')}
          </Button>
          <div className={styles.createMenuWrap} ref={createMenuRef}>
          <Button
            variant="ghost"
            onClick={() => setCreateOpen((open) => !open)}
            aria-expanded={createOpen}
            aria-haspopup="menu"
            data-testid="workspace-create"
          >
            {t('workspace.createTitle')}
          </Button>
          {createOpen ? (
            <div className={styles.createMenu} role="menu" data-testid="workspace-create-menu">
              {createItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={styles.createMenuItem}
                  role="menuitem"
                  data-testid={item.testId}
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          </div>
        </div>
      }
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {proposals.length > 0 ? (
        <WorkspaceSection
          title={t('workspace.needsYou')}
          action={<Badge tone="warning">{proposals.length}</Badge>}
          testId="workspace-proposals"
        >
          <ul className={styles.proposalList}>
            {proposals.map((proposal) => (
              <li key={proposal.id} className={styles.proposal}>
                <div className={styles.proposalBody}>
                  <span className={styles.proposalIntent}>{proposal.intent}</span>
                  {/* The preview is the point: approving is a decision about a
                      described outcome, never a leap of faith. */}
                  <ul className={styles.proposalLines}>
                    {proposal.preview.lines.slice(0, 3).map((line, index) => (
                      <li key={index} className={styles.proposalLine}>
                        {line.summary}
                        {line.detail ? <em className={styles.proposalDetail}> — {line.detail}</em> : null}
                      </li>
                    ))}
                  </ul>
                  {proposal.preview.warnings.length > 0 ? (
                    <span className={styles.proposalWarning}>
                      {proposal.preview.warnings[0]}
                    </span>
                  ) : null}
                </div>
                <div className={styles.proposalActions}>
                  <Button variant="primary" onClick={() => handleDecide(proposal, 'approve')}>
                    {t('workspace.approve')}
                  </Button>
                  <Button variant="ghost" onClick={() => handleDecide(proposal, 'reject')}>
                    {t('workspace.reject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </WorkspaceSection>
      ) : null}

      {recommendation && onRecommendationStart && onRecommendationDismiss ? (
        <RecommendedStartRegion
          recommendation={recommendation}
          onStart={onRecommendationStart}
          onDismiss={onRecommendationDismiss}
        />
      ) : null}

      <div
        className={`${styles.stage}${launching ? ` ${styles.stageLaunching}` : ''}`}
        {...(launching ? { 'data-launching': 'true' } : {})}
      >
        <div className={styles.atmosphere} aria-hidden data-testid="home-atmosphere">
          <span className={styles.orbLamp} />
          <span className={styles.orbLeft} />
          <span className={styles.orbRight} />
          <span className={styles.ring} />
          <span className={styles.grain} />
        </div>
        <HubAskComposer
          orgId={activeOrgId}
          value={query}
          onChange={setQuery}
          greetingName={greetingName}
          defaultDesignSystemId={defaultDesignSystemId}
          hero
          launching={launching}
          onStudioLaunch={() => setLaunching(true)}
          {...(onAskProject ? { onAskProject: handleAskProject } : {})}
          onProposalCreated={load}
          onImportUrl={(url) => {
            setImportSeedFile(null);
            setImportSeedUrl(url);
            setBuilderMode('import');
            setBuildingTool(true);
          }}
        />
      </div>

      {editing ? (
        <RecordEditor
          tableRef={editing.tableRef}
          {...(editing.recordId ? { recordId: editing.recordId } : {})}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}

      {buildingTool ? (
        <ToolBuilder
          initialMode={builderMode}
          {...(importSeedUrl ? { initialUrl: importSeedUrl } : {})}
          {...(importSeedFile ? { initialFile: importSeedFile } : {})}
          onClose={() => {
            setBuildingTool(false);
            setImportSeedUrl(null);
            setImportSeedFile(null);
          }}
          onCreated={async () => {
            setBuildingTool(false);
            setImportSeedUrl(null);
            setImportSeedFile(null);
            await load();
          }}
          onReload={load}
          {...(onAskProject ? { onAskProject: handleAskProject } : {})}
        />
      ) : null}

      {uploading ? (
        <LibraryUploadModal
          seedFiles={null}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            navigate({ kind: 'home', view: 'library' });
          }}
        />
      ) : null}
      </WorkspacePage>
      {dropping
        ? createPortal(
            <div className={styles.dropOverlay} data-testid="workspace-import-drop" aria-hidden>
              <span className={styles.dropOverlayCard}>
                <Icon name="sparkles" size={22} />
                {t('workspace.dropToImport')}
              </span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
