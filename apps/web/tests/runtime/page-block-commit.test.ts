import { describe, expect, it } from 'vitest';
import { canCommitPageBlocks, createPageWriteQueue } from '../../src/runtime/page-block-commit';

describe('canCommitPageBlocks', () => {
  it('refuses a no-op replace', () => {
    expect(
      canCommitPageBlocks({
        snapshotJson: '[{"type":"paragraph"}]',
        savedJson: '[{"type":"paragraph"}]',
        savedJsonAtStart: '[{"type":"paragraph"}]',
        updatedAtAtStart: 1,
        currentUpdatedAt: 1,
      }),
    ).toBe(false);
  });

  it('refuses a stale draft after a live embed landed', () => {
    expect(
      canCommitPageBlocks({
        snapshotJson: '[{"type":"paragraph"}]',
        savedJson: '[{"type":"paragraph"},{"type":"embed"}]',
        savedJsonAtStart: '[{"type":"paragraph"}]',
        updatedAtAtStart: 1,
        currentUpdatedAt: 50,
      }),
    ).toBe(false);
  });

  it('allows a real user edit of the current body', () => {
    expect(
      canCommitPageBlocks({
        snapshotJson: '[{"type":"paragraph","content":"Hi"}]',
        savedJson: '[{"type":"paragraph","content":"Welcome"}]',
        savedJsonAtStart: '[{"type":"paragraph","content":"Welcome"}]',
        updatedAtAtStart: 50,
        currentUpdatedAt: 50,
      }),
    ).toBe(true);
  });
});

describe('createPageWriteQueue', () => {
  it('runs persist and embed one after another', async () => {
    const queue = createPageWriteQueue();
    const order: string[] = [];
    let releasePersist: () => void = () => {};
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persist = queue.enqueue(async () => {
      order.push('persist-start');
      await persistGate;
      order.push('persist-end');
    });
    const embed = queue.enqueue(async () => {
      order.push('embed');
    });
    await Promise.resolve();
    expect(order).toEqual(['persist-start']);
    releasePersist();
    await Promise.all([persist, embed]);
    expect(order).toEqual(['persist-start', 'persist-end', 'embed']);
  });
});
