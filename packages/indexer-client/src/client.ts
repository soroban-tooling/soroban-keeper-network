// Thin typed client over the indexer's REST API (`indexer/src/api/rest.rs`),
// one method per `indexer/openapi.yaml` operation. "Thin" is deliberate: this
// does no retrying, caching, or polling of its own (a browser dashboard
// wanting to poll composes this the way `@soroban-keeper-network/sdk/react`'s
// hooks compose the registry SDK's client) -- it only builds the request,
// parses the response, and turns a non-2xx into a typed error.

import type {
  AdminConfig,
  ApiErrorBody,
  EventFeedResponse,
  EventType,
  HealthResponse,
  Leaderboard,
  RankBy,
  TaskDetail,
  TaskListResponse,
} from "./types.js";

/**
 * A non-2xx response from the indexer, decoded from the `ApiError` body
 * every endpoint returns on failure. `code` is the stable, branch-on-able
 * field (`ApiError.error`); `message` is for logs/display only.
 */
export class IndexerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`indexer API error ${status} (${code}): ${message}`);
    this.name = "IndexerApiError";
  }
}

/** Raised when a response is not the JSON `ApiError` shape at all — a proxy timeout page, a 502 from the host, or similar transport-level failure the indexer itself never produced. */
export class IndexerTransportError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`indexer returned ${status} with a non-JSON body: ${bodyText.slice(0, 200)}`);
    this.name = "IndexerTransportError";
  }
}

export interface IndexerClientOptions {
  /** Base URL up to and including the API version, e.g. `https://indexer.example.org/v1`. No trailing slash. */
  baseUrl: string;
  /**
   * Injectable so tests (and any caller with its own transport, e.g. one
   * adding auth headers) can substitute a stand-in without a live network —
   * the same seam `@soroban-keeper-network/sdk`'s `RpcServerLike` establishes
   * for the registry client. Defaults to the global `fetch`.
   */
  fetchFn?: typeof fetch;
}

export interface EventFeedParams {
  /** Cursor from a previous response's `next_cursor`. */
  after?: number;
  /** Events per page (server default 50, max 500). */
  limit?: number;
  eventType?: EventType;
  /** Filter by owner or keeper address. */
  address?: string;
}

export interface LeaderboardParams {
  /** Defaults to `"executions"` server-side if omitted. */
  rankBy?: RankBy;
  /** Unix timestamp; omit for all time. */
  since?: number;
  /** Entries to return (server default 25, max 200). */
  limit?: number;
}

export class IndexerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: IndexerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** `GET /health` — service liveness and how far ingestion has reached. */
  health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  /** `GET /admin/config` — the registry's current configuration, folded from admin event history. */
  adminConfig(): Promise<AdminConfig> {
    return this.get("/admin/config");
  }

  /** `GET /events` — a page of the event feed, oldest first. */
  eventFeed(params: EventFeedParams = {}): Promise<EventFeedResponse> {
    return this.get("/events", {
      after: params.after,
      limit: params.limit,
      event_type: params.eventType,
      address: params.address,
    });
  }

  /** `GET /leaderboard` — keepers ranked by executions or by total net reward. */
  leaderboard(params: LeaderboardParams = {}): Promise<Leaderboard> {
    return this.get("/leaderboard", {
      rank_by: params.rankBy,
      since: params.since,
      limit: params.limit,
    });
  }

  /** `GET /keepers/{keeper}/tasks` — tasks a keeper has claimed or executed. */
  tasksByKeeper(keeper: string): Promise<TaskListResponse> {
    return this.get(`/keepers/${encodeURIComponent(keeper)}/tasks`);
  }

  /** `GET /owners/{owner}/tasks` — tasks registered by an owner. */
  tasksByOwner(owner: string): Promise<TaskListResponse> {
    return this.get(`/owners/${encodeURIComponent(owner)}/tasks`);
  }

  /** `GET /tasks/{task_id}` — one task, with its full observed history. */
  getTask(taskId: number): Promise<TaskDetail> {
    return this.get(`/tasks/${encodeURIComponent(String(taskId))}`);
  }

  private async get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const bodyText = await response.text();
    let body: Partial<ApiErrorBody> | undefined;
    try {
      body = JSON.parse(bodyText) as Partial<ApiErrorBody>;
    } catch {
      body = undefined;
    }
    if (!body || typeof body.error !== "string" || typeof body.message !== "string") {
      throw new IndexerTransportError(response.status, bodyText);
    }
    throw new IndexerApiError(response.status, body.error, body.message);
  }
}
