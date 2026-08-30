import { describe, it } from "node:test";
import assert from "node:assert";
import { withRetry } from "../src/retry.js";

const BASE_MS = 100;

function policy(overrides: Partial<Parameters<typeof withRetry>[1]> = {}) {
  const delays: number[] = [];
  const options = {
    maxRetries: 3,
    retryBaseMs: BASE_MS,
    sleepFn: async (ms: number) => {
      delays.push(ms);
    },
    ...overrides,
  };
  return { options, delays };
}

describe("withRetry", () => {
  it("returns immediately on first success", async () => {
    const { options } = policy();
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      return "success";
    }, options);

    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 1);
  });

  it("retries a transient failure and succeeds", async () => {
    const { options, delays } = policy();
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "success";
    }, options);

    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 3);
    assert.strictEqual(delays.length, 2);
  });

  it("applies exponential back-off between attempts", async () => {
    // maxRetries: 3 allows 4 total attempts (indices 0..3); succeeding on
    // the 4th means the first 3 attempts (indices 0, 1, 2) each fail and
    // sleep once, producing exactly 3 delays to inspect.
    const { options, delays } = policy({ maxRetries: 3 });
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts <= 3) throw new Error("transient");
      return "ok";
    }, options);

    // backoff = retryBaseMs * 2^attempt, plus jitter in [0, retryBaseMs)
    assert.strictEqual(delays.length, 3);
    const [first, second, third] = delays as [number, number, number];
    assert.ok(first >= BASE_MS && first < BASE_MS * 2);
    assert.ok(second >= BASE_MS * 2 && second < BASE_MS * 3);
    assert.ok(third >= BASE_MS * 4 && third < BASE_MS * 5);
  });

  it("throws immediately on a permanent error without retrying", async () => {
    const { options, delays } = policy({
      isPermanentError: (err) => (err as Error).message === "permanent",
    });
    let attempts = 0;

    await assert.rejects(
      () =>
        withRetry(async () => {
          attempts++;
          throw new Error("permanent");
        }, options),
      /permanent/,
    );
    assert.strictEqual(attempts, 1);
    assert.strictEqual(delays.length, 0);
  });

  it("throws the last error after exhausting maxRetries", async () => {
    const { options } = policy({ maxRetries: 2 });
    let attempts = 0;

    await assert.rejects(
      () =>
        withRetry(async () => {
          attempts++;
          throw new Error(`attempt ${attempts}`);
        }, options),
      /attempt 3/,
    );
    assert.strictEqual(attempts, 3); // initial + 2 retries
  });

  it("treats every error as transient when isPermanentError is not provided", async () => {
    const { options } = policy({ maxRetries: 1, isPermanentError: undefined });
    let attempts = 0;

    await assert.rejects(() =>
      withRetry(async () => {
        attempts++;
        throw new Error("boom");
      }, options),
    );
    assert.strictEqual(attempts, 2); // it retried once rather than stopping immediately
  });

  it("calls onRetry with the attempt number and computed delay before sleeping", async () => {
    const calls: Array<{ attempt: number; delayMs: number }> = [];
    const { options } = policy({
      onRetry: (attempt, delayMs) => calls.push({ attempt, delayMs }),
    });
    let attempts = 0;

    await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
      return "ok";
    }, options);

    assert.strictEqual(calls.length, 1);
    const [call] = calls as [{ attempt: number; delayMs: number }];
    assert.strictEqual(call.attempt, 0);
    assert.ok(call.delayMs >= BASE_MS);
  });
});
