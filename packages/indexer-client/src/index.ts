// Entry point for @soroban-keeper-network/indexer-client.
//
/**
 * `@soroban-keeper-network/indexer-client` -- a typed client for the
 * Soroban Keeper Network indexer's REST and WebSocket APIs.
 *
 * ```ts
 * import { IndexerClient, subscribeToEvents } from "@soroban-keeper-network/indexer-client";
 *
 * const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1" });
 * const { tasks } = await client.tasksByKeeper("GKEEPER...");
 *
 * const subscription = subscribeToEvents(
 *   "wss://indexer.example.org/v1/stream",
 *   { eventType: "task_claimed" },
 *   { onMessage: (message) => console.log(message) },
 * );
 * ```
 */

export {
  IndexerApiError,
  IndexerClient,
  IndexerTransportError,
  type EventFeedParams,
  type IndexerClientOptions,
  type LeaderboardParams,
} from "./client.js";

export {
  subscribeToEvents,
  type Subscription,
  type SubscriptionHandlers,
  type WebSocketConstructorLike,
  type WebSocketLike,
} from "./websocket.js";

export type {
  AdminConfig,
  ApiErrorBody,
  EventFeedResponse,
  EventPayload,
  EventType,
  HealthResponse,
  IndexedEvent,
  KeeperSummary,
  Leaderboard,
  LeaderboardEntry,
  RankBy,
  ServerMessage,
  SubscribeOptions,
  TaskDetail,
  TaskListResponse,
  TaskState,
  TaskStatus,
} from "./types.js";
