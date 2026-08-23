import type { CSSProperties } from 'react';

import { joinClassNames } from './class-names';
import styles from './skeleton.module.css';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  /** Pill for text lines, block for cards and thumbnails. */
  shape?: 'line' | 'block' | 'circle';
  className?: string;
  style?: CSSProperties;
}

/** A loading placeholder shaped like the content it stands in for.
 *
 * Shown instead of a spinner so the layout does not jump when real content
 * lands. Marked aria-hidden with role="presentation": a screen reader should
 * hear the loading status from the region's own live text, not from a stack of
 * meaningless boxes. */
export function Skeleton({ width, height, shape = 'line', className, style }: SkeletonProps) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      className={joinClassNames(styles.skeleton, styles[shape], className)}
      style={{ width, height, ...style }}
    />
  );
}
