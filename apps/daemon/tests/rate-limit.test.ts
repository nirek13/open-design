import { describe, expect, it } from 'vitest';

import { CHAT_RATE_RULES, RateLimiter } from '../src/services/rate-limit.js';

describe('the rate limiter', () => {
  it('lets a burst through and then refuses', () => {
    // Three messages in quick succession is a heated conversation and must
    // never be blocked; three hundred is a loop.
    const limiter = new RateLimiter({ test: { burst: 3, refillPerSecond: 1 } });
    const now = Date.now();
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(true);
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(true);
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(true);

    const refused = limiter.take('test', 'wsm-a', now);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills continuously rather than in fixed windows', () => {
    const limiter = new RateLimiter({ test: { burst: 2, refillPerSecond: 1 } });
    const now = Date.now();
    limiter.take('test', 'wsm-a', now);
    limiter.take('test', 'wsm-a', now);
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(false);
    expect(limiter.take('test', 'wsm-a', now + 1_100).allowed).toBe(true);
  });

  it('never reports a retry of zero seconds to a caller it just refused', () => {
    // Rounding down here is how a client ends up in a tight retry loop against
    // the limiter that is trying to slow it down.
    const limiter = new RateLimiter({ test: { burst: 1, refillPerSecond: 100 } });
    const now = Date.now();
    limiter.take('test', 'wsm-a', now);
    expect(limiter.take('test', 'wsm-a', now).retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('keeps one subject\'s budget away from another\'s', () => {
    const limiter = new RateLimiter({ test: { burst: 1, refillPerSecond: 0.1 } });
    const now = Date.now();
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(true);
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(false);
    expect(limiter.take('test', 'wsm-b', now).allowed).toBe(true);
  });

  it('allows an action nobody wrote a rule for', () => {
    // A typo in a rule name must not silently make a feature unusable. A
    // limiter is a guard rail, not a gate.
    const limiter = new RateLimiter({});
    expect(limiter.take('never-configured', 'wsm-a').allowed).toBe(true);
  });

  it('gives a token back when the work it paid for did not happen', () => {
    const limiter = new RateLimiter({ test: { burst: 1, refillPerSecond: 0.01 } });
    const now = Date.now();
    limiter.take('test', 'wsm-a', now);
    limiter.refund('test', 'wsm-a');
    expect(limiter.take('test', 'wsm-a', now).allowed).toBe(true);
  });

  it('ships chat limits a person will not meet', () => {
    // Twenty messages back to back without being stopped, which is more than
    // anybody types before pausing.
    const limiter = new RateLimiter(CHAT_RATE_RULES);
    const now = Date.now();
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.take('chat:post', 'wsm-a', now).allowed).toBe(true);
    }
    expect(limiter.take('chat:post', 'wsm-a', now).allowed).toBe(false);
  });
});
