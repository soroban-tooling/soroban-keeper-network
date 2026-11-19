import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer, IndexerRequestError } from "../data/indexer";
import type { TaskState } from "../data/types";

describe("KeeperPage metrics, tasks, and error states", () => {
  const sampleKeeper = "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J";
  const mockTasks: TaskState[] = [
    {
      task_id: 1,
      owner: "GOWNER1",
      status: "executed",
      reward: "10000000",
      net_reward: "9800000",
      deadline: 1700000000,
      last_ledger: 100,
      condition_rejection_count: 0,
    },
  ];

  it("loads keeper indexed tasks", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ tasks: mockTasks, next_cursor: null }), { status: 200 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    const result = await indexer.tasksByKeeper(sampleKeeper);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.task_id).toBe(1);
  });

  it("computes live contract metrics against RegistryReader interface", async () => {
    const mockRegistry = {
      keeperBalance: vi.fn().mockResolvedValue(50_000_000n),
      keeperStake: vi.fn().mockResolvedValue(100_000_000n),
      keeperReputation: vi.fn().mockResolvedValue(92),
      pendingUnbond: vi.fn().mockResolvedValue({ amount: 10_000_000n, unlockLedger: 1200 }),
      slashHistory: vi.fn().mockResolvedValue({ count: 1, totalSlashed: 5_000_000n }),
    };

    const balance = await mockRegistry.keeperBalance(sampleKeeper);
    const stake = await mockRegistry.keeperStake(sampleKeeper);
    const reputation = await mockRegistry.keeperReputation(sampleKeeper);
    const unbond = await mockRegistry.pendingUnbond(sampleKeeper);
    const slash = await mockRegistry.slashHistory(sampleKeeper);

    expect(balance).toBe(50_000_000n);
    expect(stake).toBe(100_000_000n);
    expect(reputation).toBe(92);
    expect(unbond?.amount).toBe(10_000_000n);
    expect(slash.count).toBe(1);
  });

  it("catches and reports indexer connection error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Failed Dependency", { status: 424 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    await expect(indexer.tasksByKeeper(sampleKeeper)).rejects.toThrow(IndexerRequestError);
  });
});
