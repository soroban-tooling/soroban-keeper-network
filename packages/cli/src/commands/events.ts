import type { Command } from "commander";
import { nativeToScVal, rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import type { RpcServerLike } from "@soroban-keeper-network/sdk";

import { CliError, ExitCode, usageError } from "../errors.js";
import { Output } from "../output.js";
import type { Runtime, WebSocketCtor } from "../runtime.js";
import { resolveConnection, type Connection, type GlobalOptions } from "../session.js";

// -- the contract's events ---------------------------------------------------

export interface EventSpec {
  /** The indexer's wire name, e.g. `task_registered`. Also what `--type` is normalised to. */
  type: string;
  /** The contract's topic pair. */
  verb: string;
  noun: string;
  /** Names for the positions of the event's value tuple, in order. */
  fields: readonly string[];
}

/**
 * The registry's events as the indexer models them
 * (`indexer/src/events.rs`), which mirror `contracts/keeper-registry/src/events.rs`
 * field for field. Sharing the names means a line from the indexer stream and
 * a line decoded from RPC look the same.
 */
export const EVENT_SPECS: readonly EventSpec[] = [
  { type: "task_registered", verb: "reg", noun: "task", fields: ["task_id", "owner", "reward", "deadline"] },
  { type: "task_claimed", verb: "claim", noun: "task", fields: ["task_id", "keeper", "claim_ledger"] },
  { type: "task_executed", verb: "exec", noun: "task", fields: ["task_id", "keeper", "net_reward", "proof"] },
  { type: "task_expired", verb: "exp", noun: "task", fields: ["task_id"] },
  { type: "task_cancelled", verb: "cancel", noun: "task", fields: ["task_id", "owner"] },
  { type: "reward_increased", verb: "topup", noun: "task", fields: ["task_id", "new_reward"] },
  { type: "deadline_extended", verb: "extend", noun: "task", fields: ["task_id", "new_deadline"] },
  { type: "rewards_withdrawn", verb: "wdraw", noun: "reward", fields: ["keeper", "amount"] },
  { type: "paused", verb: "paused", noun: "admin", fields: ["paused"] },
  { type: "fee_updated", verb: "fee", noun: "admin", fields: ["old_bps", "new_bps"] },
  { type: "admin_transferred", verb: "admin", noun: "xfer", fields: ["old_admin", "new_admin"] },
  { type: "min_reward_updated", verb: "minrwd", noun: "admin", fields: ["old_min", "new_min"] },
  { type: "fees_swept", verb: "sweep", noun: "admin", fields: ["treasury", "amount", "remaining"] },
  { type: "initialized", verb: "init", noun: "admin", fields: ["admin", "reward_token", "fee_bps"] },
  { type: "upgraded", verb: "upgrade", noun: "admin", fields: ["admin", "new_wasm_hash"] },
  { type: "reputation_updated", verb: "update", noun: "reputation", fields: ["keeper", "action", "score"] },
];

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolves `--type`. Accepts the indexer name (`task_registered`), the
 * PascalCase name (`TaskRegistered`) or the contract's topic verb (`reg`).
 */
export function resolveEventType(input: string): EventSpec {
  const wanted = squash(input);
  const spec = EVENT_SPECS.find((s) => squash(s.type) === wanted || s.verb === wanted);
  if (!spec) {
    throw usageError(
      `Unknown event type "${input}". Known types: ${EVENT_SPECS.map((s) => s.type).join(", ")}.`,
    );
  }
  return spec;
}

// -- the one shape both feeds are normalised to --------------------------------

export interface WatchEvent {
  type: string;
  ledger: number;
  txHash: string;
  /** Indexer cursor; absent for events read from RPC. */
  cursor?: number;
  /** The task this event concerns, as a decimal string, if any. */
  taskId?: string;
  payload: Record<string, unknown>;
}

/** Fields the indexer serialises as decimal strings because an `i128` can exceed 2^53. */
const STRING_FIELDS = new Set([
  "reward",
  "net_reward",
  "new_reward",
  "amount",
  "remaining",
  "old_min",
  "new_min",
  "score",
]);

function jsonSafe(name: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (STRING_FIELDS.has(name)) return value.toString();
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map((item) => jsonSafe(name, item));
  return value;
}

function taskIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.task_id;
  return typeof id === "number" || typeof id === "string" || typeof id === "bigint"
    ? String(id)
    : undefined;
}

/** The subset of an RPC `getEvents` entry this command reads. */
export interface RawRpcEvent {
  id: string;
  ledger: number;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

/** Decodes one `getEvents` entry. An unrecognised or malformed event is tagged, never thrown. */
export function fromRpcEvent(raw: RawRpcEvent): WatchEvent {
  const base = { ledger: raw.ledger, txHash: raw.txHash };
  let verb = "";
  let noun = "";
  let values: unknown[] = [];
  try {
    verb = String(scValToNative(raw.topic[0] as xdr.ScVal));
    noun = String(scValToNative(raw.topic[1] as xdr.ScVal));
    const native = scValToNative(raw.value) as unknown;
    values = Array.isArray(native) ? native : [native];
  } catch {
    return { ...base, type: "unknown", payload: {} };
  }

  const spec = EVENT_SPECS.find((s) => s.verb === verb && s.noun === noun);
  if (!spec) {
    return { ...base, type: `${verb}.${noun}`, payload: { values: values.map((v) => jsonSafe("", v)) } };
  }
  const payload = Object.fromEntries(
    spec.fields.map((name, index) => [name, jsonSafe(name, values[index])]),
  );
  const taskId = taskIdOf(payload);
  return { ...base, type: spec.type, ...(taskId === undefined ? {} : { taskId }), payload };
}

/** The indexer's `IndexedEvent` (`/v1/stream`'s `event` message), reduced to what this command reads. */
interface IndexedEventLike {
  cursor: number;
  ledger: number;
  tx_hash: string;
  event_type: string;
  payload: Record<string, unknown>;
}

export function fromIndexedEvent(event: IndexedEventLike): WatchEvent {
  // The payload carries a `type` tag (serde's internal tag); the event already has a `type`.
  const payload = Object.fromEntries(Object.entries(event.payload).filter(([key]) => key !== "type"));
  const taskId = taskIdOf(payload);
  return {
    type: event.event_type,
    ledger: event.ledger,
    txHash: event.tx_hash,
    cursor: event.cursor,
    ...(taskId === undefined ? {} : { taskId }),
    payload,
  };
}

// -- rendering -----------------------------------------------------------------

/** One event as a single line: `ledger=12 task_registered task_id=7 owner=G... tx=ab..`. */
export function formatEventLine(event: WatchEvent): string {
  const fields = Object.entries(event.payload).map(
    ([key, value]) =>
      `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`,
  );
  return [`ledger=${event.ledger}`, event.type, ...fields, `tx=${event.txHash}`].join(" ");
}

function jsonShape(event: WatchEvent): Record<string, unknown> {
  return {
    type: event.type,
    ledger: event.ledger,
    txHash: event.txHash,
    ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    payload: event.payload,
  };
}

// -- sources -------------------------------------------------------------------

/** Builds the `/v1/stream` URL from an indexer base URL, switching http(s) to ws(s). */
export function buildStreamUrl(base: string, filter: { type?: string; after?: number }): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw usageError(`"${base}" is not a valid indexer URL.`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw usageError(`The indexer URL must start with http, https, ws or wss, got "${base}".`);
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/stream")) url.pathname = path;
  else if (path.endsWith("/v1")) url.pathname = `${path}/stream`;
  else url.pathname = `${path}/v1/stream`;

  if (filter.type !== undefined) url.searchParams.set("event_type", filter.type);
  if (filter.after !== undefined) url.searchParams.set("after", String(filter.after));
  return url.toString();
}

const MAX_CONSECUTIVE_FAILURES = 5;

interface Sink {
  /** Offers an event; returns once handled. Stops the watch itself when `--count` is reached. */
  (event: WatchEvent): void;
}

/** Opens one WebSocket and resolves when it ends, saying how many events it delivered. */
function connectOnce(
  Socket: WebSocketCtor,
  url: string,
  onEvent: Sink,
  signal: AbortSignal,
  out: Output,
): Promise<{ received: number; reason: string }> {
  return new Promise((resolve) => {
    const socket = new Socket(url);
    let received = 0;
    let settled = false;

    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve({ received, reason });
    };

    const onMessage = (event: unknown): void => {
      const data = (event as { data?: unknown }).data;
      let message: { kind?: string; event?: IndexedEventLike; reason?: string };
      try {
        message = JSON.parse(typeof data === "string" ? data : String(data)) as typeof message;
      } catch {
        out.warn("Ignored an unreadable message from the indexer stream.");
        return;
      }
      if (message.kind === "event" && message.event) {
        received += 1;
        onEvent(fromIndexedEvent(message.event));
      } else if (message.kind === "closed") {
        finish(message.reason ?? "closed by server");
      }
    };
    const onClose = (): void => finish("connection closed");
    const onError = (): void => finish("connection error");
    const onAbort = (): void => finish("stopped");

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function watchIndexer(
  rt: Runtime,
  Socket: WebSocketCtor,
  indexerUrl: string,
  type: EventSpec | undefined,
  onEvent: Sink,
  signal: AbortSignal,
  out: Output,
): Promise<void> {
  let cursor: number | undefined;
  let failures = 0;

  while (!signal.aborted) {
    const url = buildStreamUrl(indexerUrl, {
      ...(type ? { type: type.type } : {}),
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    const { received, reason } = await connectOnce(
      Socket,
      url,
      (event) => {
        if (event.cursor !== undefined) {
          // After a reconnect the server replays from `after`; never print a cursor twice.
          if (cursor !== undefined && event.cursor <= cursor) return;
          // Advance before filtering, so a filtered-out event is not replayed either.
          cursor = event.cursor;
        }
        onEvent(event);
      },
      signal,
      out,
    );
    if (signal.aborted) return;

    failures = received > 0 ? 1 : failures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      throw new CliError(
        `The indexer stream closed ${failures} times in a row (${reason}). Giving up.`,
        ExitCode.Rpc,
        "stream_closed",
      );
    }
    out.warn(`Indexer stream ended (${reason}); reconnecting.`);
    await rt.sleep(Math.min(1_000 * failures, 10_000));
  }
}

async function watchRpc(
  rt: Runtime,
  conn: Connection,
  type: EventSpec | undefined,
  options: { fromLedger?: number; intervalMs: number },
  onEvent: Sink,
  signal: AbortSignal,
  out: Output,
): Promise<void> {
  const server: RpcServerLike =
    rt.server ?? new rpc.Server(conn.rpcUrl, { allowHttp: conn.rpcUrl.startsWith("http://") });

  const symbol = (name: string): string => nativeToScVal(name, { type: "symbol" }).toXDR("base64");
  const filters = [
    {
      type: "contract" as const,
      contractIds: [conn.contractId],
      ...(type ? { topics: [[symbol(type.verb), symbol(type.noun)]] } : {}),
    },
  ];

  let cursor: string | undefined;
  let startLedger = options.fromLedger;
  const seen = new Set<string>();
  let failures = 0;

  while (!signal.aborted) {
    try {
      if (cursor === undefined && startLedger === undefined) {
        startLedger = (await server.getLatestLedger()).sequence;
      }
      const response = await server.getEvents(
        cursor !== undefined
          ? { cursor, filters, limit: 100 }
          : { startLedger: startLedger as number, filters, limit: 100 },
      );
      failures = 0;
      cursor = response.cursor ?? cursor;

      for (const raw of response.events as unknown as RawRpcEvent[]) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        onEvent(fromRpcEvent(raw));
        if (signal.aborted) return;
      }
    } catch (error) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw new CliError(
          `getEvents failed ${failures} times in a row: ${error instanceof Error ? error.message : String(error)}`,
          ExitCode.Rpc,
          "rpc_error",
        );
      }
      out.warn(`getEvents failed (${error instanceof Error ? error.message : String(error)}); retrying.`);
    }
    if (signal.aborted) return;
    await rt.sleep(options.intervalMs);
  }
}

// -- the command ------------------------------------------------------------------

interface WatchFlags {
  type?: string;
  task?: string;
  count?: string;
  indexerUrl?: string;
  fromLedger?: string;
  interval?: string;
}

function parseWhole(label: string, input: string): number {
  if (!/^\d+$/.test(input.trim())) {
    throw usageError(`${label} must be a non-negative whole number, got "${input}".`);
  }
  return Number(input.trim());
}

export function registerEvents(program: Command, rt: Runtime): void {
  const group = program.command("events").description("Read contract events");

  group
    .command("watch")
    .description(
      "Stream contract events, one line each (or JSON lines with --json). Uses the indexer's " +
        "WebSocket when an indexer URL is set, otherwise polls getEvents.",
    )
    .option("--type <name>", "only this event type, e.g. task_registered (or TaskRegistered, or reg)")
    .option("--task <id>", "only events for this task ID")
    .option("--count <n>", "stop after printing this many events")
    .option("--indexer-url <url>", "indexer base URL; streams /v1/stream (env: SKN_INDEXER_URL)")
    .option("--from-ledger <n>", "polling only: first ledger to read (default: the latest)")
    .option("--interval <ms>", "polling only: milliseconds between polls", "5000")
    .action(async (_flags: WatchFlags, cmd: Command) => {
      const all = cmd.optsWithGlobals() as WatchFlags & GlobalOptions;
      const out = new Output(rt.io, all.json === true);
      const conn = resolveConnection(rt, all);

      const type = all.type === undefined ? undefined : resolveEventType(all.type);
      const taskId =
        all.task === undefined ? undefined : BigInt(parseWhole("--task", all.task)).toString();
      const count = all.count === undefined ? undefined : parseWhole("--count", all.count);
      if (count === 0) throw usageError("--count must be at least 1.");
      const intervalMs = parseWhole("--interval", all.interval ?? "5000");
      const fromLedger =
        all.fromLedger === undefined ? undefined : parseWhole("--from-ledger", all.fromLedger);

      // One controller ends the watch whether Ctrl-C or `--count` asks for it.
      const stopper = new AbortController();
      const stop = (): void => stopper.abort();
      if (rt.signal.aborted) stop();
      else rt.signal.addEventListener("abort", stop, { once: true });

      let printed = 0;
      const sink: Sink = (event) => {
        if (stopper.signal.aborted) return;
        if (type && event.type !== type.type) return;
        if (taskId !== undefined && event.taskId !== taskId) return;
        out.result(jsonShape(event), formatEventLine(event));
        printed += 1;
        if (count !== undefined && printed >= count) stop();
      };

      const indexerUrl = all.indexerUrl ?? rt.env.SKN_INDEXER_URL;
      const Socket =
        rt.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;

      try {
        if (indexerUrl && Socket) {
          out.note(`Watching ${conn.contractId} through the indexer stream. Press Ctrl-C to stop.`);
          await watchIndexer(rt, Socket, indexerUrl, type, sink, stopper.signal, out);
        } else {
          if (indexerUrl) {
            out.warn(
              "This runtime has no WebSocket (Node 22 or newer has one); polling getEvents instead.",
            );
          }
          out.note(`Watching ${conn.contractId} by polling ${conn.rpcUrl}. Press Ctrl-C to stop.`);
          await watchRpc(
            rt,
            conn,
            type,
            { ...(fromLedger === undefined ? {} : { fromLedger }), intervalMs },
            sink,
            stopper.signal,
            out,
          );
        }
      } finally {
        rt.signal.removeEventListener("abort", stop);
      }
    });
}

