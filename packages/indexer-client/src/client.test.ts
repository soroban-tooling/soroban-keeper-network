import { describe, expect, it, vi } from "vitest";

import { IndexerApiError, IndexerClient, IndexerTransportError } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("IndexerClient", () => {
  it("health() calls GET /health and returns the decoded body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, { status: "ok", backfill_complete: true, last_ingested_ledger: 42 }),
    );
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await expect(client.health()).resolves.toEqual({
      status: "ok",
      backfill_complete: true,
      last_ingested_ledger: 42,
    });

    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://indexer.example.org/v1/health");
    expect(init.method).toBe("GET");
  });

  it("eventFeed() forwards every provided parameter and omits every unset one", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { events: [] }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await client.eventFeed({ after: 100, limit: 25, eventType: "task_claimed" });

    const [url] = fetchFn.mock.calls[0] as [URL];
    expect(url.searchParams.get("after")).toBe("100");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("event_type")).toBe("task_claimed");
    expect(url.searchParams.has("address")).toBe(false);
  });

  it("leaderboard() maps rankBy/since/limit to the wire's rank_by/since/limit", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { rank_by: "reward", entries: [] }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await client.leaderboard({ rankBy: "reward", since: 1700000000, limit: 10 });

    const [url] = fetchFn.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/v1/leaderboard");
    expect(url.searchParams.get("rank_by")).toBe("reward");
    expect(url.searchParams.get("since")).toBe("1700000000");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("tasksByKeeper()/tasksByOwner() URL-encode the address into the path and pass pagination query params", async () => {
    const fetchFn = vi.fn().mockImplementation(() => jsonResponse(200, { address: "G/weird", tasks: [] }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await client.tasksByKeeper("G/weird", { after: 10, limit: 25 });
    const keeperUrl = fetchFn.mock.calls[0]![0] as URL;
    expect(keeperUrl.pathname).toBe("/v1/keepers/G%2Fweird/tasks");
    expect(keeperUrl.searchParams.get("after")).toBe("10");
    expect(keeperUrl.searchParams.get("limit")).toBe("25");

    await client.tasksByOwner("G/weird", { after: 20, limit: 50 });
    const ownerUrl = fetchFn.mock.calls[1]![0] as URL;
    expect(ownerUrl.pathname).toBe("/v1/owners/G%2Fweird/tasks");
    expect(ownerUrl.searchParams.get("after")).toBe("20");
    expect(ownerUrl.searchParams.get("limit")).toBe("50");
  });

  it("getTask() builds /tasks/{task_id} and passes limit query param", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, { task: { task_id: 7 }, history: [] }),
    );
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await client.getTask(7, { limit: 10 });
    const url = fetchFn.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe("/v1/tasks/7");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("adminConfig() calls GET /admin/config", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { total_fees_swept: "0" }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    await client.adminConfig();
    expect((fetchFn.mock.calls[0]![0] as URL).pathname).toBe("/v1/admin/config");
  });

  it("throws IndexerApiError with the decoded error code and message on a non-2xx JSON ApiError body", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: "task_not_found", message: "No such task has been indexed" }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    const error = await client.getTask(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexerApiError);
    expect((error as IndexerApiError).status).toBe(404);
    expect((error as IndexerApiError).code).toBe("task_not_found");
    expect((error as IndexerApiError).message).toContain("No such task has been indexed");
  });

  it("throws IndexerTransportError when a non-2xx response is not the ApiError JSON shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1", fetchFn });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexerTransportError);
    expect((error as IndexerTransportError).status).toBe(502);
  });

  it("strips a trailing slash from baseUrl so a doubled slash never reaches the server", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ok", backfill_complete: false, last_ingested_ledger: null }));
    const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1/", fetchFn });

    await client.health();
    expect((fetchFn.mock.calls[0]![0] as URL).toString()).toBe("https://indexer.example.org/v1/health");
  });
});
