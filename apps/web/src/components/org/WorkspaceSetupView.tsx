// After sign-up: join a workspace or create one, then (for a new workspace)
// pull branding from the company website and offer a first import so the
// company is not dropped into an empty database.
//
// This has to work for someone who has never seen the product. Two clear
// choices, a paste field that accepts a link or a code, a website step
// that can be skipped, and a data step that accepts a spreadsheet, a public
// page, or a connector — also skippable.

import { useEffect, useState } from 'react';
import { Button, Input } from '@open-design/components';
import { parseJoinInput } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  acceptInvite,
  fetchBrandDetail,
  fetchInvitePreview,
  fetchPendingInvites,
  acceptPendingInvite,
  startBrandExtract,
  updateOrganization,
} from '../../providers/registry';
import { navigate } from '../../router';
import { OrgMark } from './OrgMark';
import { SetupDataImport } from './SetupDataImport';
import styles from './WorkspaceSetupView.module.css';

type Step = 'choose' | 'join' | 'create' | 'brand' | 'import';

interface Props {
  onApplyDesignSystem?: (designSystemId: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function WorkspaceSetupView({ onApplyDesignSystem }: Props) {
  const t = useT();
  const org = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const pendingSetup = Boolean(
    org.activeOrg && org.role === 'owner' && !org.activeOrg.setupCompletedAt,
  );
  const [step, setStep] = useState<Step>(() =>
    pendingSetup ? (org.activeOrg?.websiteUrl ? 'import' : 'brand') : 'choose',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [orgName, setOrgName] = useState('');
  const [website, setWebsite] = useState('');
  const [designSystemId, setDesignSystemId] = useState<string | null>(
    org.activeOrg?.defaultDesignSystemId ?? null,
  );
  const [pending, setPending] = useState<Array<{ id: string; orgName: string }>>([]);

  useEffect(() => {
    if (!pendingSetup) return;
    setStep((current) => {
      if (current === 'brand' || current === 'import') return current;
      return org.activeOrg?.websiteUrl ? 'import' : 'brand';
    });
  }, [pendingSetup, org.activeOrg?.websiteUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const invites = await fetchPendingInvites();
        if (!cancelled) setPending(invites.map((invite) => ({ id: invite.id, orgName: invite.orgName })));
      } catch {
        if (!cancelled) setPending([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleJoin() {
    const token = parseJoinInput(joinInput);
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await fetchInvitePreview(token);
      if (!preview.valid) {
        setError(t('setup.joinInvalid'));
        return;
      }
      const result = await acceptInvite(token);
      await org.refresh();
      org.setActiveOrg(result.organization.id);
      navigate({ kind: 'home', view: 'workspace' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptPending(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptPendingInvite(id);
      await org.refresh();
      org.setActiveOrg(result.organization.id);
      navigate({ kind: 'home', view: 'workspace' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const name = orgName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await org.createOrganization(name);
      if (!created) {
        setError(t('setup.createFailed'));
        return;
      }
      setStep('brand');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishSetup(dest: {
    view: 'workspace' | 'tables' | 'integrations';
    tableName?: string;
  }) {
    const orgId = org.activeOrgId;
    if (!orgId) return;
    await updateOrganization(orgId, {
      ...(website.trim() ? { websiteUrl: normalizeWebsite(website) } : {}),
      ...(designSystemId ? { defaultDesignSystemId: designSystemId } : {}),
      setupCompleted: true,
    });
    if (designSystemId) onApplyDesignSystem?.(designSystemId);
    await org.refresh();
    navigate({ kind: 'home', ...dest });
  }

  async function goToImport(nextDesignSystemId: string | null) {
    const orgId = org.activeOrgId;
    if (orgId && website.trim()) {
      await updateOrganization(orgId, {
        websiteUrl: normalizeWebsite(website),
        ...(nextDesignSystemId ? { defaultDesignSystemId: nextDesignSystemId } : {}),
      });
      await org.refresh();
    }
    setDesignSystemId(nextDesignSystemId);
    setStep('import');
  }

  async function handleBrand() {
    const url = normalizeWebsite(website);
    const orgId = org.activeOrgId;
    if (!url || !orgId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await startBrandExtract(url);
      let extractedId = started.designSystemId ?? null;
      const deadline = Date.now() + 45_000;
      while (!extractedId && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const detail = await fetchBrandDetail(started.id);
        extractedId = detail.meta.designSystemId ?? null;
        if (detail.meta.status === 'ready' || detail.meta.status === 'failed') break;
      }
      await goToImport(extractedId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSkipBrand() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await goToImport(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish(
    dest: { view: 'workspace' | 'tables' | 'integrations'; tableName?: string },
  ) {
    setBusy(true);
    setError(null);
    try {
      await finishSetup(dest);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const orgId = org.activeOrgId;
  const markWebsite = step === 'brand' ? website : org.activeOrg?.websiteUrl || website;

  return (
    <div className={styles.root} data-testid="workspace-setup">
      <div className={step === 'import' ? `${styles.card} ${styles.cardWide}` : styles.card}>
        <OrgMark
          orgId={step === 'import' ? orgId : null}
          markVersion={org.activeOrg?.updatedAt}
          websiteUrl={step === 'brand' || step === 'import' ? markWebsite : null}
          className={styles.logo}
          size={64}
          data-testid="setup-logo"
        />
        {step === 'choose' ? (
          <>
            <p className={styles.eyebrow}>{t('setup.eyebrow')}</p>
            <h1 className={styles.title}>{t('setup.title')}</h1>
            <p className={styles.body}>{t('setup.subtitle')}</p>
            <button
              type="button"
              className={styles.choice}
              onClick={() => {
                setError(null);
                setStep('join');
              }}
              data-testid="setup-choose-join"
            >
              <span className={styles.choiceName}>{t('setup.joinChoice')}</span>
              <span className={styles.choiceHint}>{t('setup.joinChoiceHint')}</span>
            </button>
            <button
              type="button"
              className={styles.choice}
              onClick={() => {
                setError(null);
                setStep('create');
              }}
              data-testid="setup-choose-create"
            >
              <span className={styles.choiceName}>{t('setup.createChoice')}</span>
              <span className={styles.choiceHint}>{t('setup.createChoiceHint')}</span>
            </button>
            {pending.length > 0 ? (
              <div className={styles.pending} data-testid="setup-pending">
                <p className={styles.pendingLabel}>{t('setup.pendingTitle')}</p>
                {pending.map((invite) => (
                  <div key={invite.id} className={styles.pendingRow}>
                    <span>{invite.orgName}</span>
                    <Button
                      variant="primary"
                      onClick={() => void handleAcceptPending(invite.id)}
                      disabled={busy}
                    >
                      {t('org.acceptInvite')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'join' ? (
          <>
            <p className={styles.eyebrow}>{t('setup.eyebrow')}</p>
            <h1 className={styles.title}>{t('setup.joinTitle')}</h1>
            <p className={styles.body}>{t('setup.joinHint')}</p>
            <Input
              value={joinInput}
              placeholder={t('setup.joinPlaceholder')}
              onChange={(event) => setJoinInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleJoin();
              }}
              data-testid="setup-join-input"
            />
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setStep('choose')} disabled={busy}>
                {t('setup.back')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleJoin()}
                disabled={!joinInput.trim() || busy}
                data-testid="setup-join-submit"
              >
                {t('setup.joinSubmit')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'create' ? (
          <>
            <p className={styles.eyebrow}>{t('setup.eyebrow')}</p>
            <h1 className={styles.title}>{t('setup.createTitle')}</h1>
            <p className={styles.body}>{t('setup.createHint')}</p>
            <Input
              value={orgName}
              placeholder={t('setup.createPlaceholder')}
              onChange={(event) => setOrgName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
              }}
              data-testid="setup-create-name"
            />
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setStep('choose')} disabled={busy}>
                {t('setup.back')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleCreate()}
                disabled={!orgName.trim() || busy}
                data-testid="setup-create-submit"
              >
                {t('setup.createSubmit')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'brand' ? (
          <>
            <p className={styles.eyebrow}>{org.activeOrg?.name ?? t('setup.eyebrow')}</p>
            <h1 className={styles.title}>{t('setup.brandTitle')}</h1>
            <p className={styles.body}>{t('setup.brandHint')}</p>
            <Input
              type="url"
              value={website}
              placeholder={t('setup.brandPlaceholder')}
              onChange={(event) => setWebsite(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleBrand();
              }}
              data-testid="setup-brand-url"
            />
            <div className={styles.actions}>
              <Button
                variant="ghost"
                onClick={() => void handleSkipBrand()}
                disabled={busy}
                data-testid="setup-brand-skip"
              >
                {t('setup.brandSkip')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleBrand()}
                disabled={!website.trim() || busy}
                data-testid="setup-brand-submit"
              >
                {busy ? t('setup.brandWorking') : t('setup.brandSubmit')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'import' && orgId ? (
          <SetupDataImport
            orgId={orgId}
            busy={busy}
            onBusy={setBusy}
            onImported={(tableName) => handleFinish({ view: 'tables', tableName })}
            onSkip={() => handleFinish({ view: 'workspace' })}
            onConnect={() => handleFinish({ view: 'integrations' })}
          />
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
