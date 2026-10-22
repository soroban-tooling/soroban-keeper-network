import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildStreamUrl,
  formatEventLine,
  resolveEventType,
} from "../src/commands/events.js";
import {
  CONTRACT_ID,
  EventsFakeRpc,
  KEEPER,
  OWNER,
  claimed,
  indexerEventMessage,
  jsonLines,
  registered,
  rpcEvent,
  runCli,
  scriptedSocket,
  u64,
} from "./support/harness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const WATCH = ["events", "watch"];

describe("skn events watch: polling getEvents", () => {
  it("prints one line per event", async () => {
    const rpc = new EventsFakeRpc([[registered("e1", 100, 7), claimed("e2", 101, 7)]]);
    const result = await runCli([...WATCH, "--count", "2"], { rpc });

    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `ledger=100 task_registered task_id=7 owner=${OWNER} reward=1000 deadline=1900000000 tx=tx-e1`,
    );
    expect(lines[1]).toBe(`ledger=101 task_claimed task_id=7 keeper=${KEEPER} claim_ledger=101 tx=tx-e2`);
  });

  it("starts from the latest ledger and filters by this contract", async () => {
    const rpc = new EventsFakeRpc([[registered("e1", 100, 7)]]);
    await runCli([...WATCH, "--count", "1"], { rpc });

    expect(rpc.requests[0]).toMatchObject({
      startLedger: 1_000, // FakeRpc's latest ledger
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
    });
  });

  it("starts from --from-ledger when given", async () => {
    const rpc = new EventsFakeRpc([[registered("e1", 600, 7)]]);
    await runCli([...WATCH, "--from-ledger", "500", "--count", "1"], { rpc });

    expect(rpc.requests[0]).toMatchObject({ startLedger: 500 });
  });

  it("prints JSON lines with --json", async () => {
    const rpc = new EventsFakeRpc([[registered("e1", 100, 7), claimed("e2", 101, 7)]]);
    const result = await runCli([...WATCH, "--json", "--count", "2"], { rpc });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const docs = jsonLines(result.stdout);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({
      type: "task_registered",
      ledger: 100,
      txHash: "tx-e1",
      taskId: "7",
      payload: { task_id: 7, owner: OWNER, reward: "1000", deadline: 1_900_000_000 },
    });
    expect(docs[1]).toMatchObject({ type: "task_claimed", taskId: "7" });
  });

  it("filters by --type, accepting the indexer name, the PascalCase name or the topic verb", async () => {
    for (const spelling of ["task_claimed", "TaskClaimed", "claim"]) {
      const rpc = new EventsFakeRpc([[registered("e1", 100, 7), claimed("e2", 101, 7)]]);
      const result = await runCli([...WATCH, "--type", spelling, "--count", "1"], { rpc });

      expect(result.code).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(result.stdout).toContain("task_claimed");
      expect(result.stdout).not.toContain("task_registered");
    }
  });

  it("asks the RPC for just the requested topics when --type is given", async () => {
    const rpc = new EventsFakeRpc([[claimed("e1", 101, 7)]]);
    await runCli([...WATCH, "--type", "task_claimed", "--count", "1"], { rpc });

    const filter = (rpc.requests[0]?.filters as { topics?: string[][] }[])[0];
    expect(filter?.topics).toHaveLength(1);
    expect(filter?.topics?.[0]).toHaveLength(2); // verb and noun, as base64 ScVals
  });

  it("filters by --task", async () => {
    const rpc = new EventsFakeRpc([
      [registered("e1", 100, 7), registered("e2", 101, 8), claimed("e3", 102, 8)],
    ]);
    const result = await runCli([...WATCH, "--task", "8", "--count", "2", "--json"], { rpc });

    expect(result.code).toBe(0);
    expect(jsonLines(result.stdout).map((d) => d.taskId)).toEqual(["8", "8"]);
  });

  it("combines --type and --task", async () => {
    const rpc = new EventsFakeRpc([
      [registered("e1", 100, 8), claimed("e2", 101, 7), claimed("e3", 102, 8)],
    ]);
    const result = await runCli([...WATCH, "--type", "claim", "--task", "8", "--count", "1", "--json"], {
      rpc,
    });

    const docs = jsonLines(result.stdout);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: "task_claimed", taskId: "8", ledger: 102 });
  });

  it("continues from the RPC cursor and never prints an event twice", async () => {
    const rpc = new EventsFakeRpc([
      [registered("e1", 100, 7)],
      [registered("e1", 100, 7), claimed("e2", 101, 7)], // e1 again, as a page boundary can do
    ]);
    const result = await runCli([...WATCH, "--count", "2", "--json"], { rpc });

    expect(jsonLines(result.stdout).map((d) => d.type)).toEqual(["task_registered", "task_claimed"]);
    expect(rpc.requests[1]).toMatchObject({ cursor: "cursor-1" });
    expect(rpc.requests[1]).not.toHaveProperty("startLedger");
  });

  it("waits between polls and stops when interrupted", async () => {
    const rpc = new EventsFakeRpc([]);
    const result = await runCli([...WATCH, "--interval", "250"], { rpc, maxSleeps: 3 });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.sleeps).toEqual([250, 250, 250]);
    expect(rpc.requests).toHaveLength(3);
  });

  it("tags an event it does not recognise instead of failing", async () => {
    const rpc = new EventsFakeRpc([
      [rpcEvent("e1", 100, "stkdep", "stake", [u64(1)]), registered("e2", 101, 7)],
    ]);
    const result = await runCli([...WATCH, "--count", "2", "--json"], { rpc });

    expect(result.code).toBe(0);
    const docs = jsonLines(result.stdout);
    expect(docs[0]).toMatchObject({ type: "stkdep.stake", payload: { values: [1] } });
    expect(docs[1]).toMatchObject({ type: "task_registered" });
  });

  it("does not print unrecognised events when --type is set", async () => {
    const rpc = new EventsFakeRpc([[rpcEvent("e1", 100, "stkdep", "stake", [u64(1)]), claimed("e2", 101, 7)]]);
    const result = await runCli([...WATCH, "--type", "task_claimed", "--count", "1", "--json"], { rpc });

    expect(jsonLines(result.stdout)).toHaveLength(1);
  });

  it("retries a transient RPC failure with a warning", async () => {
    const rpc = new EventsFakeRpc([new Error("socket hang up"), [registered("e1", 100, 7)]]);
    const result = await runCli([...WATCH, "--count", "1"], { rpc });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("getEvents failed (socket hang up); retrying.");
    expect(result.stdout).toContain("task_registered");
  });

  it("gives up with exit code 4 after repeated RPC failures", async () => {
    const failures = Array.from({ length: 5 }, () => new Error("connect ECONNREFUSED"));
    const rpc = new EventsFakeRpc(failures);
    const result = await runCli([...WATCH, "--count", "1"], { rpc });

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("error[rpc_error]");
    expect(result.stdout).toBe("");
  });

  it("prints a JSON error object on stderr under --json", async () => {
    const failures = Array.from({ length: 5 }, () => new Error("connect ECONNREFUSED"));
    const result = await runCli([...WATCH, "--json"], { rpc: new EventsFakeRpc(failures) });

    expect(result.code).toBe(4);
    expect(jsonLines(result.stderr).at(-1)).toMatchObject({ error: { code: "rpc_error", exitCode: 4 } });
  });
});

describe("skn events watch: indexer stream", () => {
  const INDEXER = { SKN_INDEXER_URL: "https://indexer.example.org" };

  const registeredMsg = (cursor: number, taskId = 7) =>
    indexerEventMessage(cursor, "task_registered", {
      task_id: taskId,
      owner: OWNER,
      reward: "1000",
      deadline: 1_900_000_000,
    });
  const claimedMsg = (cursor: number, taskId = 7) =>
    indexerEventMessage(cursor, "task_claimed", { task_id: taskId, keeper: KEEPER, claim_ledger: 101 }, 101);

  it("streams from /v1/stream and prints one line per event, without polling", async () => {
    const { Socket, urls } = scriptedSocket([[registeredMsg(5), claimedMsg(6)]]);
    const rpc = new EventsFakeRpc([]);
    const result = await runCli([...WATCH, "--count", "2"], {
      env: INDEXER,
      WebSocketImpl: Socket,
      rpc,
    });

    expect(result.code).toBe(0);
    expect(urls).toEqual(["wss://indexer.example.org/v1/stream"]);
    expect(rpc.requests).toHaveLength(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toEqual([
      `ledger=100 task_registered task_id=7 owner=${OWNER} reward=1000 deadline=1900000000 tx=tx-5`,
      `ledger=101 task_claimed task_id=7 keeper=${KEEPER} claim_ledger=101 tx=tx-6`,
    ]);
  });

  it("prints JSON lines with --json, dropping the payload's type tag", async () => {
    const { Socket } = scriptedSocket([[registeredMsg(5)]]);
    const result = await runCli([...WATCH, "--json", "--count", "1"], {
      env: INDEXER,
      WebSocketImpl: Socket,
    });

    expect(jsonLines(result.stdout)[0]).toEqual({
      type: "task_registered",
      ledger: 100,
      txHash: "tx-5",
      cursor: 5,
      taskId: "7",
      payload: { task_id: 7, owner: OWNER, reward: "1000", deadline: 1_900_000_000 },
    });
  });

  it("passes --type to the server and filters again locally", async () => {
    const { Socket, urls } = scriptedSocket([[claimedMsg(5), registeredMsg(6)]]);
    const result = await runCli([...WATCH, "--type", "reg", "--count", "1"], {
      env: INDEXER,
      WebSocketImpl: Socket,
    });

    expect(urls[0]).toBe("wss://indexer.example.org/v1/stream?event_type=task_registered");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("task_registered");
  });

  it("filters by --task", async () => {
    const { Socket } = scriptedSocket([[registeredMsg(5, 7), registeredMsg(6, 8), claimedMsg(7, 8)]]);
    const result = await runCli([...WATCH, "--task", "8", "--count", "2", "--json"], {
      env: INDEXER,
      WebSocketImpl: Socket,
    });

    expect(jsonLines(result.stdout).map((d) => [d.cursor, d.taskId])).toEqual([
      [6, "8"],
      [7, "8"],
    ]);
  });

  it("reconnects from the last cursor it saw", async () => {
    const { Socket, urls } = scriptedSocket([[registeredMsg(5)], [claimedMsg(6)]]);
    const result = await runCli([...WATCH, "--count", "2", "--json"], {
      env: INDEXER,
      WebSocketImpl: Socket,
    });

    expect(result.code).toBe(0);
    expect(urls).toEqual([
      "wss://indexer.example.org/v1/stream",
      "wss://indexer.example.org/v1/stream?after=5",
    ]);
    expect(jsonLines(result.stdout).map((d) => d.cursor)).toEqual([5, 6]);
    expect(result.stderr).toContain("reconnecting");
  });

  it("skips events the server replays that were already printed", async () => {
    const { Socket } = scriptedSocket([[registeredMsg(5)], [registeredMsg(5), claimedMsg(6)]]);
    const result = await runCli([...WATCH, "--count", "2", "--json"], {
      env: INDEXER,
      WebSocketImpl: Socket,
    });

    expect(jsonLines(result.stdout).map((d) => d.cursor)).toEqual([5, 6]);
  });

  it("reconnects after the server says it is closing the subscription", async () => {
    const closing = JSON.stringify({ kind: "closed", reason: "server restarting" });
    const { Socket, urls } = scriptedSocket([[registeredMsg(5), closing], [claimedMsg(6)]]);
    const result = await runCli([...WATCH, "--count", "2"], { env: INDEXER, WebSocketImpl: Socket });

    expect(result.code).toBe(0);
    expect(urls).toHaveLength(2);
    expect(result.stderr).toContain("server restarting");
  });

  it("ignores the subscribed handshake and unreadable frames", async () => {
    const subscribed = JSON.stringify({ kind: "subscribed", event_type: null, address: null, replayed_through: null });
    const { Socket } = scriptedSocket([[subscribed, "not json", registeredMsg(5)]]);
    const result = await runCli([...WATCH, "--count", "1"], { env: INDEXER, WebSocketImpl: Socket });

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("unreadable");
  });

  it("gives up with exit code 4 when the stream keeps closing without delivering anything", async () => {
    const { Socket, urls } = scriptedSocket([[], [], [], [], []]);
    const result = await runCli([...WATCH], { env: INDEXER, WebSocketImpl: Socket });

    expect(result.code).toBe(4);
    expect(urls).toHaveLength(5);
    expect(result.stderr).toContain("Giving up");
  });

  it("backs off between reconnects", async () => {
    const { Socket } = scriptedSocket([[], [], [], [], []]);
    const result = await runCli([...WATCH], { env: INDEXER, WebSocketImpl: Socket });

    expect(result.sleeps).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  it("takes the indexer URL from --indexer-url", async () => {
    const { Socket, urls } = scriptedSocket([[registeredMsg(5)]]);
    await runCli([...WATCH, "--indexer-url", "http://localhost:8080/v1", "--count", "1"], {
      WebSocketImpl: Socket,
    });

    expect(urls[0]).toBe("ws://localhost:8080/v1/stream");
  });

  it("falls back to polling, with a warning, when the runtime has no WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const rpc = new EventsFakeRpc([[registered("e1", 100, 7)]]);
    const result = await runCli([...WATCH, "--count", "1"], {
      env: INDEXER,
      WebSocketImpl: null,
      rpc,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("polling getEvents instead");
    expect(rpc.requests).toHaveLength(1);
    expect(result.stdout).toContain("task_registered");
  });
});

describe("skn events watch: usage errors", () => {
  it.each([
    [["--type", "banana"], "Unknown event type"],
    [["--task", "seven"], "--task"],
    [["--count", "0"], "at least 1"],
    [["--count", "many"], "--count"],
    [["--interval", "soon"], "--interval"],
    [["--from-ledger", "-1"], "--from-ledger"],
    [["--indexer-url", "ftp://indexer.example.org"], "must start with"],
  ])("rejects %j", async (flags, message) => {
    const { Socket } = scriptedSocket([]);
    const result = await runCli([...WATCH, ...flags], {
      rpc: new EventsFakeRpc([]),
      WebSocketImpl: Socket,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("needs a registry contract", async () => {
    const result = await runCli(WATCH, { env: { SKN_CONTRACT_ID: undefined } });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SKN_CONTRACT_ID");
  });

  it("does not need a signing key", async () => {
    const rpc = new EventsFakeRpc([[registered("e1", 100, 7)]]);
    const result = await runCli([...WATCH, "--count", "1"], {
      rpc,
      env: { SKN_SECRET_KEY: undefined },
    });

    expect(result.code).toBe(0);
  });
});

describe("event helpers", () => {
  it("resolves --type spellings to one event", () => {
    expect(resolveEventType("task_registered").verb).toBe("reg");
    expect(resolveEventType("TaskRegistered").type).toBe("task_registered");
    expect(resolveEventType("reg").type).toBe("task_registered");
    expect(resolveEventType("fees-swept").type).toBe("fees_swept");
  });

  it("builds the stream URL from a base, a /v1 prefix or a full stream URL", () => {
    expect(buildStreamUrl("https://i.example", {})).toBe("wss://i.example/v1/stream");
    expect(buildStreamUrl("https://i.example/", {})).toBe("wss://i.example/v1/stream");
    expect(buildStreamUrl("https://i.example/v1", {})).toBe("wss://i.example/v1/stream");
    expect(buildStreamUrl("wss://i.example/v1/stream", {})).toBe("wss://i.example/v1/stream");
    expect(buildStreamUrl("http://localhost:8080", { type: "paused", after: 12 })).toBe(
      "ws://localhost:8080/v1/stream?event_type=paused&after=12",
    );
  });

  it("formats an event on a single line even when a field is structured", () => {
    const line = formatEventLine({
      type: "unknown.thing",
      ledger: 3,
      txHash: "ab",
      payload: { values: [1, "two"] },
    });

    expect(line).toBe('ledger=3 unknown.thing values=[1,"two"] tx=ab');
    expect(line).not.toContain("\n");
  });
});
