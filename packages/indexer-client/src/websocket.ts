// Typed subscription helper for the indexer's live event feed
// (`indexer/src/api/websocket.rs`'s `/v1/stream`, issue 0226). Delivers the
// same `IndexedEvent` shape `IndexerClient.eventFeed` does -- see
// `ServerMessage`'s doc comment in `types.ts` -- so a consumer needs no
// second parser for "the same event, but live" versus "a page of history".

import type { ServerMessage, SubscribeOptions } from "./types.js";

/** The subset of the standard `WebSocket` constructor this module depends on -- declared structurally so a test (or a Node runtime without a global `WebSocket`) can supply a stand-in. */
export type WebSocketLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "close"
>;

export type WebSocketConstructorLike = new (url: string | URL) => WebSocketLike;

export interface SubscriptionHandlers {
  /** Called once per message the server sends, already parsed and typed as {@link ServerMessage}. */
  onMessage: (message: ServerMessage) => void;
  /** A message whose body was not valid JSON, or not a recognised `ServerMessage` shape — the connection is not closed for this alone. */
  onParseError?: (raw: string, cause: unknown) => void;
  /** The socket closed, cleanly or not. `wasClean`/`code`/`reason` are the standard `CloseEvent` fields. */
  onClose?: (event: { wasClean: boolean; code: number; reason: string }) => void;
  /** A transport-level error. The socket also closes immediately after; `onClose` still fires. */
  onError?: (event: unknown) => void;
}

export interface Subscription {
  /** Closes the underlying WebSocket. Safe to call more than once. */
  close: () => void;
}

/**
 * Opens `/v1/stream`, decodes each frame as a {@link ServerMessage}, and
 * dispatches it to `handlers.onMessage`. Filters (`eventType`/`address`) and
 * resumption (`after`) are query parameters on the upgrade request, applied
 * server-side — see {@link SubscribeOptions}.
 *
 * Reconnection is the caller's responsibility: on `onClose`, resubscribe
 * with `after` set to the last event's `cursor` this handler saw, so the
 * server replays anything missed (`ServerMessage`'s `subscribed.replayed_through`
 * confirms how far back the replay went) rather than leaving a gap.
 */
export function subscribeToEvents(
  streamUrl: string,
  options: SubscribeOptions,
  handlers: SubscriptionHandlers,
  WebSocketImpl: WebSocketConstructorLike = getGlobalWebSocket(),
): Subscription {
  const url = new URL(streamUrl);
  if (options.eventType !== undefined) url.searchParams.set("event_type", options.eventType);
  if (options.address !== undefined) url.searchParams.set("address", options.address);
  if (options.after !== undefined) url.searchParams.set("after", String(options.after));

  const socket = new WebSocketImpl(url);

  const onMessageEvent = (event: Event): void => {
    const data = (event as MessageEvent).data;
    const raw = typeof data === "string" ? data : String(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      handlers.onParseError?.(raw, cause);
      return;
    }
    if (!isServerMessage(parsed)) {
      handlers.onParseError?.(raw, new Error(`unrecognised message shape: ${raw.slice(0, 200)}`));
      return;
    }
    handlers.onMessage(parsed);
  };

  const onCloseEvent = (event: Event): void => {
    const closeEvent = event as CloseEvent;
    handlers.onClose?.({
      wasClean: closeEvent.wasClean,
      code: closeEvent.code,
      reason: closeEvent.reason,
    });
  };

  const onErrorEvent = (event: Event): void => {
    handlers.onError?.(event);
  };

  socket.addEventListener("message", onMessageEvent);
  socket.addEventListener("close", onCloseEvent);
  socket.addEventListener("error", onErrorEvent);

  return {
    close: () => {
      socket.removeEventListener("message", onMessageEvent);
      socket.removeEventListener("close", onCloseEvent);
      socket.removeEventListener("error", onErrorEvent);
      socket.close();
    },
  };
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return kind === "subscribed" || kind === "event" || kind === "closed";
}

function getGlobalWebSocket(): WebSocketConstructorLike {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "No global WebSocket is available in this runtime (Node < 22 has none by default). " +
        "Pass a WebSocket implementation explicitly as subscribeToEvents's fourth argument.",
    );
  }
  return WebSocket;
}
