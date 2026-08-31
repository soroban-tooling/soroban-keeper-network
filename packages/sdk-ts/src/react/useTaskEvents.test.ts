import { nativeToScVal, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeeperRegistryClient } from "../client";
import { TASK_CLAIMED_TOPIC, TASK_REGISTERED_TOPIC } from "../events";
import { KeeperRegistryProvider } from "./provider";
import { useTaskEvents } from "./useTaskEvents";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";

function wrapper(client: KeeperRegistryClient) {
  return ({ children }: { children: ReactNode }) => createElement(KeeperRegistryProvider, { client }, children);
}

/** See `useTask.test.ts`'s `flush()` doc comment — `waitFor` hangs under `vi.useFakeTimers()`; this is the working substitute used throughout this file instead. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function registeredEvent(id: string, taskId: bigint) {
  return {
    id,
    topic: TASK_REGISTERED_TOPIC,
    value: nativeToScVal([taskId, ADDRESS, 1000n, 1_800_000_000n], { type: ["u64", "address", "i128", "u64"] }),
  };
}

function claimedEvent(id: string, taskId: bigint) {
  return {
    id,
    topic: TASK_CLAIMED_TOPIC,
    value: nativeToScVal([taskId, ADDRESS, 500], { type: ["u64", "address", "u32"] }),
  };
}

describe("useTaskEvents", () => {
  let client: KeeperRegistryClient;
  let getEventsSpy: ReturnType<typeof vi.spyOn>;
  let getLatestLedgerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new KeeperRegistryClient({
      contractId: CONTRACT_ID,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    getLatestLedgerSpy = vi
      .spyOn(SorobanRpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ id: "1", sequence: 1000, protocolVersion: 21 } as never);
    getEventsSpy = vi.spyOn(SorobanRpc.Server.prototype, "getEvents");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts from the latest ledger on first poll (no history backfill)", async () => {
    getEventsSpy.mockResolvedValue({ events: [], cursor: "cursor-1" } as never);
    renderHook(() => useTaskEvents(), { wrapper: wrapper(client) });

    await flush();
    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    expect(getLatestLedgerSpy).toHaveBeenCalledOnce();
    const [request] = getEventsSpy.mock.calls[0];
    expect(request).toMatchObject({ startLedger: 1000 });
  });

  it("uses the returned cursor (not startLedger) on every subsequent poll", async () => {
    getEventsSpy.mockResolvedValueOnce({ events: [], cursor: "cursor-1" } as never);
    getEventsSpy.mockResolvedValueOnce({ events: [], cursor: "cursor-2" } as never);
    renderHook(() => useTaskEvents({ pollIntervalMs: 5000 }), { wrapper: wrapper(client) });

    await flush();
    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getEventsSpy).toHaveBeenCalledTimes(2);
    const [secondRequest] = getEventsSpy.mock.calls[1];
    expect(secondRequest).toMatchObject({ cursor: "cursor-1" });
    expect(secondRequest).not.toHaveProperty("startLedger");
  });

  it("decodes and accumulates matching events across polls", async () => {
    getEventsSpy.mockResolvedValueOnce({ events: [registeredEvent("e1", 1n)], cursor: "c1" } as never);
    getEventsSpy.mockResolvedValueOnce({ events: [registeredEvent("e2", 2n)], cursor: "c2" } as never);

    const { result } = renderHook(() => useTaskEvents({ pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.events).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events.map((e) => (e.type === "TaskRegistered" ? e.taskId : undefined))).toEqual([1, 2]);
  });

  it("never delivers the same event id twice, even if a poll's response overlaps a previous one", async () => {
    getEventsSpy.mockResolvedValueOnce({
      events: [registeredEvent("e1", 1n), registeredEvent("e2", 2n)],
      cursor: "c1",
    } as never);
    // Second poll's response overlaps: e2 appears again alongside a genuinely new e3.
    getEventsSpy.mockResolvedValueOnce({
      events: [registeredEvent("e2", 2n), registeredEvent("e3", 3n)],
      cursor: "c2",
    } as never);

    const { result } = renderHook(() => useTaskEvents({ pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.events).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // Only e3 is new; e2's duplicate delivery must be dropped.
    expect(result.current.events).toHaveLength(3);
    const taskIds = result.current.events.map((e) => (e.type === "TaskRegistered" ? e.taskId : undefined));
    expect(taskIds).toEqual([1, 2, 3]);
  });

  it("filters by eventTypes using the typed decoder's discriminant, not ad hoc topic matching", async () => {
    getEventsSpy.mockResolvedValue({
      events: [registeredEvent("e1", 1n), claimedEvent("e2", 1n)],
      cursor: "c1",
    } as never);

    const { result } = renderHook(() => useTaskEvents({ eventTypes: ["TaskClaimed"] }), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.loading).toBe(false);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe("TaskClaimed");
  });

  it("skips events this SDK doesn't decode (Unknown) without surfacing them or throwing", async () => {
    const unknownEvent = {
      id: "e-unknown",
      topic: [nativeToScVal("foo", { type: "symbol" }), nativeToScVal("bar", { type: "symbol" })],
      value: nativeToScVal(1n, { type: "u64" }),
    };
    getEventsSpy.mockResolvedValue({ events: [unknownEvent, registeredEvent("e1", 1n)], cursor: "c1" } as never);

    const { result } = renderHook(() => useTaskEvents(), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.loading).toBe(false);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe("TaskRegistered");
  });

  it("surfaces a getEvents failure as `error` without crashing the poll loop", async () => {
    getEventsSpy.mockRejectedValueOnce(new Error("RPC unavailable"));
    getEventsSpy.mockResolvedValueOnce({ events: [registeredEvent("e1", 1n)], cursor: "c1" } as never);

    const { result } = renderHook(() => useTaskEvents({ pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.error?.message).toBe("RPC unavailable");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.events).toHaveLength(1);
  });

  it("stops polling on unmount", async () => {
    getEventsSpy.mockResolvedValue({ events: [], cursor: "c1" } as never);
    const { unmount } = renderHook(() => useTaskEvents({ pollIntervalMs: 5000 }), { wrapper: wrapper(client) });
    await flush();
    expect(getEventsSpy).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(getEventsSpy).toHaveBeenCalledTimes(1);
  });
});
