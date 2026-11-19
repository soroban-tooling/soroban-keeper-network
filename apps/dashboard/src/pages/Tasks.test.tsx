import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer, IndexerRequestError } from "../data/indexer";
import type { TaskState } from "../data/types";

describe("TasksPage data, sorting, and error states", () => {
  const mockTasks: TaskState[] = [
    {
      task_id: 10,
      owner: "GOWNER1",
      status: "pending",
      reward: "10000000",
      net_reward: "0",
      deadline: 1700000100,
      last_ledger: 1000,
      condition_rejection_count: 0,
    },
    {
      task_id: 20,
      owner: "GOWNER2",
      status: "claimed",
      reward: "50000000",
      net_reward: "0",
      deadline: 1700000050,
      last_ledger: 1010,
      condition_rejection_count: 0,
    },
    {
      task_id: 30,
      owner: "GOWNER3",
      status: "executed",
      reward: "20000000",
      net_reward: "19600000",
      deadline: 1700000200,
      last_ledger: 1020,
      condition_rejection_count: 0,
    },
  ];

  it("handles loading and data resolution through indexer client", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            events: [
              { cursor: 1, payload: { task_id: 10 } },
              { cursor: 2, payload: { task_id: 20 } },
              { cursor: 3, payload: { task_id: 30 } },
            ],
            next_cursor: 3,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: mockTasks[0] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: mockTasks[1] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: mockTasks[2] }), { status: 200 }));

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    const page = await indexer.allTasks(undefined, 25);

    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.task_id).toBe(10);
    expect(page.nextCursor).toBe(3);
  });

  it("sorts tasks by deadline and reward accurately", () => {
    // Sort by deadline ascending
    const byDeadlineAsc = [...mockTasks].sort((a, b) => a.deadline - b.deadline);
    expect(byDeadlineAsc.map((t) => t.task_id)).toEqual([20, 10, 30]);

    // Sort by reward descending using BigInt
    const byRewardDesc = [...mockTasks].sort((a, b) =>
      BigInt(a.reward) < BigInt(b.reward) ? 1 : -1
    );
    expect(byRewardDesc.map((t) => t.task_id)).toEqual([20, 30, 10]);
  });

  it("filters tasks by status accurately", () => {
    const pendingOnly = mockTasks.filter((t) => t.status === "pending");
    expect(pendingOnly).toHaveLength(1);
    expect(pendingOnly[0]?.task_id).toBe(10);

    const executedOnly = mockTasks.filter((t) => t.status === "executed");
    expect(executedOnly).toHaveLength(1);
    expect(executedOnly[0]?.task_id).toBe(30);
  });

  it("propagates and identifies indexer error state", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    await expect(indexer.allTasks()).rejects.toThrow(IndexerRequestError);
  });
});
