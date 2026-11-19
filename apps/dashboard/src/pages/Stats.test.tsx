import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer, IndexerRequestError } from "../data/indexer";
import type { IndexedEvent } from "../data/types";

describe("StatsPage event aggregations, metrics, and error states", () => {
  const mockEvents: IndexedEvent[] = [
    {
      cursor: 1,
      ledger: 100,
      ledger_close_time: 1700000000,
      tx_hash: "0x1",
      event_index: 0,
      event_type: "task_registered",
      payload: { task_id: 1, owner: "GOWNER1" },
    },
    {
      cursor: 2,
      ledger: 105,
      ledger_close_time: 1700000025,
      tx_hash: "0x2",
      event_index: 0,
      event_type: "task_executed",
      payload: { task_id: 1, keeper: "GKEEPER1", net_reward: "9800000" },
    },
    {
      cursor: 3,
      ledger: 110,
      ledger_close_time: 1700000050,
      tx_hash: "0x3",
      event_index: 0,
      event_type: "task_executed",
      payload: { task_id: 2, keeper: "GKEEPER2", net_reward: "19600000" },
    },
  ];

  it("aggregates events and counts unique active keepers correctly", () => {
    const counts = mockEvents.reduce<Record<string, number>>((acc, event) => {
      if (event.event_type.startsWith("task_")) {
        acc[event.event_type] = (acc[event.event_type] ?? 0) + 1;
      }
      return acc;
    }, {});

    expect(counts["task_registered"]).toBe(1);
    expect(counts["task_executed"]).toBe(2);

    const activeKeepers = new Set(
      mockEvents.map((e) => String(e.payload.keeper ?? "")).filter(Boolean)
    );
    expect(activeKeepers.size).toBe(2);
    expect(activeKeepers.has("GKEEPER1")).toBe(true);
    expect(activeKeepers.has("GKEEPER2")).toBe(true);
  });

  it("loads admin config and fee statistics", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fee_bps: 200,
          paused: false,
          total_fees_swept: "15000000",
        }),
        { status: 200 }
      )
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    const config = await indexer.adminConfig();

    expect(config.fee_bps).toBe(200);
    expect(config.paused).toBe(false);
    expect(config.total_fees_swept).toBe("15000000");
  });

  it("handles error during event feed query", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );

    const indexer = new DashboardIndexer("https://indexer.test", fetchFn);
    await expect(indexer.events()).rejects.toThrow(IndexerRequestError);
  });
});
