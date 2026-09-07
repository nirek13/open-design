/** Whether this autosave snapshot is still allowed to replace the page body. */
export function canCommitPageBlocks(input: {
  snapshotJson: string;
  savedJson: string;
  savedJsonAtStart: string;
  updatedAtAtStart: number | null;
  currentUpdatedAt: number | null;
}): boolean {
  if (input.snapshotJson === input.savedJson) return false;
  if (input.savedJson !== input.savedJsonAtStart) return false;
  if (
    input.updatedAtAtStart != null &&
    input.currentUpdatedAt != null &&
    input.currentUpdatedAt > input.updatedAtAtStart
  ) {
    return false;
  }
  return true;
}

/** Serialize persist and embed so a stale PUT cannot delete a live chart. */
export function createPageWriteQueue(): {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
