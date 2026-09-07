import { describe, expect, it } from 'vitest';

import { expandRecurrence } from '../src/workspace-data/recurrence.js';

describe('expandRecurrence', () => {
  it('returns the original event when there is no rule', () => {
    expect(expandRecurrence('2026-09-08T13:00:00.000Z', '2026-09-08T13:30:00.000Z', null, {
      from: '2026-09-01',
      to: '2026-09-30',
    })).toEqual([{ startsAt: '2026-09-08T13:00:00.000Z', endsAt: '2026-09-08T13:30:00.000Z' }]);
  });

  it('expands weekly BYDAY inside the window', () => {
    const occurrences = expandRecurrence(
      '2026-09-07T13:00:00',
      '2026-09-07T13:30:00',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      { from: '2026-09-07', to: '2026-09-18' },
    );
    expect(occurrences.map((item) => item.startsAt.slice(0, 10))).toEqual([
      '2026-09-07',
      '2026-09-09',
      '2026-09-14',
      '2026-09-16',
    ]);
  });

  it('honors COUNT', () => {
    const occurrences = expandRecurrence(
      '2026-09-01',
      '2026-09-02',
      'FREQ=DAILY;COUNT=3',
      { from: '2026-09-01', to: '2026-09-30' },
    );
    expect(occurrences).toHaveLength(3);
  });
});
