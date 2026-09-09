// A token bucket, in memory, keyed by whatever the caller wants to limit.
//
// Chat is the first surface here that a single client can drive as fast as it
// can loop: a composer with a stuck key, a script posting in a while-loop, an
// integration retrying a failed webhook without backoff. None of those are
// attacks, and all of them can fill a database and wake every connected tab a
// thousand times a second.
//
// A bucket rather than a fixed window, because a fixed window punishes the
// ordinary case — sending three messages in quick succession is normal and
// should never be refused, while three hundred is not. Tokens refill
// continuously, so a burst is allowed and a sustained flood is not.
//
// In memory on purpose: the limit exists to protect this process, and a
// process that restarts starts from a clean slate, which is the right answer
// for a laptop daemon. A hosted deployment that needs a shared limit belongs
// behind a proxy that has one.

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitRule {
  /** Bucket size — how much can be spent at once after being idle. */
  burst: number;
  /** Tokens added per second. The sustained rate. */
  refillPerSecond: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until one token is available. 0 when allowed. */
  retryAfter: number;
  remaining: number;
}

/** Sweep buckets that have been full and untouched for this long. A full
 * bucket is indistinguishable from a missing one, so keeping it is pure
 * memory. */
const IDLE_EVICT_MS = 10 * 60_000;

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #rules: Record<string, RateLimitRule>;
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(rules: Record<string, RateLimitRule>) {
    this.#rules = rules;
  }

  start(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), IDLE_EVICT_MS);
    this.#sweeper.unref?.();
  }

  stop(): void {
    if (!this.#sweeper) return;
    clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /** Spend one token against `action` for `subject`. An unknown action is
   * allowed rather than denied: a limiter is a guard rail, and a typo in a
   * rule name must not silently make a feature unusable. */
  take(action: string, subject: string, now = Date.now()): RateLimitVerdict {
    const rule = this.#rules[action];
    if (!rule) return { allowed: true, retryAfter: 0, remaining: Number.POSITIVE_INFINITY };
    this.start();

    const key = `${action}\u0000${subject}`;
    const bucket = this.#buckets.get(key) ?? { tokens: rule.burst, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    const tokens = Math.min(rule.burst, bucket.tokens + elapsed * rule.refillPerSecond);

    if (tokens < 1) {
      // Round up: telling someone to retry in 0 seconds when they cannot is
      // how a client ends up in a tight retry loop against the limiter.
      const retryAfter = Math.ceil((1 - tokens) / rule.refillPerSecond);
      this.#buckets.set(key, { tokens, updatedAt: now });
      return { allowed: false, retryAfter: Math.max(1, retryAfter), remaining: 0 };
    }

    this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true, retryAfter: 0, remaining: Math.floor(tokens - 1) };
  }

  /** Give a token back. Used when the work a token was spent on turned out not
   * to happen — a validation failure should not cost someone their budget. */
  refund(action: string, subject: string): void {
    const rule = this.#rules[action];
    if (!rule) return;
    const key = `${action}\u0000${subject}`;
    const bucket = this.#buckets.get(key);
    if (!bucket) return;
    bucket.tokens = Math.min(rule.burst, bucket.tokens + 1);
  }

  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.#buckets) {
      const rule = this.#rules[key.split('\u0000')[0] ?? ''];
      if (!rule) {
        this.#buckets.delete(key);
        continue;
      }
      const elapsed = (now - bucket.updatedAt) / 1000;
      if (bucket.tokens + elapsed * rule.refillPerSecond >= rule.burst && now - bucket.updatedAt > IDLE_EVICT_MS) {
        this.#buckets.delete(key);
      }
    }
  }
}

/** The chat limits.
 *
 * Numbers chosen so a person never meets them and a loop always does. Twenty
 * messages back to back is a heated conversation; two a second sustained is
 * not a person. Reactions are cheaper and noisier, so the burst is larger.
 * Uploads are bounded by bandwidth long before this, and the low ceiling is
 * about disk rather than about rate. */
export const CHAT_RATE_RULES: Record<string, RateLimitRule> = {
  'chat:post': { burst: 20, refillPerSecond: 2 },
  'chat:react': { burst: 40, refillPerSecond: 5 },
  'chat:upload': { burst: 10, refillPerSecond: 0.5 },
  'chat:typing': { burst: 30, refillPerSecond: 3 },
  'chat:webhook': { burst: 30, refillPerSecond: 1 },
  'chat:search': { burst: 20, refillPerSecond: 2 },
};
