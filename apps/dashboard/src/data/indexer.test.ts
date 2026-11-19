import { describe, expect, it, vi } from "vitest";
import { DashboardIndexer } from "./indexer";

describe("DashboardIndexer", () => {
  it("uses the event cursor for a stable task page", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [{ cursor: 9, payload: { task_id: 42 } }],
        next_cursor: 9,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task: { task_id: 42, status: "pending" },
      }), { status: 200 }));

    const page = await new DashboardIndexer("https://indexer.test/v1", fetchFn).allTasks(undefined, 1);

    expect(page.items[0]?.task_id).toBe(42);
    expect(page.nextCursor).toBe(9);
    expect(fetchFn.mock.calls[0]?.[0].toString()).toContain("event_type=task_registered");
  });

  it("reports a failed indexer response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 }));
    const client = new DashboardIndexer("https://indexer.test/v1", fetchFn);
    await expect(client.leaderboard("executions")).rejects.toThrow("503");
  });
});
