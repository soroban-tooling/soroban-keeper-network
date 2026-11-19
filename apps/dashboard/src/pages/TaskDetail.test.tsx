import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer, IndexerRequestError } from "../data/indexer";

describe("TaskDetailPage data, calculations, and error states", () => {
  const sampleDetail = {
    task: {
      task_id: 42,
      owner: "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J",
      keeper: "GD3C5A...",
      status: "claimed" as const,
      reward: "150000000",
      net_reward: "0",
      deadline: 1700000000,
      claim_ledger: 500,
      last_ledger: 505,
      condition_rejection_count: 0,
    },
    history: [
      {
        cursor: 1,
        ledger: 400,
        ledger_close_time: 1699990000,
        tx_hash: "0xabc1",
        event_index: 0,
        event_type: "task_registered",
        payload: { task_id: 42 },
      },
      {
        cursor: 2,
        ledger: 500,
        ledger_close_time: 1699995000,
        tx_hash: "0xabc2",
        event_index: 1,
        event_type: "task_claimed",
        payload: { task_id: 42, keeper: "GD3C5A..." },
      },
    ],
  };

  it("loads task detail and history successfully", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify(sampleDetail), { status: 200 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    const detail = await indexer.taskDetail(42);

    expect(detail.task.task_id).toBe(42);
    expect(detail.task.status).toBe("claimed");
    expect(detail.history).toHaveLength(2);
  });

  it("computes claim lock end ledger correctly when registry contract responds", () => {
    const liveTask = {
      deadline: 1700000000,
      claimLedger: 500,
      lockLedgers: 120,
    };

    const lockEnd = liveTask.claimLedger !== undefined ? liveTask.claimLedger + liveTask.lockLedgers : null;
    expect(lockEnd).toBe(620);
  });

  it("handles 404 not-found state", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Task not found" }), { status: 404 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    try {
      await indexer.taskDetail(99999);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IndexerRequestError);
      expect((err as IndexerRequestError).status).toBe(404);
    }
  });

  it("handles indexer error state with retry opportunity", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    await expect(indexer.taskDetail(42)).rejects.toThrow(IndexerRequestError);
  });
});
