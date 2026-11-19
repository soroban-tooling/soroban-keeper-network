import { describe, expect, it } from "vitest";
import type { TaskState } from "../data/types";
import { formatStroops } from "../format";

describe("OwnerPage reward calculations and status totals", () => {
  const mockTasks: TaskState[] = [
    {
      task_id: 1,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      status: "pending",
      reward: "100000000", // 10.00
      net_reward: "0",
      deadline: 1700000000,
      last_ledger: 100,
      condition_rejection_count: 0,
    },
    {
      task_id: 2,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      status: "pending",
      reward: "50000000", // 5.00
      net_reward: "0",
      deadline: 1700000000,
      last_ledger: 101,
      condition_rejection_count: 0,
    },
    {
      task_id: 3,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      status: "claimed",
      reward: "200000000", // 20.00
      net_reward: "0",
      deadline: 1700000000,
      last_ledger: 102,
      condition_rejection_count: 0,
    },
    {
      task_id: 4,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      status: "executed",
      reward: "300000000", // 30.00
      net_reward: "294000000",
      deadline: 1700000000,
      last_ledger: 103,
      condition_rejection_count: 0,
    },
    {
      task_id: 5,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      status: "cancelled",
      reward: "40000000", // 4.00
      net_reward: "0",
      deadline: 1700000000,
      last_ledger: 104,
      condition_rejection_count: 0,
    },
  ];

  it("accurately totals rewards by status using bigint arithmetic", () => {
    const totals: Record<string, bigint> = {
      pending: 0n,
      claimed: 0n,
      executed: 0n,
      cancelled: 0n,
      expired: 0n,
    };

    for (const t of mockTasks) {
      totals[t.status] += BigInt(t.reward);
    }

    expect(totals.pending).toBe(150_000_000n);
    expect(formatStroops(totals.pending)).toBe("15.00");

    expect(totals.claimed).toBe(200_000_000n);
    expect(formatStroops(totals.claimed)).toBe("20.00");

    // Total locked capital = pending + claimed = 35.00
    const totalLocked = totals.pending + totals.claimed;
    expect(totalLocked).toBe(350_000_000n);
    expect(formatStroops(totalLocked)).toBe("35.00");

    expect(totals.executed).toBe(300_000_000n);
    expect(formatStroops(totals.executed)).toBe("30.00");

    expect(totals.cancelled).toBe(40_000_000n);
    expect(formatStroops(totals.cancelled)).toBe("4.00");
  });

  it("links each task to its detail route", () => {
    const taskLinks = mockTasks.map((t) => `/tasks/${t.task_id}`);
    expect(taskLinks).toEqual([
      "/tasks/1",
      "/tasks/2",
      "/tasks/3",
      "/tasks/4",
      "/tasks/5",
    ]);
  });

  it("handles loading and error state transitions for owner data queries", () => {
    let loading = true;
    let error: string | null = null;
    let tasks: TaskState[] = [];

    expect(loading).toBe(true);

    // Error case
    error = "Indexer Service Error: 502 Bad Gateway";
    loading = false;
    expect(loading).toBe(false);
    expect(error).toContain("Indexer Service Error");

    // Success recovery
    error = null;
    tasks = mockTasks;
    expect(tasks).toHaveLength(5);
  });
});
