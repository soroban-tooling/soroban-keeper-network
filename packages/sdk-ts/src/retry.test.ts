import { describe, expect, it, vi } from "vitest";

import { withRetry } from "./retry.js";

describe("withRetry", () => {
  it("returns fn's result immediately on first success without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { maxRetries: 3, retryBaseMs: 10, sleepFn })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries a failing call and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("ok");
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { maxRetries: 3, retryBaseMs: 10, sleepFn })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("throws the final attempt's error once maxRetries is exhausted", async () => {
    const finalError = new Error("still failing");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("attempt 0"))
      .mockRejectedValueOnce(new Error("attempt 1"))
      .mockRejectedValueOnce(finalError);
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { maxRetries: 2, retryBaseMs: 10, sleepFn })).rejects.toBe(finalError);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a permanent error without retrying or sleeping", async () => {
    const permanentError = new Error("deterministic rejection");
    const fn = vi.fn().mockRejectedValue(permanentError);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const isPermanentError = vi.fn().mockReturnValue(true);

    await expect(
      withRetry(fn, { maxRetries: 5, retryBaseMs: 10, sleepFn, isPermanentError }),
    ).rejects.toBe(permanentError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(isPermanentError).toHaveBeenCalledWith(permanentError);
  });

  it("never retries when maxRetries is 0", async () => {
    const error = new Error("only attempt");
    const fn = vi.fn().mockRejectedValue(error);
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { maxRetries: 0, retryBaseMs: 10, sleepFn })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("calls onRetry with the 0-indexed attempt number, the chosen delay, and the error", async () => {
    const error1 = new Error("first failure");
    const fn = vi.fn().mockRejectedValueOnce(error1).mockResolvedValueOnce("ok");
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 1, retryBaseMs: 100, sleepFn, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, delayMs, error] = onRetry.mock.calls[0] as [number, number, unknown];
    expect(attempt).toBe(0);
    expect(error).toBe(error1);
    // backoff = retryBaseMs * 2^0 = 100, jitter in [0, retryBaseMs) => [100, 200)
    expect(delayMs).toBeGreaterThanOrEqual(100);
    expect(delayMs).toBeLessThan(200);
    expect(sleepFn).toHaveBeenCalledWith(delayMs);
  });

  it("defaults isPermanentError to always-transient, retrying every failure until exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(fn, { maxRetries: 2, retryBaseMs: 10, sleepFn })).rejects.toThrow(
      "always fails",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses a real timer-based sleep by default when sleepFn is omitted", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");
      const promise = withRetry(fn, { maxRetries: 1, retryBaseMs: 5 });
      await vi.advanceTimersByTimeAsync(20);
      await expect(promise).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
