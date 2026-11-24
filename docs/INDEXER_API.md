<!--
  GENERATED FILE. Do not edit by hand.
  Source: indexer/openapi.yaml (REST) and docs/indexer-api/websocket.md (WebSocket).
  Regenerate: make docs-indexer-api
-->

# Keeper Registry Indexer API

Read-only access to indexed keeper registry events and the state derived from them.

API version `1.0.0`, OpenAPI `3.1.0`.

Base path: `/v1` — Version 1 of the API.

This reference is generated from [`indexer/openapi.yaml`](../indexer/openapi.yaml)
during the docs build (`make docs`). That file is itself generated from the
indexer's handlers and verified against them by a test, so each route and
type below reflects the running code. The [WebSocket section](#websocket-event-stream)
is the one hand-maintained part.

## Endpoints

| Method | Path | Summary |
|---|---|---|
| GET | `/admin/config` | Current registry configuration. |
| GET | `/events` | A page of ingested events, oldest first. |
| GET | `/feeds/open-tasks` | Open tasks grouped by oracle feed. |
| GET | `/health` | Service liveness and ingestion progress. |
| GET | `/keepers/{keeper}/tasks` | Tasks a keeper has claimed or executed, paginated and capped. |
| GET | `/leaderboard` | Keepers ranked by executions or by total net reward. |
| GET | `/owners/{owner}/tasks` | Tasks registered by an owner, paginated and capped. |
| GET | `/tasks/{task_id}` | One task, with its observed history bounded by limit. |
| WebSocket | `/stream` | Live event subscription. See the [WebSocket section](#websocket-event-stream). |

## REST routes

### GET /admin/config

Current registry configuration.

Operation ID: `admin_config`

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Current configuration | [AdminConfig](#schema-AdminConfig) |

### GET /events

A page of ingested events, oldest first.

Operation ID: `event_feed`

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `after` | query | integer (int64) | no | Cursor from a previous response |
| `limit` | query | integer (int32), min 0 | no | Events per page (default 50, max 500) |
| `event_type` | query | string | no | Filter by event type |
| `address` | query | string | no | Filter by owner or keeper address |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | A page of events | [EventFeedResponse](#schema-EventFeedResponse) |
| 400 | Unknown event type | [ApiError](#schema-ApiError) |

### GET /feeds/open-tasks

Open tasks grouped by oracle feed.

Operation ID: `open_tasks_by_feed`

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Open tasks grouped by oracle feed | array of [FeedTasksResponse](#schema-FeedTasksResponse) |

### GET /health

Service liveness and ingestion progress.

Operation ID: `health`

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Service is running | [HealthResponse](#schema-HealthResponse) |

### GET /keepers/{keeper}/tasks

Tasks a keeper has claimed or executed, paginated and capped.

Operation ID: `tasks_by_keeper`

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `keeper` | path | string | yes | Keeper address |
| `after` | query | integer (int64), min 0 | no | Cursor from a previous response's next_cursor |
| `limit` | query | integer (int32), min 0 | no | Tasks per page (default 50, max 200) |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Tasks for the keeper | [TaskListResponse](#schema-TaskListResponse) |

### GET /leaderboard

Keepers ranked by executions or by total net reward.

Ties are broken deterministically: by the other metric, then by keeper
address ascending. See `queries::leaderboard` for the full rule.

Operation ID: `keeper_leaderboard`

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `rank_by` | query | string | no | executions (default) or reward |
| `since` | query | integer (int64) | no | Unix timestamp, normalized to 60s windows; omit for all time |
| `limit` | query | integer (int32), min 0 | no | Entries to return (default 25, max 200) |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Ranked keepers | [Leaderboard](#schema-Leaderboard) |
| 400 | Unknown ranking metric | [ApiError](#schema-ApiError) |

### GET /owners/{owner}/tasks

Tasks registered by an owner, paginated and capped.

Operation ID: `tasks_by_owner`

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `owner` | path | string | yes | Owner address |
| `after` | query | integer (int64), min 0 | no | Cursor from a previous response's next_cursor |
| `limit` | query | integer (int32), min 0 | no | Tasks per page (default 50, max 200) |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Tasks for the owner | [TaskListResponse](#schema-TaskListResponse) |

### GET /tasks/{task_id}

One task, with its observed history bounded by limit.

Operation ID: `get_task`

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `task_id` | path | integer (int64), min 0 | yes | Task id |
| `limit` | query | integer (int32), min 0 | no | Maximum history events to return (default 50, max 200) |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Task state and history | [TaskDetail](#schema-TaskDetail) |
| 404 | No such task has been indexed | [ApiError](#schema-ApiError) |

## Schemas

<a id="schema-AdminConfig"></a>

### AdminConfig

The registry's current configuration, folded from admin event history.

Every field is `Option` because the indexer may not have ingested the event
that would set it: reporting `None` is honest, where a default would be a
value the contract never emitted.

| Field | Type | Required | Description |
|---|---|---|---|
| `admin` | string \| null | no |  |
| `current_wasm_hash` | string \| null | no | Most recent wasm hash from an `Upgraded` event, hex-encoded. |
| `fee_bps` | integer (int32) \| null, min 0 | no |  |
| `min_reward` | string \| null | no |  |
| `paused` | boolean \| null | no |  |
| `reward_token` | string \| null | no |  |
| `total_fees_swept` | string | yes | Fees swept to a treasury so far, summed across every `FeesSwept`. |

<a id="schema-ApiError"></a>

### ApiError

An error returned by any endpoint.

| Field | Type | Required | Description |
|---|---|---|---|
| `error` | string | yes | Stable, machine-readable code. Safe to branch on. |
| `message` | string | yes | Human-readable detail. Wording may change; do not parse it. |

<a id="schema-EventFeedResponse"></a>

### EventFeedResponse

A page of the event feed.

| Field | Type | Required | Description |
|---|---|---|---|
| `events` | array of [IndexedEvent](#schema-IndexedEvent) | yes |  |
| `next_cursor` | integer (int64) \| null | no | Pass as `after` to fetch the next page; absent at the end of the feed. This is a stable cursor, not an offset: events ingested between two requests shift no boundary, so a client paging through the feed sees every event exactly once. |

<a id="schema-EventPayload"></a>

### EventPayload

The decoded payload of one event.

Field names and order match the contract's `publish` tuple for each event.
`i128` values are serialised as strings: a reward in stroops can exceed
`Number.MAX_SAFE_INTEGER`, and a browser dashboard reading JSON would
silently lose precision on a bare number.

One of the following variants:

**`task_registered`**

| Field | Type | Required | Description |
|---|---|---|---|
| `condition` | string \| null | no |  |
| `deadline` | integer (int64), min 0 | yes |  |
| `owner` | string | yes |  |
| `reward` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `task_registered` | yes |  |

**`condition_not_met`**

| Field | Type | Required | Description |
|---|---|---|---|
| `condition` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `condition_not_met` | yes |  |

**`task_claimed`**

| Field | Type | Required | Description |
|---|---|---|---|
| `claim_ledger` | integer (int32), min 0 | yes | Ledger sequence at claim time, as the contract reports it. |
| `keeper` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `task_claimed` | yes |  |

**`task_executed`**

| Field | Type | Required | Description |
|---|---|---|---|
| `keeper` | string | yes |  |
| `net_reward` | string | yes |  |
| `proof` | string | yes | Hex-encoded execution proof bytes. |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `task_executed` | yes |  |

**`task_expired`**

| Field | Type | Required | Description |
|---|---|---|---|
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `task_expired` | yes |  |

**`task_cancelled`**

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `task_cancelled` | yes |  |

**`reward_increased`**

| Field | Type | Required | Description |
|---|---|---|---|
| `new_reward` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `reward_increased` | yes |  |

**`deadline_extended`**

| Field | Type | Required | Description |
|---|---|---|---|
| `new_deadline` | integer (int64), min 0 | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `type` | string — one of `deadline_extended` | yes |  |

**`rewards_withdrawn`**

| Field | Type | Required | Description |
|---|---|---|---|
| `amount` | string | yes |  |
| `keeper` | string | yes |  |
| `type` | string — one of `rewards_withdrawn` | yes |  |

**`paused`**

| Field | Type | Required | Description |
|---|---|---|---|
| `paused` | boolean | yes |  |
| `type` | string — one of `paused` | yes |  |

**`fee_updated`**

| Field | Type | Required | Description |
|---|---|---|---|
| `new_bps` | integer (int32), min 0 | yes |  |
| `old_bps` | integer (int32), min 0 | yes |  |
| `type` | string — one of `fee_updated` | yes |  |

**`admin_transferred`**

| Field | Type | Required | Description |
|---|---|---|---|
| `new_admin` | string | yes |  |
| `old_admin` | string | yes |  |
| `type` | string — one of `admin_transferred` | yes |  |

**`min_reward_updated`**

| Field | Type | Required | Description |
|---|---|---|---|
| `new_min` | string | yes |  |
| `old_min` | string | yes |  |
| `type` | string — one of `min_reward_updated` | yes |  |

**`fees_swept`**

| Field | Type | Required | Description |
|---|---|---|---|
| `amount` | string | yes |  |
| `remaining` | string | yes |  |
| `treasury` | string | yes |  |
| `type` | string — one of `fees_swept` | yes |  |

**`initialized`**

| Field | Type | Required | Description |
|---|---|---|---|
| `admin` | string | yes |  |
| `fee_bps` | integer (int32), min 0 | yes |  |
| `reward_token` | string | yes |  |
| `type` | string — one of `initialized` | yes |  |

**`upgraded`**

| Field | Type | Required | Description |
|---|---|---|---|
| `admin` | string | yes |  |
| `new_wasm_hash` | string | yes | Hex-encoded 32-byte wasm hash. |
| `type` | string — one of `upgraded` | yes |  |

**`reputation_updated`**

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes |  |
| `keeper` | string | yes |  |
| `score` | string | yes |  |
| `type` | string — one of `reputation_updated` | yes |  |

**`oracle_price_condition_set`**

| Field | Type | Required | Description |
|---|---|---|---|
| `asset` | string | yes |  |
| `oracle` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |
| `threshold` | string | yes |  |
| `type` | string — one of `oracle_price_condition_set` | yes |  |

<a id="schema-EventType"></a>

### EventType

The discriminant of an [`EventPayload`], usable as a filter without
decoding the payload -- the off-chain equivalent of the contract's
`(verb, noun)` topic pair.

Type: string. Allowed values:

- `task_registered`
- `condition_not_met`
- `task_claimed`
- `task_executed`
- `task_expired`
- `task_cancelled`
- `reward_increased`
- `deadline_extended`
- `rewards_withdrawn`
- `paused`
- `fee_updated`
- `admin_transferred`
- `min_reward_updated`
- `fees_swept`
- `initialized`
- `upgraded`
- `reputation_updated`
- `oracle_price_condition_set`

<a id="schema-FeedTasksResponse"></a>

### FeedTasksResponse

Open tasks grouped by oracle feed (oracle address + asset combination).

| Field | Type | Required | Description |
|---|---|---|---|
| `feed` | string | yes | Oracle address + asset identifier (e.g., "GORACLE:USD") |
| `tasks` | array of [TaskByFeed](#schema-TaskByFeed) | yes | Open (pending or claimed) tasks depending on this feed |
| `threshold` | string | yes | Price threshold that triggers these tasks |

<a id="schema-HealthResponse"></a>

### HealthResponse

Service liveness and how far ingestion has reached.

| Field | Type | Required | Description |
|---|---|---|---|
| `backfill_complete` | boolean | yes | Whether the initial catch-up has finished. |
| `healthy` | boolean | yes | False once the lag exceeds the threshold: the difference between a stalled indexer and a healthy but quiet one. |
| `ingestion_lag_ledgers` | integer (int32) \| null, min 0 | no | How many ledgers ingestion is behind the chain; absent until both sides have been observed. Updated every ingestion cycle. |
| `last_ingested_ledger` | integer (int32) \| null, min 0 | no | Highest ledger fully ingested, absent before the first checkpoint. |
| `latest_known_ledger` | integer (int32) \| null, min 0 | no | Highest chain tip ingestion has observed, absent before its first cycle (issue #359). |
| `max_healthy_lag_ledgers` | integer (int32), min 0 | yes | The lag threshold this deployment considers healthy. |
| `status` | string | yes |  |

<a id="schema-IndexedEvent"></a>

### IndexedEvent

One ingested event, with the ledger context needed to order and page it.

This is the exact shape the REST event feed and the WebSocket feed both
emit -- issue 0226 requires a client to need only one parser for both.

| Field | Type | Required | Description |
|---|---|---|---|
| `cursor` | integer (int64) | yes | Monotonic ingestion sequence, and the cursor used for pagination. Assigned by the database on insert, so it is stable: a later ingestion never renumbers an existing row, which is what an offset would do. |
| `event_index` | integer (int32), min 0 | yes | Index of this event within its transaction. |
| `event_type` | [EventType](#schema-EventType) | yes |  |
| `ledger` | integer (int32), min 0 | yes | Ledger this event was emitted in. |
| `ledger_close_time` | integer (int64) | yes | Close time of that ledger, as a Unix timestamp in seconds. |
| `payload` | [EventPayload](#schema-EventPayload) | yes |  |
| `tx_hash` | string | yes | Transaction hash, hex-encoded. |

<a id="schema-KeeperSummary"></a>

### KeeperSummary

Everything the indexer knows about one keeper address.

| Field | Type | Required | Description |
|---|---|---|---|
| `claimed_task_ids` | array of integer (int64), min 0 | yes | Tasks this keeper has claimed. |
| `credited_balance` | string | yes | Earned minus withdrawn. This is the figure the contract's `keeper_balance` view reports once the indexer is caught up. Exposed as its own field so no consumer has to recompute it. |
| `executed_task_ids` | array of integer (int64), min 0 | yes | Tasks this keeper has executed. |
| `keeper` | string | yes |  |
| `total_earned` | string | yes | Sum of `net_reward` across every execution. |
| `total_withdrawn` | string | yes | Sum of every `RewardsWithdrawn` amount. |

<a id="schema-Leaderboard"></a>

### Leaderboard

A ranked leaderboard.

| Field | Type | Required | Description |
|---|---|---|---|
| `entries` | array of [LeaderboardEntry](#schema-LeaderboardEntry) | yes |  |
| `rank_by` | [RankBy](#schema-RankBy) | yes |  |
| `since` | integer (int64) \| null | no | Start of the window as a Unix timestamp, absent for all-time. |

<a id="schema-LeaderboardEntry"></a>

### LeaderboardEntry

One keeper's position on the leaderboard.

| Field | Type | Required | Description |
|---|---|---|---|
| `executions` | integer (int32), min 0 | yes | Tasks executed within the window. |
| `keeper` | string | yes |  |
| `rank` | integer (int32), min 0 | yes | 1-based position after ordering and tie-breaking. |
| `reputation` | string | yes | Current reputation score. |
| `total_reward` | string | yes | Net reward earned within the window. |

<a id="schema-RankBy"></a>

### RankBy

Which metric to rank by.

Type: string. Allowed values:

- `executions`
- `reward`
- `reputation`

<a id="schema-TaskByFeed"></a>

### TaskByFeed

A task grouped by its oracle feed (oracle address + asset).

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes |  |
| `reward` | string | yes |  |
| `status` | string | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |

<a id="schema-TaskDetail"></a>

### TaskDetail

A task's current state together with the events that produced it.

| Field | Type | Required | Description |
|---|---|---|---|
| `history` | array of [IndexedEvent](#schema-IndexedEvent) | yes | Every event for this task, oldest first. |
| `task` | [TaskState](#schema-TaskState) | yes | State folded from the full history below. |

<a id="schema-TaskListResponse"></a>

### TaskListResponse

Tasks belonging to one address.

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | string | yes | The address these tasks were selected by. |
| `next_cursor` | integer (int64) \| null, min 0 | no | Pass as `after` to fetch the next page; absent at the end of the list. |
| `tasks` | array of [TaskState](#schema-TaskState) | yes |  |

<a id="schema-TaskState"></a>

### TaskState

A task's current state, folded from its event history.

Only fields the events actually carry are present. The contract's `Task`
struct also holds `task_type`, `calldata`, `ttl_ledgers` and
`lock_ledgers`, but no event emits them, so they are not reconstructed
here rather than being guessed at.

| Field | Type | Required | Description |
|---|---|---|---|
| `asset` | string \| null | no | Asset identifier for oracle-price-threshold conditions, once set. |
| `claim_ledger` | integer (int32) \| null, min 0 | no | Ledger the claim was taken at. |
| `condition` | string \| null | no | Optional on-chain condition configured when the task was registered. |
| `condition_rejection_count` | integer (int64), min 0 | yes | Number of indexed claim attempts rejected by the condition. |
| `deadline` | integer (int64), min 0 | yes | Live deadline: the registered deadline with every `DeadlineExtended` applied. |
| `keeper` | string \| null | no | Keeper holding the claim, once claimed. |
| `last_ledger` | integer (int32), min 0 | yes | Ledger of the most recent event for this task. |
| `net_reward` | string | yes | Net reward paid on execution, once executed. |
| `oracle_address` | string \| null | no | Oracle address for oracle-price-threshold conditions, once set. |
| `oracle_threshold` | string \| null | no | Price threshold for oracle-price-threshold conditions, once set. |
| `owner` | string | yes |  |
| `reward` | string | yes | Live reward: the registered reward with every `RewardIncreased` folded in. |
| `status` | [TaskStatus](#schema-TaskStatus) | yes |  |
| `task_id` | integer (int64), min 0 | yes |  |

<a id="schema-TaskStatus"></a>

### TaskStatus

Lifecycle state of a task, named to match the contract's `TaskStatus`.

Type: string. Allowed values:

- `pending`
- `claimed`
- `executed`
- `cancelled`
- `expired`

<!--
  Source fragment for docs/INDEXER_API.md, included verbatim by
  scripts/docs/generate-indexer-api.mjs. Links below are relative to
  docs/INDEXER_API.md, not to this file.
-->

## WebSocket event stream

REST routes are described by the OpenAPI document above. WebSocket endpoints
cannot be expressed in OpenAPI 3.1, so the live feed is documented here. The
messages carry the **same event shape as the REST feed**: a client that parses
an [`IndexedEvent`](#schema-IndexedEvent) from `GET /events` needs no second
parser.

This section is maintained by hand in
[`docs/indexer-api/websocket.md`](indexer-api/websocket.md) and is derived from
[`indexer/src/api/websocket.rs`](../indexer/src/api/websocket.rs). Update it in
the same change as any edit to that file.

### Connecting

```
GET /v1/stream            (HTTP upgrade to WebSocket)
```

It is served from the same host and `/v1` prefix as the REST routes. The upgrade request is
rate limited per client exactly like the REST routes (by `X-API-Key` when one is
presented, otherwise by IP address); a client over its limit receives HTTP `429`
instead of an upgrade.

### Subscription filters

Filters are query parameters on the upgrade request and cannot be changed
after connecting. To change a filter, reconnect.

| Parameter | Type | Description |
|---|---|---|
| `event_type` | string | Only events of this type. Use the wire names listed under [`EventType`](#schema-EventType). An unknown name closes the subscription with a `closed` message. |
| `address` | string | Only events that mention this address as owner or keeper. Muxed addresses are normalized before matching. |
| `after` | integer (int64) | Resume from this cursor: every matching event after it is replayed first, then the live feed continues. |

### Server messages

Every message is one JSON text frame with a `kind` discriminator. The client
sends nothing; any frame it does send other than a close is ignored.

| `kind` | Fields | Meaning |
|---|---|---|
| `event` | `event`: an [`IndexedEvent`](#schema-IndexedEvent) | One ingested event. |
| `subscribed` | `event_type`: string or null, `address`: string or null (the normalized form actually filtered on), `replayed_through`: integer or null | Sent once, after any replay, when the live feed is attached. `replayed_through` is the last replayed cursor, or `null` when `after` was not given or nothing was replayed. |
| `closed` | `reason`: string | The server is ending the subscription, and says why. |

Example frames:

```json
{"kind":"subscribed","event_type":"task_claimed","address":null,"replayed_through":null}
```

```json
{"kind":"event","event":{"cursor":1042,"ledger":52113007,"ledger_close_time":1795083330,"tx_hash":"<hex>","event_index":0,"event_type":"task_claimed","payload":{"type":"task_claimed","task_id":7,"keeper":"G...","claim_ledger":52113007}}}
```

```json
{"kind":"closed","reason":"unknown event type: not_a_type"}
```

`ledger_close_time` is a Unix timestamp in seconds. Payload fields vary by event
type; see [`EventPayload`](#schema-EventPayload).

### Ordering, replay and reconnecting

- Replay events arrive first, in cursor order, in pages of 200. `subscribed`
  follows the last replayed event, then live events follow.
- An event is never delivered twice: live events at or below
  `replayed_through` are dropped.
- `cursor` is the same stable, database-assigned cursor the REST feed paginates
  with. Remember the `cursor` of the last event you processed; after a dropped
  connection reconnect with `?after=<that cursor>` to receive anything missed.
- If a replay query fails, the server logs the error and continues to the live
  feed rather than closing, so verify continuity by checking that cursors you
  receive are increasing and, when in doubt, backfill with `GET /events?after=`.

### Slow subscribers

A subscriber that cannot keep up is disconnected rather than allowed to stall
ingestion for everyone else. The server first sends a `closed` message such as
`subscriber fell 128 events behind; reconnect with ?after=<last cursor>` and then
closes the socket. Reconnect with your last cursor to catch up.

### Minimal client

```ts
let lastCursor: number | undefined;

function connect(): void {
  const url = new URL("wss://indexer.example.org/v1/stream");
  url.searchParams.set("event_type", "task_claimed");
  if (lastCursor !== undefined) url.searchParams.set("after", String(lastCursor));

  const socket = new WebSocket(url);
  socket.onmessage = (frame) => {
    const message = JSON.parse(frame.data);
    if (message.kind === "event") {
      lastCursor = message.event.cursor;
      handle(message.event);
    } else if (message.kind === "closed") {
      console.warn("subscription closed:", message.reason);
    }
  };
  socket.onclose = () => setTimeout(connect, 1000); // resume from lastCursor
}
```

The typed client in
[`packages/indexer-client`](../packages/indexer-client) ships a
`subscribeToEvents` helper that decodes these messages. Reconnection is the
caller's responsibility, as in the sketch above.
