import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeeperRegistryClient } from "../client";
import { TaskNotFoundError } from "../errors";
import { TaskStatus, TaskType } from "../types";
import { KeeperRegistryProvider } from "./provider";
import { useTask } from "./useTask";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function wrapper(client: KeeperRegistryClient) {
  return ({ children }: { children: ReactNode }) => createElement(KeeperRegistryProvider, { client }, children);
}

/**
 * Flushes pending microtasks/promise resolutions under `vi.useFakeTimers()`.
 * `waitFor`'s own internal polling relies on real `setTimeout` firing,
 * which fake timers never do on their own — every wait in this file uses
 * this instead, matching the proven pattern from
 * Sorokit/ui's `FeeEstimator.test.tsx` (`vi.advanceTimersByTimeAsync`
 * inside `act`) rather than `waitFor`, which hung indefinitely here.
 */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const SAMPLE_TASK = {
  owner: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
  taskType: TaskType.Liquidation,
  calldata: new Uint8Array(),
  reward: 1000n,
  deadline: 1_800_000_000,
  ttlLedgers: 100,
  status: TaskStatus.Pending,
  claimer: undefined,
  claimLedger: undefined,
  lockLedgers: 10,
};

describe("useTask", () => {
  let client: KeeperRegistryClient;
  let getTaskSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new KeeperRegistryClient({
      contractId: CONTRACT_ID,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    getTaskSpy = vi.spyOn(client, "getTask");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("fetches on mount and returns loading:false with the task once resolved", async () => {
    getTaskSpy.mockResolvedValue(SAMPLE_TASK);
    const { result } = renderHook(() => useTask(1), { wrapper: wrapper(client) });

    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.task).toEqual(SAMPLE_TASK);
    expect(result.current.error).toBeUndefined();
  });

  it("exposes a TaskNotFoundError distinctly from a generic Error", async () => {
    getTaskSpy.mockRejectedValue(new TaskNotFoundError(42));
    const { result } = renderHook(() => useTask(42), { wrapper: wrapper(client) });

    await flush();
    expect(result.current.error).toBeInstanceOf(TaskNotFoundError);
    expect(result.current.task).toBeUndefined();
  });

  it("exposes a transient network failure as a plain Error, not TaskNotFoundError", async () => {
    getTaskSpy.mockRejectedValue(new Error("fetch failed"));
    const { result } = renderHook(() => useTask(1), { wrapper: wrapper(client) });

    await flush();
    expect(result.current.error).not.toBeInstanceOf(TaskNotFoundError);
    expect(result.current.error?.message).toBe("fetch failed");
  });

  it("polls at the configured interval", async () => {
    getTaskSpy.mockResolvedValue(SAMPLE_TASK);
    renderHook(() => useTask(1, { pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(3);
  });

  it("pauses polling while the tab is hidden (Page Visibility API) and resumes immediately when it becomes visible", async () => {
    getTaskSpy.mockResolvedValue(SAMPLE_TASK);
    renderHook(() => useTask(1, { pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000); // several intervals' worth
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(1); // no new calls while hidden

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(2); // refreshed immediately on resume
  });

  it("cleans up its interval and visibilitychange listener on unmount", async () => {
    getTaskSpy.mockResolvedValue(SAMPLE_TASK);
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useTask(1, { pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    // A leaked interval would still call getTask after unmount — assert it does not.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("refetch() triggers an immediate fetch outside the poll cycle", async () => {
    getTaskSpy.mockResolvedValue(SAMPLE_TASK);
    const { result } = renderHook(() => useTask(1, { pollIntervalMs: 60000 }), { wrapper: wrapper(client) });
    await flush();
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });
    await flush();
    expect(getTaskSpy).toHaveBeenCalledTimes(2);
  });

  it("discards a stale in-flight response superseded by a newer fetch (no race condition)", async () => {
    let resolveFirst!: (value: typeof SAMPLE_TASK) => void;
    const firstCall = new Promise<typeof SAMPLE_TASK>((resolve) => {
      resolveFirst = resolve;
    });
    getTaskSpy.mockImplementationOnce(() => firstCall);
    getTaskSpy.mockResolvedValueOnce({ ...SAMPLE_TASK, reward: 9999n });

    const { result } = renderHook(() => useTask(1, { pollIntervalMs: 60000 }), { wrapper: wrapper(client) });

    // Trigger a second fetch (refetch) before the first has resolved.
    act(() => {
      result.current.refetch();
    });
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.task?.reward).toBe(9999n);

    // Now the stale first call resolves — it must not overwrite the newer result.
    await act(async () => {
      resolveFirst(SAMPLE_TASK); // reward: 1000n
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.task?.reward).toBe(9999n);
  });
});
