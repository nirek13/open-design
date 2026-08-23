// Approvals.
//
// Every change an agent wants to make to company data arrives here first,
// described in plain language, and waits. That waiting is the product: an
// assistant that edits the books unsupervised is not trustworthy no matter
// how good it is.
//
// Three things this screen owes the person deciding: what would change, what
// it would affect, and a way back if they were wrong. Applied proposals keep
// their undo for exactly that reason.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@open-design/components';
import type { Proposal, ProposalStatus } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { decideProposal, fetchProposals } from '../../providers/registry';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { formatDateTime } from '../workspace/format';
import styles from './ApprovalsView.module.css';

interface Props {
  active: boolean;
}

type Filter = 'pending' | 'applied' | 'all';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toneFor(status: ProposalStatus) {
  if (status === 'pending') return 'warning' as const;
  if (status === 'applied') return 'positive' as const;
  if (status === 'rejected' || status === 'failed') return 'danger' as const;
  return 'neutral' as const;
}

export function ApprovalsView({ active }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [filter, setFilter] = useState<Filter>('pending');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      // Load everything once and filter in the browser: the list is small and
      // switching tabs should not feel like a page load.
      setProposals(await fetchProposals(activeOrgId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const shown = useMemo(() => {
    if (filter === 'all') return proposals;
    return proposals.filter((proposal) => proposal.status === filter);
  }, [proposals, filter]);

  const pendingCount = useMemo(
    () => proposals.filter((proposal) => proposal.status === 'pending').length,
    [proposals],
  );
  const appliedCount = useMemo(
    () => proposals.filter((proposal) => proposal.status === 'applied').length,
    [proposals],
  );

  async function act(proposal: Proposal, action: 'approve' | 'reject' | 'undo') {
    if (!activeOrgId || busyId) return;
    setBusyId(proposal.id);
    try {
      await decideProposal(activeOrgId, proposal.id, action);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <WorkspacePage
      testId="approvals-view"
      title={t('approvals.title')}
      lead={t('approvals.lead')}
      tabs={[
        { id: 'pending', label: t('approvals.tabPending'), count: pendingCount },
        { id: 'applied', label: t('approvals.tabApplied'), count: appliedCount },
        { id: 'all', label: t('approvals.tabAll'), count: proposals.length },
      ]}
      activeTab={filter}
      onTabChange={(id) => setFilter(id as Filter)}
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <div className={styles.list}>
          <Skeleton shape="block" height={110} />
          <Skeleton shape="block" height={110} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={
            filter === 'pending' ? t('approvals.emptyPending') : t('approvals.emptyOther')
          }
          description={filter === 'pending' ? t('approvals.emptyPendingBody') : undefined}
        />
      ) : (
        <ul className={styles.list}>
          {shown.map((proposal) => {
            const busy = busyId === proposal.id;
            return (
              <li key={proposal.id} className={styles.card} data-testid={`approval-${proposal.id}`}>
                <div className={styles.cardHead}>
                  <div className={styles.cardTitleWrap}>
                    <h2 className={styles.cardTitle}>{proposal.intent}</h2>
                    <p className={styles.cardMeta}>
                      {t(`approvals.origin_${proposal.origin}` as never)} ·{' '}
                      {formatDateTime(proposal.createdAt)}
                    </p>
                  </div>
                  <Badge tone={toneFor(proposal.status)} dot>
                    {t(`approvals.status_${proposal.status}` as never)}
                  </Badge>
                </div>

                {/* What would change, before it changes. */}
                <ul className={styles.preview}>
                  {proposal.preview.lines.map((line, index) => (
                    <li key={index} className={styles.previewLine}>
                      <span className={styles.previewSummary}>{line.summary}</span>
                      {line.detail ? <span className={styles.previewDetail}>{line.detail}</span> : null}
                    </li>
                  ))}
                </ul>

                {proposal.preview.warnings.length > 0 ? (
                  <ul className={styles.warnings}>
                    {proposal.preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                ) : null}

                {proposal.error ? <p className={styles.failure}>{proposal.error}</p> : null}

                <div className={styles.cardFoot}>
                  {proposal.status === 'pending' ? (
                    <>
                      <Button
                        variant="primary"
                        onClick={() => act(proposal, 'approve')}
                        disabled={busy}
                        data-testid="approval-approve"
                      >
                        {busy ? t('approvals.working') : t('approvals.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => act(proposal, 'reject')} disabled={busy}>
                        {t('approvals.reject')}
                      </Button>
                    </>
                  ) : null}
                  {proposal.status === 'applied' ? (
                    <>
                      <Button
                        onClick={() => act(proposal, 'undo')}
                        disabled={busy}
                        data-testid="approval-undo"
                      >
                        {busy ? t('approvals.working') : t('approvals.undo')}
                      </Button>
                      {/* Undo restores data but keeps a new field or table,
                          because dropping it would destroy whatever has been
                          stored there since. Saying so up front beats
                          surprising someone after the fact. */}
                      <span className={styles.footNote}>{t('approvals.undoNote')}</span>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}
