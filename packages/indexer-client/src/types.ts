// Ergonomic aliases over `openapi-typescript`'s generated `components`
// namespace (see `generated/openapi-types.ts`, regenerated from
// `indexer/openapi.yaml` by `npm run generate:types` — never hand-edit that
// file). Re-exporting under these names means the rest of this package, and
// every consumer, imports `AdminConfig`/`TaskState`/... directly rather than
// `components["schemas"]["AdminConfig"]` everywhere, while every field stays
// exactly the wire shape (including its `snake_case` names) — no separate
// hand-maintained mirror of the schema that could itself drift from it.
import type { components } from "./generated/openapi-types.js";

export type AdminConfig = components["schemas"]["AdminConfig"];
export type ApiErrorBody = components["schemas"]["ApiError"];
export type EventFeedResponse = components["schemas"]["EventFeedResponse"];
export type EventPayload = components["schemas"]["EventPayload"];
export type EventType = components["schemas"]["EventType"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type IndexedEvent = components["schemas"]["IndexedEvent"];
export type KeeperSummary = components["schemas"]["KeeperSummary"];
export type Leaderboard = components["schemas"]["Leaderboard"];
export type LeaderboardEntry = components["schemas"]["LeaderboardEntry"];
export type RankBy = components["schemas"]["RankBy"];
export type TaskDetail = components["schemas"]["TaskDetail"];
export type TaskListResponse = components["schemas"]["TaskListResponse"];
export type TaskState = components["schemas"]["TaskState"];
export type TaskStatus = components["schemas"]["TaskStatus"];

/**
 * What the server sends over `/v1/stream` (`indexer/src/api/websocket.rs`'s
 * `ServerMessage`). Not part of `indexer/openapi.yaml` — OpenAPI describes
 * HTTP request/response shapes, not a WebSocket protocol — so unlike every
 * type above, this one is hand-kept in sync with the Rust source rather than
 * generated. It reuses {@link IndexedEvent} for the `event` variant's
 * payload rather than redefining it, exactly as the indexer's own doc
 * comment on `ServerMessage` promises ("wraps the same `IndexedEvent` the
 * REST feed returns, rather than a parallel WebSocket-specific shape") — one
 * parser handles both a REST page and a live event.
 */
export type ServerMessage =
  | {
      kind: "subscribed";
      event_type: string | null;
      address: string | null;
      /** Cursor the live feed resumes from, if a replay happened on connect. */
      replayed_through: number | null;
    }
  | {
      kind: "event";
      event: IndexedEvent;
    }
  | {
      kind: "closed";
      reason: string;
    };

/** Query parameters for `subscribeToEvents` (`/v1/stream`'s upgrade request). */
export interface SubscribeOptions {
  /** Only events of this type. */
  eventType?: EventType;
  /** Only events mentioning this address, as owner or keeper. */
  address?: string;
  /** Resume from this cursor; the server replays anything missed first. */
  after?: number;
}
