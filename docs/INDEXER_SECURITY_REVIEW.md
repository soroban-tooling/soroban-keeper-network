# Indexer public API security review

Review date: 2026-11-19

Code baseline: `22fc723c` plus the controls in the pull request containing
this document.

Scope: `indexer/src/api/`, `indexer/src/store.rs`, `indexer/src/queries/`,
SQLite migrations, `indexer/openapi.yaml`, and the committed load-test
baseline.

## Verdict

The checked-in API has authentication-aware rate limiting, bounded REST
queries, validated WebSocket filters, held-connection caps, bounded replay,
and idle connection expiry. These controls address the source-level findings
from the prior review. General availability still requires the deployment
checks in the release gate below; source review does not establish correct
proxy configuration or live capacity.

## Route, authentication, and limit matrix

All routes accept anonymous callers because they return public on-chain data
or service health. A valid API key selects a stable non-secret key identity
and its configured request tier. A presented invalid or revoked key receives
`401` and never falls back to anonymous access. Every HTTP request, including
a WebSocket upgrade, passes through the same token bucket: 20 requests/second
with a burst of 40 by default, configurable by deployment. Limiter storage is
bounded to 10,000 inactive-evictable identities.

| Route | Authentication | Input and work bounds |
|---|---|---|
| `GET /v1/health` | Public; optional API key | Fixed-size response; no user query input. |
| `GET /v1/tasks/{task_id}` | Public; optional API key | Numeric task id; history defaults to 50 and is capped at 200 events. |
| `GET /v1/owners/{owner}/tasks` | Public; optional API key | Stellar address validation; cursor pagination defaults to 50 and is capped at 200 tasks. |
| `GET /v1/keepers/{keeper}/tasks` | Public; optional API key | Stellar address validation; cursor pagination defaults to 50 and is capped at 200 tasks. |
| `GET /v1/admin/config` | Public; optional API key | Fixed-size fold of public contract administration events. It exposes no API keys, environment variables, or database settings. |
| `GET /v1/feeds/open-tasks` | Public; optional API key | Typed feed filter and bounded task page. |
| `GET /v1/leaderboard` | Public; optional API key | Result limit capped at 200; ranking mode is an enum; time windows are normalized to minute boundaries before cache lookup. |
| `GET /v1/events` | Public; optional API key | Cursor pagination defaults to 50 and is capped at 500; event type is an enum and address filters are validated. |
| `GET /v1/stream` | Public; optional API key | Upgrade is rate charged. Maximum 8 held sockets per verified key/IP and 256 per process; one immutable filter set per socket; replay capped at 5,000 events; 60-second inactivity expiry. |

Administrative API-key issuance, listing, and revocation functions have no
HTTP route. They remain operator-only library operations. Plaintext secrets
exist only at issuance; storage contains a domain-separated SHA-256 digest and
public key id.

## Input validation

- SQL statements are static and all caller values use `sqlx` bind parameters.
- Event and ranking names are parsed into enums before reaching storage.
- Account and contract filters use Stellar StrKey normalization; malformed
  WebSocket filters receive `400` before the protocol upgrade.
- Pagination limits are clamped at the handler boundary. Unknown cursors yield
  an empty page or a typed client error, never an unbounded scan.
- Internal database errors are logged server-side and returned as the generic
  `internal_error` shape.

No reviewed path concatenates a caller value into SQL, HTML, a filesystem
path, or a process invocation.

## WebSocket resource controls

Request-rate limiting alone does not control resources retained after an
upgrade. `WebSocketLimits` therefore owns two independent semaphores:

- a global 256-connection permit pool;
- an 8-connection pool for each identity already verified by rate-limit
  middleware.

The permit is held for the socket lifetime and released on every exit path.
Empty per-client pools are removed from the identity map. A client cannot mint
pools by rotating unverified API-key values because invalid keys are rejected
before `ClientIdentity` is attached to the request.

Replay reads at most 200 events per database call and 5,000 per connection.
At the exact boundary the server sends a resumable close reason containing the
last cursor. The live subscription is a broadcast receiver, so subscribers do
not issue per-event database queries. A lagging receiver or a connection idle
for 60 seconds is closed with a resumable reason.

Focused tests cover malformed filters, exact replay-page boundaries, global
connection exhaustion, per-client exhaustion, permit release, lag handling,
filtered replay, and fan-out to many subscribers.

## Prior finding resolution

| Finding | Resolution |
|---|---|
| IDX-SEC-01: unverified API-key values selected unbounded limiter buckets | Keys are verified before identity selection; invalid/revoked keys return `401`; buckets use non-secret ids and have capacity/TTL eviction. |
| IDX-SEC-02: REST work grew without hard request bounds | Task history and address lists are paginated and capped; leaderboard outputs and cache windows are bounded; the event feed remains cursor paginated. |
| IDX-SEC-03: WebSocket handshakes were charged but retained resources were unlimited | Held sockets now have per-client/global permits, filters validate before upgrade, replay is capped, and idle/lagged sessions close resumably. |

## Data exposure

Task state, addresses, rewards, proofs, contract configuration, event ordering,
and aggregates are already public on the configured ledger. The API adds a
local event cursor and ingestion-health metadata. It does not join public data
to API-key records, return credential hashes, expose database URLs, or reflect
internal errors. `/admin/config` is intentionally public because it is a fold
of public contract events, not the indexer process configuration.

## Accepted residual risks

- Connection caps are per process. A multi-replica deployment must also set a
  fleet-wide reverse-proxy cap and capacity alert.
- Anonymous identity depends on transport `ConnectInfo`. A proxy must pass the
  intended client address through a reviewed trust boundary; arbitrary
  forwarded headers are not consumed directly.
- API rate and socket defaults are defensive starting values, not a substitute
  for load testing against the deployment's database and retention volume.
- A reconnecting client can consume another bounded replay window. Request and
  connection-rate controls limit that churn but do not prove economic
  resistance to a distributed denial-of-service attack.

## Release gate

Before public deployment, maintainers must:

1. Run REST and WebSocket load/churn tests with production-equivalent history,
   proxying, and the configured limits.
2. Verify transport IP extraction and ensure untrusted forwarded headers do
   not select identities.
3. Alert on rejected upgrades, active sockets, replay-limit closes, limiter
   saturation, ingestion lag, and database latency.
4. Confirm logs and metrics never contain plaintext API keys.
5. Record the test output and configuration snapshot in the release evidence
   linked from `docs/MAINNET_READINESS.md`.
