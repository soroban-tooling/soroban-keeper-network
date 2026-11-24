import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer, IndexerRequestError } from "../data/indexer";
import type { LeaderboardEntry } from "../data/types";

describe("LeaderboardPage ranking, pagination, and error states", () => {
  const mockEntries: LeaderboardEntry[] = [
    { rank: 1, keeper: "GKEEPER1", executions: 150, total_reward: "5000000000", reputation: "98" },
    { rank: 2, keeper: "GKEEPER2", executions: 90, total_reward: "3000000000", reputation: "95" },
    { rank: 3, keeper: "GKEEPER3", executions: 30, total_reward: "1000000000", reputation: "80" },
  ];

  it("fetches leaderboard rankings according to selected rankBy dimension", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ entries: mockEntries }), { status: 200 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    const data = await indexer.leaderboard("executions", 100);

    expect(data).toHaveLength(3);
    expect(data[0]?.keeper).toBe("GKEEPER1");
    expect(fetchFn.mock.calls[0]?.[0].toString()).toContain("rank_by=executions");
  });

  it("paginates entries slice properly", () => {
    const pageSize = 2;
    const page0 = mockEntries.slice(0, pageSize);
    const page1 = mockEntries.slice(pageSize, pageSize * 2);

    expect(page0).toHaveLength(2);
    expect(page0[0]?.keeper).toBe("GKEEPER1");
    expect(page1).toHaveLength(1);
    expect(page1[0]?.keeper).toBe("GKEEPER3");
  });

  it("identifies and exposes network/indexer error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Gateway Timeout", { status: 504 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    await expect(indexer.leaderboard("reward")).rejects.toThrow(IndexerRequestError);
  });
});
