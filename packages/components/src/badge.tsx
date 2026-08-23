import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';

import { joinClassNames } from './class-names';
import styles from './badge.module.css';

/** Status vocabulary shared by every surface that shows record state.
 *
 * These are tones, not literal colors: `positive` means "settled, posted,
 * approved", `warning` means "waiting on a person", `danger` means "rejected
 * or failed". Keeping the vocabulary semantic is what lets a document status,
 * a ledger status, and an approval status read consistently without each
 * surface inventing its own palette. */
export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Renders a small filled dot before the label. */
  dot?: boolean;
}

const toneClassNames: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  positive: styles.positive,
  warning: styles.warning,
  danger: styles.danger,
  info: styles.info,
  accent: styles.accent,
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone = 'neutral', dot = false, children, ...props },
  ref,
) {
  return (
    <span ref={ref} className={joinClassNames(styles.badge, toneClassNames[tone], className)} {...props}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
});
