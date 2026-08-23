import type { ReactNode } from 'react';

import { joinClassNames } from './class-names';
import styles from './empty-state.module.css';

export interface EmptyStateProps {
  /** Decorative glyph or icon. Hidden from assistive tech. */
  icon?: ReactNode;
  title: string;
  /** One sentence on what to do next — an empty state that only says
   * "nothing here" wastes the one moment the person is looking for guidance. */
  description?: string;
  action?: ReactNode;
  className?: string;
  size?: 'default' | 'compact';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  size = 'default',
}: EmptyStateProps) {
  return (
    <div
      className={joinClassNames(styles.root, size === 'compact' ? styles.compact : undefined, className)}
    >
      {icon ? (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
