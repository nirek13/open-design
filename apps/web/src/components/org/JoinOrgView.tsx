// The page a coworker lands on when they follow an invite link.
//
// It must work for someone who has never seen this product: name the
// organization before asking for anything, and explain plainly when the link
// no longer works instead of showing a generic error.

import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import type { OrgInvitePreview } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { acceptInvite, fetchInvitePreview } from '../../providers/registry';
import { navigate } from '../../router';
import styles from './JoinOrgView.module.css';

type Phase = 'loading' | 'ready' | 'joining' | 'joined' | 'failed';

export function JoinOrgView({ token }: { token: string }) {
  const t = useT();
  const { setActiveOrg, refresh } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [preview, setPreview] = useState<OrgInvitePreview | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchInvitePreview(token);
        if (cancelled) return;
        setPreview(result);
        setPhase(result.valid ? 'ready' : 'failed');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleJoin() {
    setPhase('joining');
    try {
      const result = await acceptInvite(token);
      await refresh();
      setPhase('joined');
      // Landing straight in the organization they just joined is the point of
      // following the link, so switch and go.
      setActiveOrg(result.organization.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  }

  const reasonKey =
    preview?.reason === 'expired'
      ? 'join.expired'
      : preview?.reason === 'revoked'
        ? 'join.revoked'
        : preview?.reason === 'exhausted'
          ? 'join.exhausted'
          : preview?.reason === 'wrong-recipient'
            ? 'join.wrongRecipient'
            : 'join.invalid';

  return (
    <div className={styles.root} data-testid="join-org-view">
      <div className={styles.card}>
        {phase === 'loading' ? <p className={styles.muted}>{t('join.loading')}</p> : null}

        {phase === 'ready' && preview ? (
          <>
            <p className={styles.eyebrow}>{t('join.eyebrow')}</p>
            <h1 className={styles.title}>{preview.orgName}</h1>
            <p className={styles.body}>
              {t('join.roleLine', { role: t(`org.role.${preview.role}` as never) })}
            </p>
            {preview.restricted ? <p className={styles.body}>{t('join.restrictedHint')}</p> : null}
            <Button variant="primary" onClick={handleJoin} data-testid="join-accept">
              {t('join.accept')}
            </Button>
          </>
        ) : null}

        {phase === 'joining' ? <p className={styles.muted}>{t('join.joining')}</p> : null}
        {phase === 'joined' ? <p className={styles.muted}>{t('join.joined')}</p> : null}

        {phase === 'failed' ? (
          <>
            <h1 className={styles.title}>{t('join.cannotJoin')}</h1>
            <p className={styles.body}>{error ?? t(reasonKey as never)}</p>
            <Button onClick={() => navigate({ kind: 'home', view: 'home' })}>
              {t('join.goHome')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
