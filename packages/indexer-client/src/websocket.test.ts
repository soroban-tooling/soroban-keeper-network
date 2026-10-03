import { describe, expect, it, vi } from "vitest";

import { subscribeToEvents, type WebSocketConstructorLike, type WebSocketLike } from "./websocket.js";

/** A minimal, fully in-memory stand-in for the browser `WebSocket`, driven by the test rather than a real socket. */
class FakeWebSocket extends EventTarget implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitClose(init: { wasClean: boolean; code: number; reason: string }): void {
    // Node 20 (the CI runtime) has no global CloseEvent; a plain Event with the
    // same fields is what the client reads.
    this.dispatchEvent(Object.assign(new Event("close"), init));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

function freshFakeSocketCtor(): WebSocketConstructorLike {
  FakeWebSocket.instances = [];
  return FakeWebSocket as unknown as WebSocketConstructorLike;
}

describe("subscribeToEvents", () => {
  it("opens the stream URL with eventType/address/after as query parameters", () => {
    const Ctor = freshFakeSocketCtor();
    subscribeToEvents(
      "wss://indexer.example.org/v1/stream",
      { eventType: "task_claimed", address: "GKEEPER", after: 42 },
      { onMessage: vi.fn() },
      Ctor,
    );

    const socket = FakeWebSocket.instances[0]!;
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/v1/stream");
    expect(url.searchParams.get("event_type")).toBe("task_claimed");
    expect(url.searchParams.get("address")).toBe("GKEEPER");
    expect(url.searchParams.get("after")).toBe("42");
  });

  it("parses and dispatches each recognised ServerMessage kind", () => {
    const Ctor = freshFakeSocketCtor();
    const onMessage = vi.fn();
    subscribeToEvents("wss://indexer.example.org/v1/stream", {}, { onMessage }, Ctor);
    const socket = FakeWebSocket.instances[0]!;

    socket.emitMessage(
      JSON.stringify({ kind: "subscribed", event_type: null, address: null, replayed_through: null }),
    );
    socket.emitMessage(
      JSON.stringify({
        kind: "event",
        event: {
          cursor: 1,
          ledger: 100,
          ledger_close_time: 1700000000,
          tx_hash: "abc",
          event_index: 0,
          event_type: "task_claimed",
          payload: { type: "task_claimed", task_id: 1, keeper: "GKEEPER", claim_ledger: 100 },
        },
      }),
    );
    socket.emitMessage(JSON.stringify({ kind: "closed", reason: "server shutting down" }));

    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[0]![0]).toMatchObject({ kind: "subscribed" });
    expect(onMessage.mock.calls[1]![0]).toMatchObject({ kind: "event" });
    expect(onMessage.mock.calls[2]![0]).toMatchObject({ kind: "closed", reason: "server shutting down" });
  });

  it("routes unparseable JSON to onParseError instead of throwing or calling onMessage", () => {
    const Ctor = freshFakeSocketCtor();
    const onMessage = vi.fn();
    const onParseError = vi.fn();
    subscribeToEvents("wss://indexer.example.org/v1/stream", {}, { onMessage, onParseError }, Ctor);
    const socket = FakeWebSocket.instances[0]!;

    socket.emitMessage("{not json");

    expect(onMessage).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0]![0]).toBe("{not json");
  });

  it("routes a well-formed JSON message with an unrecognised kind to onParseError", () => {
    const Ctor = freshFakeSocketCtor();
    const onMessage = vi.fn();
    const onParseError = vi.fn();
    subscribeToEvents("wss://indexer.example.org/v1/stream", {}, { onMessage, onParseError }, Ctor);
    const socket = FakeWebSocket.instances[0]!;

    socket.emitMessage(JSON.stringify({ kind: "something_new" }));

    expect(onMessage).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
  });

  it("forwards close and error events", () => {
    const Ctor = freshFakeSocketCtor();
    const onClose = vi.fn();
    const onError = vi.fn();
    subscribeToEvents("wss://indexer.example.org/v1/stream", {}, { onMessage: vi.fn(), onClose, onError }, Ctor);
    const socket = FakeWebSocket.instances[0]!;

    socket.emitError();
    socket.emitClose({ wasClean: false, code: 1006, reason: "abnormal closure" });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ wasClean: false, code: 1006, reason: "abnormal closure" });
  });

  it("close() closes the underlying socket and further messages are not delivered", () => {
    const Ctor = freshFakeSocketCtor();
    const onMessage = vi.fn();
    const subscription = subscribeToEvents("wss://indexer.example.org/v1/stream", {}, { onMessage }, Ctor);
    const socket = FakeWebSocket.instances[0]!;

    subscription.close();
    expect(socket.closed).toBe(true);

    socket.emitMessage(JSON.stringify({ kind: "closed", reason: "irrelevant" }));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
