/**
 * Runs the real CLI end to end against the SDK's fake RPC.
 *
 * Nothing here can reach a network: the RPC server is injected, the WebSocket
 * is a scripted stand-in (or a stub that throws), time never actually waits,
 * and no terminal is attached. `FakeRpc` and `CONTRACT_ID` come straight from
 * `packages/sdk-ts/test/support`, so the encoding under test is the SDK's real
 * `nativeToScVal` / `scValToNative` round trip rather than a hand-written shape.
 */

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { run } from "../../src/index.js";
import type { Runtime, WebSocketCtor, WebSocketLike } from "../../src/runtime.js";
import {
  ADMIN,
  ADMIN_KEYPAIR,
  CONTRACT_ID,
  KEEPER,
  OWNER,
  OWNER_KEYPAIR,
} from "../../../sdk-ts/test/support/client.js";
import { FakeRpc, type FakeRpcOptions } from "../../../sdk-ts/test/support/fakeRpc.js";

export { ADMIN, ADMIN_KEYPAIR, CONTRACT_ID, FakeRpc, KEEPER, OWNER, OWNER_KEYPAIR };

export const OWNER_SECRET = OWNER_KEYPAIR.secret();
export const ADMIN_SECRET = ADMIN_KEYPAIR.secret();

export interface RunOptions {
  /** The fake RPC to run against. Defaults to a fresh `FakeRpc`. */
  rpc?: FakeRpc;
  /** Environment overrides on top of the defaults; an `undefined` value removes a default. */
  env?: Record<string, string | undefined>;
  /** Files `readFile` can see, by path. */
  files?: Record<string, string>;
  /** Whether a person is at the terminal. */
  isTTY?: boolean;
  /** What the person answers when asked to confirm. */
  answer?: boolean;
  /**
   * The WebSocket class. Left unset it is a stub that throws, so a test that
   * unexpectedly opens a stream fails loudly instead of dialling out. `null`
   * leaves the runtime without one, to exercise the fallback.
   */
  WebSocketImpl?: WebSocketCtor | null;
  /** Safety net: abort a watch after this many sleeps so a bad test cannot hang. */
  maxSleeps?: number;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Questions the CLI asked the person. */
  prompts: string[];
  rpc: FakeRpc;
  /** Sleeps the CLI requested (poll waits and reconnect back-offs), in milliseconds. */
  sleeps: number[];
}

class ForbiddenSocket implements WebSocketLike {
  constructor(url: string) {
    throw new Error(`test opened a real WebSocket to ${url}`);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

export async function runCli(args: string[], options: RunOptions = {}): Promise<CliResult> {
  const rpc = options.rpc ?? new FakeRpc();
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const sleeps: number[] = [];

  const env: Record<string, string | undefined> = {
    SKN_CONTRACT_ID: CONTRACT_ID,
    SKN_SECRET_KEY: OWNER_SECRET,
    ...options.env,
  };

  const rt: Runtime = {
    env,
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      isTTY: options.isTTY ?? false,
      confirm: async (question) => {
        prompts.push(question);
        return options.answer ?? false;
      },
    },
    readFile: (path) => {
      const content = options.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    now: () => Date.now(),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= (options.maxSleeps ?? 50)) controller.abort();
    },
    signal: controller.signal,
    server: rpc,
    WebSocketImpl: options.WebSocketImpl === null ? undefined : (options.WebSocketImpl ?? ForbiddenSocket),
    confirmPollIntervalMs: 1,
    secrets: [],
  };

  const code = await run(args, rt);
  return { code, stdout, stderr, prompts, rpc, sleeps };
}

/** Parses newline-delimited JSON output. */
export function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// -- RPC events ---------------------------------------------------------------

const symbol = (name: string): xdr.ScVal => nativeToScVal(name, { type: "symbol" });
export const u64 = (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: "u64" });
export const i128 = (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: "i128" });
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
export const address = (a: string): xdr.ScVal => nativeToScVal(a, { type: "address" });

/** One entry as `rpc.Server.getEvents` returns it: a topic pair and a tuple value. */
export function rpcEvent(
  id: string,
  ledger: number,
  verb: string,
  noun: string,
  tuple: xdr.ScVal[],
) {
  return {
    type: "contract",
    id,
    pagingToken: id,
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: CONTRACT_ID,
    txHash: `tx-${id}`,
    inSuccessfulContractCall: true,
    topic: [symbol(verb), symbol(noun)],
    value: xdr.ScVal.scvVec(tuple),
  };
}

export const registered = (id: string, ledger: number, taskId: number) =>
  rpcEvent(id, ledger, "reg", "task", [u64(taskId), address(OWNER), i128(1000), u64(1_900_000_000)]);

export const claimed = (id: string, ledger: number, taskId: number) =>
  rpcEvent(id, ledger, "claim", "task", [u64(taskId), address(KEEPER), u32(ledger)]);

export type RawEvent = ReturnType<typeof rpcEvent>;

/** A `FakeRpc` whose `register_task` returns `taskId`, plus any extra fake options. */
export function registerRpc(taskId: bigint, extra: FakeRpcOptions = {}): FakeRpc {
  return new FakeRpc({
    results: { register_task: nativeToScVal(taskId, { type: "u64" }) },
    ...extra,
  });
}

/**
 * A `FakeRpc` whose `getEvents` serves scripted pages, one per call, and
 * records every request. A page may be an `Error` to simulate an RPC failure.
 */
export class EventsFakeRpc extends FakeRpc {
  readonly requests: Record<string, unknown>[] = [];

  constructor(
    private readonly pages: (RawEvent[] | Error)[],
    fakeOptions: FakeRpcOptions = {},
  ) {
    super(fakeOptions);
  }

  async getEvents(request: Record<string, unknown>) {
    this.requests.push(request);
    const page = this.pages.shift() ?? [];
    if (page instanceof Error) throw page;
    return { events: page, cursor: `cursor-${this.requests.length}`, latestLedger: 1_000 } as never;
  }
}

// -- indexer WebSocket ----------------------------------------------------------

/** An indexer `event` message, as it arrives over `/v1/stream`. */
export function indexerEventMessage(
  cursor: number,
  eventType: string,
  payload: Record<string, unknown>,
  ledger = 100,
): string {
  return JSON.stringify({
    kind: "event",
    event: {
      cursor,
      ledger,
      ledger_close_time: 1_700_000_000,
      tx_hash: `tx-${cursor}`,
      event_index: 0,
      event_type: eventType,
      payload: { type: eventType, ...payload },
    },
  });
}

/**
 * A WebSocket class that plays one scripted conversation per connection:
 * each message in turn, then a close. Records the URL of every connection.
 */
export function scriptedSocket(scripts: string[][]): { Socket: WebSocketCtor; urls: string[] } {
  const urls: string[] = [];

  class Scripted implements WebSocketLike {
    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    constructor(url: string) {
      urls.push(url);
      const script = scripts.shift() ?? [];
      queueMicrotask(() => {
        for (const data of script) this.emit("message", { data });
        this.emit("close", {});
      });
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((existing) => existing !== listener),
      );
    }

    close(): void {}

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  return { Socket: Scripted, urls };
}
