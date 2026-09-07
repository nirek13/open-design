import { describe, expect, it } from 'vitest';

import { BOOKING_DURATIONS } from '../src/api/calendar.js';

describe('calendar booking contracts', () => {
  it('offers Calendly-style meeting lengths', () => {
    expect(BOOKING_DURATIONS).toEqual([15, 30, 45, 60]);
  });
});
