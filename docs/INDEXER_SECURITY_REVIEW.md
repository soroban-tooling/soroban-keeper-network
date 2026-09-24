# Indexer public API security review

Review date: 2026-09-24

Reviewed revision: `8b7ba74`

Scope: `indexer/src/api/`, `indexer/src/store.rs`,
`indexer/src/queries/`, the SQLite migrations, `indexer/openapi.yaml`, and
the committed load-test baseline.

## Verdict

The API is **not approved for general availability yet**. The review found
no SQL-injection path and no endpoint that discloses private application
data, but it found three availability and authentication gaps that a
remote client could exploit once the router is exposed publicly. Each gap
has a filed, scoped follow-up:

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| IDX-SEC-01 | High | An arbitrary `X-API-Key` value selects a fresh rate-limit bucket before authentication, and buckets are never evicted. Authentication is not wired into the router. | [#579](https://github.com/soroban-tooling/soroban-keeper-network/issues/579) |
| IDX-SEC-02 | High | Several unauthenticated REST requests can perform or return work that grows with all history for a task or address; arbitrary leaderboard windows can force cache misses. | [#580](https://github.com/soroban-tooling/soroban-keeper-network/issues/580) |
| IDX-SEC-03 | High | Rate limiting charges WebSocket handshakes but does not bound concurrent open sockets, idle lifetime, or total replay work. | [#581](https://github.com/soroban-tooling/soroban-keeper-network/issues/581) |

Closing this review records the findings; it does not waive them. Public
deployment remains blocked on those follow-ups or on an explicit,
maintainer-approved replacement mitigation.

The executable currently does not bind the API router: `indexer/src/main.rs`
opens the store and waits for shutdown. That makes the findings latent in
the checked-in binary, not resolved. The same controls must be in place
before the router is wired to a public listener.

## Threat model

The attacker is an unauthenticated internet client who can send arbitrary
paths, query strings, headers, WebSocket upgrade requests, and socket
traffic. They may open many connections, rotate header values, and choose
valid but worst-case filters. They do not have filesystem or database
access and cannot forge Stellar ledger history.

The assets in scope are:

- availability of REST, WebSocket, ingestion, and the shared SQLite store;
- integrity of indexed results and authentication decisions;
- API credentials and non-public operational configuration; and
- the privacy boundary between public on-chain data and service-private
  data.

The indexer is read-only at its HTTP boundary, so unauthorized on-chain
state changes are not part of this surface. Resource exhaustion, query
amplification, credential handling, and unintended disclosure are.

## SQL injection

**Result: no finding.**

All reviewed SQL statements are static strings. User-controlled values are
passed through `sqlx` bind parameters, including task ids, owner and keeper
addresses, event cursors, event types, API key ids, and leaderboard time
windows. No route concatenates a request value into SQL.

Two values that could otherwise become dynamic SQL are allow-listed before
the store sees them:

- `event_type` is parsed into `EventType`; an unknown value receives `400`.
- `rank_by` is parsed into `RankBy`; ordering is performed in Rust rather
  than interpolated into an `ORDER BY` clause.

Errors returned to clients are typed and generic. Database error text is
logged server-side and is not reflected into the HTTP response. The
unknown enum value is reflected only into a JSON string encoded by Serde,
not into SQL or HTML.

This confirmation depends on continuing the static-query-plus-bind pattern.
Any future endpoint that builds column names, sort expressions, or filter
fragments dynamically requires a new review.

## Disproportionately expensive REST queries

**Result: finding IDX-SEC-02; follow-up #580.**

The event feed is appropriately cursor-paginated and clamps a page to 500
events. The leaderboard clamps output to 200 entries and caches identical
parameter sets. Those controls are useful but do not bound every public
request:

- `GET /v1/owners/{owner}/tasks` and
  `GET /v1/keepers/{keeper}/tasks` load every matching task id, then issue
  another full-history query and fold for each task. Work and response size
  grow without a request-level maximum, and the query count is N+1.
- `GET /v1/tasks/{task_id}` returns and folds the task's complete history.
  Reward increases, deadline extensions, and repeated claims mean that
  history is not structurally limited to a small constant.
- `GET /v1/leaderboard?since=...` accepts arbitrary timestamps. Changing
  `since` on every request defeats the exact-key cache and forces a full
  aggregate scan. The committed baseline identifies this varied-window
  case as the capacity path at 8.2 requests/second on only 4,000 events in
  a debug build.

The current token bucket is not a sufficient compensating control because
IDX-SEC-01 lets a caller rotate unverified `X-API-Key` values to obtain new
buckets. Even after that bypass is fixed, a request-rate limit does not by
itself make unbounded per-request work safe as retained history grows.

Follow-up #580 requires pagination and hard request bounds, removal of the
N+1 list pattern, a policy for high-cardinality aggregate windows, and a
load test for the resulting worst case.

## WebSocket connection exhaustion

**Result: finding IDX-SEC-03; follow-up #581.**

The upgrade request passes through the same token bucket as REST, and a
lagging broadcast receiver is disconnected instead of blocking ingestion.
Those are positive controls, but they do not bound retained resources:

- the limiter controls connection *rate*, not the number of sockets held
  open concurrently;
- there is no global or per-client connection cap;
- a quiet peer has no server-enforced heartbeat or idle deadline; and
- `?after=` replay fetches batches of 200 until it reaches the live edge,
  with no total rows, elapsed-time, or bytes budget for one connection.

A client can therefore open sockets slowly enough to stay within the
handshake rate and retain them, or repeatedly request long replays. Slow
subscriber handling protects the broadcast producer but does not address
this connection and replay exhaustion path.

Follow-up #581 requires held connection permits, global and per-client
caps, bounded resumable replay, idle handling, metrics, and churn tests.

## Authentication and rate-limit identity

**Result: finding IDX-SEC-01; follow-up #579.**

`api/auth.rs` has sound intent: plaintext keys are returned only at
issuance, revoked keys are checked from storage on each request, and the
administrative issue/list/revoke methods have no public HTTP routes.
However, that module is not connected to `api::router`.

In contrast, `api/rate_limit.rs` treats any non-empty `X-API-Key` value as
the client's identity without verifying it. Rotating that value creates a
full new burst allowance and a new `HashMap` entry. Entries have no expiry
or size bound, and the key string itself is retained in memory. The stored
credential digest is also documented in code as a 64-bit FNV-1a
placeholder, which is not acceptable before credentials are issued
outside the project.

Follow-up #579 joins authentication to rate limiting, uses only a verified
non-secret key id for identity, preserves immediate revocation, replaces
the placeholder digest, and bounds limiter memory. Until it lands, API
keys must not be issued and `X-API-Key` must not be advertised as a higher
trust or higher capacity tier.

## Data exposure

**Result: no unintended-data finding.**

The core API intentionally republishes information already observable in
the configured registry contract's event stream. The exposure review is:

| Surface | Data returned | Public-data boundary |
| --- | --- | --- |
| Task detail and address task lists | task ids, owner/keeper addresses, rewards, deadlines, status, proofs, and event history | Values are emitted on chain or deterministically folded from those events. |
| Event REST feed and WebSocket stream | decoded payload, ledger/time, transaction hash, event index, and a local pagination cursor | Payload and ledger metadata are public chain data. The local cursor reveals ordering only and is not a secret. |
| Admin configuration | admin, reward token, fee settings, pause state, upgrade hash, and swept totals | Emitted public contract configuration and deterministic totals. |
| Leaderboard and statistics | aggregate counts and rewards | Derived exclusively from public indexed events. |
| Health | last ingested ledger and backfill status | Service-operational metadata, intentionally public for consumer freshness checks; it contains no host, database, or credential detail. |

The address filter matches only the indexed `owner_address` or
`keeper_address` columns and returns the same event representation as the
unfiltered public feed. It does not join to the `api_keys` table, expose
labels or hashes, return the database URL, or include internal errors.
An address's activity is therefore no more private than its on-chain
events, and the endpoint adds no off-chain identity or account data.

The API does not expose calldata or every field of the on-chain `Task`
struct because those values are not present in the indexed event schema.
That is a completeness limitation, not an over-disclosure.

## Release gate

Before describing this surface as production-ready, maintainers must:

1. Close #579, #580, and #581, or document reviewed replacement
   mitigations that meet the same bounds.
2. Re-run the REST and WebSocket load tests with the security limits
   enabled and record the configured limits with the result.
3. Exercise the fully wired server through its real listener so transport
   IP extraction, proxy configuration, upgrade rejection, and disconnect
   cleanup are tested end to end.
4. Confirm deployment logs and metrics never contain plaintext API keys.

This review is source-based. It did not claim a live deployment or perform
internet-facing penetration testing, because the reviewed executable does
not currently start the API server.
