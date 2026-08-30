/**
 * Retry with exponential back-off and jitter.
 *
 * Ported verbatim (behavior-for-behavior) from
 * `examples/keeper-bot/index.js`'s `withRetry` (issue 0188 in the SDK epic)
 * — the bot's own hand-rolled version is the reference this function is
 * lifted from, so migrating the bot onto this export is a like-for-like
 * swap, not a behavior change.
 *
 * Only transient failures should be retried. A caller supplies
 * `isPermanentError` to distinguish "this can never succeed, stop now" from
 * "this might succeed on the next attempt" — the SDK has no opinion of its
 * own about which errors are which, since that classification is specific
 * to each contract's error surface.
 */

export interface RetryOptions {
  /** Number of retries AFTER the first attempt. Total attempts = maxRetries + 1. */
  readonly maxRetries: number;
  /** Base delay in milliseconds; each attempt's delay is `retryBaseMs * 2^attempt` plus jitter. */
  readonly retryBaseMs: number;
  /**
   * Returns true for an error that should never be retried (e.g. a
   * deterministic contract rejection). Defaults to "never permanent" — i.e.
   * every error is retried until `maxRetries` is exhausted — since the SDK
   * cannot know a specific contract's error surface without being told.
   */
  readonly isPermanentError?: (error: unknown) => boolean;
  /** Injectable sleep, so callers (and this package's own tests) can drive retries without real waiting. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Called before each retry's sleep, with the attempt number (0-indexed) and the delay chosen. Useful for logging. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` up to `options.maxRetries` additional times on transient
 * failure, with exponential back-off (`retryBaseMs * 2^attempt`) plus
 * jitter (`random() * retryBaseMs`) between attempts.
 *
 * A permanent error (per `options.isPermanentError`) is thrown immediately
 * without retrying. The final attempt's error is thrown as-is if every
 * attempt fails.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxRetries,
    retryBaseMs,
    isPermanentError = () => false,
    sleepFn = defaultSleep,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isPermanentError(error) || attempt === maxRetries) {
        throw error;
      }
      const backoff = retryBaseMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * retryBaseMs);
      const delay = backoff + jitter;
      onRetry?.(attempt, delay, error);
      await sleepFn(delay);
    }
  }
  // Unreachable: the loop above always returns or throws. Kept for type
  // completeness (TypeScript cannot see the loop is exhaustive).
  throw lastError;
}
