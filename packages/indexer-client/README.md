# @soroban-keeper-network/indexer-client

A thin, typed TypeScript client for the [event indexer](../../indexer)'s
REST and WebSocket APIs (`epic E17`'s web dashboard, or any other
browser/Node consumer that wants indexed history without talking to Soroban
RPC directly). This is a distinct concern from
[`@soroban-keeper-network/sdk`](../sdk-ts): that package talks to the
`keeper-registry` contract itself; this one talks to the indexer's own HTTP
API, which reads from a database the indexer has already ingested into.

## Usage

```ts
import { IndexerClient, subscribeToEvents } from "@soroban-keeper-network/indexer-client";

const client = new IndexerClient({ baseUrl: "https://indexer.example.org/v1" });

const { tasks } = await client.tasksByKeeper("GKEEPER...");
const board = await client.leaderboard({ rankBy: "reward", limit: 10 });

// Live feed — the same IndexedEvent shape the REST /events page returns.
const subscription = subscribeToEvents(
  "wss://indexer.example.org/v1/stream",
  { eventType: "task_claimed" },
  {
    onMessage: (message) => {
      if (message.kind === "event") console.log(message.event);
    },
  },
);
// subscription.close() when done.
```

Every REST method maps one-to-one to an [`indexer/openapi.yaml`](../../indexer/openapi.yaml)
operation: `health()`, `adminConfig()`, `eventFeed(params)`, `leaderboard(params)`,
`tasksByKeeper(keeper)`, `tasksByOwner(owner)`, `getTask(taskId)`.

## Types are generated, not hand-maintained

`src/generated/openapi-types.ts` is produced by the `openapi-typescript` npm
package — **do not hand-edit it**. `src/types.ts` re-exports friendly aliases
(`AdminConfig`, `TaskState`, ...) over that file's `components["schemas"]`
namespace, so this package's public API surface (and every consumer's code)
never touches the generated names directly, while every field keeps its
exact wire shape (including `snake_case` names) — no separate hand-written
mirror of the schema that could itself drift from it.

```bash
npm run generate:types   # regenerates src/generated/openapi-types.ts from indexer/openapi.yaml
```

CI (the `indexer-client` job in `.github/workflows/ci.yml`) runs this and
fails the build if it changes anything uncommitted — a handler change that
isn't reflected in `indexer/openapi.yaml`, or an `openapi.yaml` edit this
package's types weren't regenerated from, is a red check, not something a
contributor has to remember to notice.

One exception: `ServerMessage` (the WebSocket protocol's own message
envelope, `indexer/src/api/websocket.rs`) is **not** in `openapi.yaml` —
OpenAPI describes HTTP request/response shapes, not a WebSocket protocol —
so it's hand-kept in sync with the Rust source in `src/types.ts` instead. It
reuses the generated `IndexedEvent` type for its `event` variant rather than
redefining it, so drift in the shared event shape is still caught the same
way.

## Testing without a live indexer

`IndexerClient` takes an injectable `fetchFn` and `subscribeToEvents` takes
an injectable `WebSocket` constructor — the same seam
`@soroban-keeper-network/sdk`'s `RpcServerLike` establishes for the registry
client — so both are fully unit-testable without a network. See
`src/client.test.ts` and `src/websocket.test.ts`.
