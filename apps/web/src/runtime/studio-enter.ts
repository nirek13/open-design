// First-prompt handoff from the hub composer into the project studio.
//
// The create request already covers the wait; this only wraps the *reveal*
// (swap EntryView for ProjectView) so the typed box can morph into the
// studio composer instead of vanishing. Reduced-motion and browsers without
// View Transitions skip the wrap and apply the same state update immediately.

import { flushSync } from 'react-dom';

const STUDIO_ENTER_CLASS = 'od-studio-enter';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function startViewTransition(
  doc: Document,
  update: () => void | Promise<void>,
): { finished: Promise<void> } | null {
  const start = (
    doc as Document & {
      startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> };
    }
  ).startViewTransition;
  if (typeof start !== 'function') return null;
  return start.call(doc, update);
}

export async function withStudioEnterTransition(
  update: () => void | Promise<void>,
): Promise<void> {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc || prefersReducedMotion()) {
    await update();
    return;
  }

  doc.documentElement.classList.add(STUDIO_ENTER_CLASS);
  const transition = startViewTransition(doc, async () => {
    await update();
    // `navigate()` notifies the router on a microtask. Flush once more so
    // the new snapshot is ProjectView, not the hub that just submitted.
    await Promise.resolve();
    flushSync(() => {});
  });

  try {
    if (!transition) {
      await update();
      return;
    }
    await transition.finished.catch(() => undefined);
  } finally {
    doc.documentElement.classList.remove(STUDIO_ENTER_CLASS);
  }
}
