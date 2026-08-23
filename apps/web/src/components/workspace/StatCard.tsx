// A single number worth looking at.
//
// Used for pinned answers on the workspace and for the totals across the top
// of the books. The value carries the visual weight; the label explains it.
// A stat with no answer yet shows a dash rather than a zero, because "we do
// not know" and "it is zero" are different facts.

import type { ReactNode } from 'react';
import styles from './StatCard.module.css';

interface Props {
  label: string;
  value: ReactNode;
  /** Secondary line under the value — a count, a period, a comparison. */
  detail?: string;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
  onClick?: () => void;
  testId?: string;
}

export function StatCard({ label, value, detail, tone = 'default', onClick, testId }: Props) {
  const className = `${styles.card}${tone !== 'default' ? ` ${styles[tone]}` : ''}${
    onClick ? ` ${styles.clickable}` : ''
  }`;

  const content = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} data-testid={testId}>
        {content}
      </button>
    );
  }

  return (
    <div className={className} data-testid={testId}>
      {content}
    </div>
  );
}
