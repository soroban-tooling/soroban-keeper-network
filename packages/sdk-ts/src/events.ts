// Typed decoders for the contract's task-lifecycle events. The keeper-bot
// example hand-decodes `TaskRegistered` with a fixed positional tuple
// unpack (`examples/keeper-bot/index.js`'s `fetchPendingTasks`), fragile to
// any change in event shape; this offers a typed, tolerant decoder any
// consumer (this SDK's own `useTaskEvents`, or an external one) can share.
// See backlog 0167.
//
// Scoped to the five task-lifecycle events (`TaskRegistered` through
// `TaskCancelled`) — the ones `useTaskEvents` (backlog 0179 / issue #248)
// actually needs. The remaining admin/reward events
// (`Paused`/`FeeUpdated`/`AdminChanged`/...) are backlog 0167's full scope
// and can be added the same way without changing this module's shape.

import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

const MAX_SYMBOL_LENGTH = 9;

/**
 * Encodes a Soroban symbol the same way `getEvents`' topic filters and a
 * decoded event's `topic` entries both represent one — reused so the
 * encoding logic exists in exactly one place (see `contractInvoker.ts`'s
 * DRY note for the analogous reasoning on the invoke path).
 */
function topicSymbol(name: string): xdr.ScVal {
  if (name.length > MAX_SYMBOL_LENGTH) {
    throw new Error(`Symbol "${name}" is too long; max ${MAX_SYMBOL_LENGTH} chars`);
  }
  return nativeToScVal(name, { type: "symbol" });
}

function topicKey(topic: xdr.ScVal[]): string {
  return topic.map((t) => scValToNative(t)).join(":");
}

export interface TaskRegisteredEvent {
  type: "TaskRegistered";
  taskId: number;
  owner: string;
  reward: bigint;
  deadline: number;
}

export interface TaskClaimedEvent {
  type: "TaskClaimed";
  taskId: number;
  keeper: string;
  claimLedger: number;
}

export interface TaskExecutedEvent {
  type: "TaskExecuted";
  taskId: number;
  keeper: string;
  netReward: bigint;
  proof: Uint8Array;
}

export interface TaskExpiredEvent {
  type: "TaskExpired";
  taskId: number;
}

export interface TaskCancelledEvent {
  type: "TaskCancelled";
  taskId: number;
  owner: string;
}

/** An event whose topic pair didn't match any decoder in this module (a different contract event, or a shape this SDK doesn't decode yet) — tagged, not thrown, so a consumer's dispatch loop can skip it and keep going. */
export interface UnknownTaskEvent {
  type: "Unknown";
  topic: xdr.ScVal[];
}

export type TaskEvent =
  | TaskRegisteredEvent
  | TaskClaimedEvent
  | TaskExecutedEvent
  | TaskExpiredEvent
  | TaskCancelledEvent
  | UnknownTaskEvent;

/** Matches `contracts/keeper-registry/src/events.rs::emit_task_registered`'s topic pair. */
export const TASK_REGISTERED_TOPIC = [topicSymbol("reg"), topicSymbol("task")];
/** Matches `emit_task_claimed`. */
export const TASK_CLAIMED_TOPIC = [topicSymbol("claim"), topicSymbol("task")];
/** Matches `emit_task_executed`. */
export const TASK_EXECUTED_TOPIC = [topicSymbol("exec"), topicSymbol("task")];
/** Matches `emit_task_expired`. */
export const TASK_EXPIRED_TOPIC = [topicSymbol("exp"), topicSymbol("task")];
/** Matches `emit_task_cancelled`. */
export const TASK_CANCELLED_TOPIC = [topicSymbol("cancel"), topicSymbol("task")];

const DECODERS = new Map<string, (value: xdr.ScVal) => TaskEvent>([
  [
    topicKey(TASK_REGISTERED_TOPIC),
    (value) => {
      const [taskId, owner, reward, deadline] = scValToNative(value) as [bigint, string, bigint, bigint];
      return { type: "TaskRegistered", taskId: Number(taskId), owner, reward, deadline: Number(deadline) };
    },
  ],
  [
    topicKey(TASK_CLAIMED_TOPIC),
    (value) => {
      const [taskId, keeper, claimLedger] = scValToNative(value) as [bigint, string, number];
      return { type: "TaskClaimed", taskId: Number(taskId), keeper, claimLedger };
    },
  ],
  [
    topicKey(TASK_EXECUTED_TOPIC),
    (value) => {
      const [taskId, keeper, netReward, proof] = scValToNative(value) as [bigint, string, bigint, Uint8Array];
      return { type: "TaskExecuted", taskId: Number(taskId), keeper, netReward, proof };
    },
  ],
  [
    topicKey(TASK_EXPIRED_TOPIC),
    (value) => {
      const [taskId] = scValToNative(value) as [bigint];
      return { type: "TaskExpired", taskId: Number(taskId) };
    },
  ],
  [
    topicKey(TASK_CANCELLED_TOPIC),
    (value) => {
      const [taskId, owner] = scValToNative(value) as [bigint, string];
      return { type: "TaskCancelled", taskId: Number(taskId), owner };
    },
  ],
]);

/**
 * Dispatches on `topic` and decodes `value` into the matching
 * {@link TaskEvent} variant, returning a discriminated union a consumer can
 * `switch (event.type)` on with full type narrowing. A malformed payload
 * (the topic matched a known event, but `value`'s tuple shape didn't) or an
 * unrecognized topic pair both come back as `{ type: "Unknown" }` rather
 * than throwing — mirrors the keeper-bot's existing "skip malformed events,
 * warn once" tolerance, since one unparseable event must never take down
 * an entire polling round for every other event in the batch.
 */
export function decodeTaskEvent(topic: xdr.ScVal[], value: xdr.ScVal): TaskEvent {
  const decoder = DECODERS.get(topicKey(topic));
  if (!decoder) {
    return { type: "Unknown", topic };
  }
  try {
    return decoder(value);
  } catch {
    return { type: "Unknown", topic };
  }
}
