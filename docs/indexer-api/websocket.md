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
