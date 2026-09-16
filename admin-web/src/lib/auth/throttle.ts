/**
 * Login attempt throttling.
 *
 * A sliding window of failures per key (email plus client address), counted in
 * memory. It exists so that a password-guessing script cannot make unlimited
 * attempts at scrypt speed against a console that authorises agents against real
 * money.
 *
 * **It is not a security control, and saying so is more useful than implying a
 * guarantee it does not provide.** The state is per process, so it resets on
 * deploy, does not see attempts served by a sibling instance, and a client can
 * sidestep it by rotating the address it comes from. What it does stop is the
 * single-source script that is the realistic attempt against an internal console;
 * a real deployment puts a rate-limiting proxy in front of this as well.
 *
 * Written as a class so tests can drive time rather than sleep.
 */

export interface ThrottleOptions {
  /** Failures allowed inside the window before the key is locked out. */
  maxFailures?: number;
  /** Sliding window, and the lockout, in milliseconds. */
  windowMs?: number;
}

export class LoginThrottle {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, number[]>();

  constructor(options: ThrottleOptions = {}) {
    this.#maxFailures = options.maxFailures ?? 5;
    this.#windowMs = options.windowMs ?? 15 * 60_000;
  }

  isLockedOut(key: string, now: number = Date.now()): boolean {
    return this.#recent(key, now).length >= this.#maxFailures;
  }

  /** Retry delay in seconds, for a `Retry-After` header. Zero when not locked. */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const recent = this.#recent(key, now);
    if (recent.length < this.#maxFailures) return 0;
    const oldest = recent[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000));
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#failures.set(key, recent);
  }

  /** A successful sign-in clears the key, so one typo does not count toward a lockout. */
  recordSuccess(key: string): void {
    this.#failures.delete(key);
  }

  #recent(key: string, now: number): number[] {
    const cutoff = now - this.#windowMs;
    const pruned = (this.#failures.get(key) ?? []).filter((at) => at > cutoff);
    this.#failures.set(key, pruned);
    return pruned;
  }
}

/**
 * The process-wide instance.
 *
 * Held on `globalThis` so that a dev server reloading its modules does not hand a
 * guessing script a fresh allowance each time.
 */
const globalForThrottle = globalThis as unknown as { __remitbridgeLoginThrottle?: LoginThrottle };

export function loginThrottle(): LoginThrottle {
  globalForThrottle.__remitbridgeLoginThrottle ??= new LoginThrottle();
  return globalForThrottle.__remitbridgeLoginThrottle;
}
