// packages/sdk-ts/src/events.ts

import {
  Address,
  Contract,
  scValToNative,
} from "@stellar/stellar-sdk";

export interface TaskRegisteredEvent {
  type: "TaskRegistered";
  taskId: bigint;
  owner: string;
  reward: bigint;
  deadline: bigint;
}

export interface TaskClaimedEvent {
  type: "TaskClaimed";
  taskId: bigint;
  keeper: string;
  ledger: bigint;
}

export interface TaskExecutedEvent {
  type: "TaskExecuted";
  taskId: bigint;
  keeper: string;
  netReward: bigint;
  proof: Buffer;
}

export interface TaskExpiredEvent {
  type: "TaskExpired";
  taskId: bigint;
}

export interface TaskCancelledEvent {
  type: "TaskCancelled";
  taskId: bigint;
  owner: string;
}

export interface RewardsWithdrawnEvent {
  type: "RewardsWithdrawn";
  keeper: string;
  amount: bigint;
}

export interface PausedEvent {
  type: "Paused";
  paused: boolean;
}

export interface FeeUpdatedEvent {
  type: "FeeUpdated";
  oldBps: number;
  newBps: number;
}

export interface AdminTransferredEvent {
  type: "AdminTransferred";
  oldAdmin: string;
  newAdmin: string;
}

export interface RewardIncreasedEvent {
  type: "RewardIncreased";
  taskId: bigint;
  newReward: bigint;
}

export interface DeadlineExtendedEvent {
  type: "DeadlineExtended";
  taskId: bigint;
  newDeadline: bigint;
}

export interface MinRewardUpdatedEvent {
  type: "MinRewardUpdated";
  oldMin: bigint;
  newMin: bigint;
}

export interface FeesSweptEvent {
  type: "FeesSwept";
  treasury: string;
  amount: bigint;
  remaining: bigint;
}

export interface InitializedEvent {
  type: "Initialized";
  admin: string;
  rewardToken: string;
  feeBps: number;
}

export interface UpgradedEvent {
  type: "Upgraded";
  admin: string;
  newWasmHash: Buffer;
}

export type KeeperEvent =
  | TaskRegisteredEvent
  | TaskClaimedEvent
  | TaskExecutedEvent
  | TaskExpiredEvent
  | TaskCancelledEvent
  | RewardsWithdrawnEvent
  | PausedEvent
  | FeeUpdatedEvent
  | AdminTransferredEvent
  | RewardIncreasedEvent
  | DeadlineExtendedEvent
  | MinRewardUpdatedEvent
  | FeesSweptEvent
  | InitializedEvent
  | UpgradedEvent;

type RawEvent = {
  topics: unknown;
  value: unknown;
};

function normalizeTopics(rawEvent: RawEvent): string[] | undefined {
  try {
    const topics = scValToNative(rawEvent.topics);

    if (!Array.isArray(topics) || topics.length < 2) {
      return undefined;
    }

    return topics.map(String);
  } catch {
    return undefined;
  }
}

function nativeValue(rawEvent: RawEvent): unknown {
  return scValToNative(rawEvent.value);
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") {
    return value;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  ) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function decodeTaskRegistered(
  rawEvent: RawEvent,
): TaskRegisteredEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "reg" ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 4) {
    return undefined;
  }

  const [taskId, owner, reward, deadline] = values;

  const normalizedTaskId = asBigInt(taskId);
  const normalizedOwner = asString(owner);
  const normalizedReward = asBigInt(reward);
  const normalizedDeadline = asBigInt(deadline);

  if (
    normalizedTaskId === undefined ||
    normalizedOwner === undefined ||
    normalizedReward === undefined ||
    normalizedDeadline === undefined
  ) {
    return undefined;
  }

  return {
    type: "TaskRegistered",
    taskId: normalizedTaskId,
    owner: normalizedOwner,
    reward: normalizedReward,
    deadline: normalizedDeadline,
  };
}

export function decodeTaskClaimed(
  rawEvent: RawEvent,
): TaskClaimedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "claim" ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 3) {
    return undefined;
  }

  const [taskId, keeper, ledger] = values;

  const normalizedTaskId = asBigInt(taskId);
  const normalizedKeeper = asString(keeper);
  const normalizedLedger = asBigInt(ledger);

  if (
    normalizedTaskId === undefined ||
    normalizedKeeper === undefined ||
    normalizedLedger === undefined
  ) {
    return undefined;
  }

  return {
    type: "TaskClaimed",
    taskId: normalizedTaskId,
    keeper: normalizedKeeper,
    ledger: normalizedLedger,
  };
}

export function decodeTaskExecuted(
  rawEvent: RawEvent,
): TaskExecutedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "exec" ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 4) {
    return undefined;
  }

  const [taskId, keeper, netReward, proof] = values;

  const normalizedTaskId = asBigInt(taskId);
  const normalizedKeeper = asString(keeper);
  const normalizedReward = asBigInt(netReward);

  if (
    normalizedTaskId === undefined ||
    normalizedKeeper === undefined ||
    normalizedReward === undefined
  ) {
    return undefined;
  }

  return {
    type: "TaskExecuted",
    taskId: normalizedTaskId,
    keeper: normalizedKeeper,
    netReward: normalizedReward,
    proof: Buffer.from(proof as Uint8Array),
  };
}

export function decodeTaskExpired(
  rawEvent: RawEvent,
): TaskExpiredEvent | undefined {
  return decodeSimpleTaskEvent(
    rawEvent,
    "exp",
    (taskId) => ({
      type: "TaskExpired",
      taskId,
    }),
  );
}

export function decodeTaskCancelled(
  rawEvent: RawEvent,
): TaskCancelledEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "cancel" ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const taskId = asBigInt(values[0]);
  const owner = asString(values[1]);

  if (taskId === undefined || owner === undefined) {
    return undefined;
  }

  return {
    type: "TaskCancelled",
    taskId,
    owner,
  };
}

export function decodeRewardsWithdrawn(
  rawEvent: RawEvent,
): RewardsWithdrawnEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "wdraw" ||
    topics[1] !== "reward"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const keeper = asString(values[0]);
  const amount = asBigInt(values[1]);

  if (keeper === undefined || amount === undefined) {
    return undefined;
  }

  return {
    type: "RewardsWithdrawn",
    keeper,
    amount,
  };
}

export function decodePaused(
  rawEvent: RawEvent,
): PausedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "paused" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (
    !values ||
    values.length !== 1 ||
    typeof values[0] !== "boolean"
  ) {
    return undefined;
  }

  return {
    type: "Paused",
    paused: values[0],
  };
}

export function decodeFeeUpdated(
  rawEvent: RawEvent,
): FeeUpdatedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "fee" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const oldBps = asBigInt(values[0]);
  const newBps = asBigInt(values[1]);

  if (oldBps === undefined || newBps === undefined) {
    return undefined;
  }

  return {
    type: "FeeUpdated",
    oldBps: Number(oldBps),
    newBps: Number(newBps),
  };
}

export function decodeAdminTransferred(
  rawEvent: RawEvent,
): AdminTransferredEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "admin" ||
    topics[1] !== "xfer"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const oldAdmin = asString(values[0]);
  const newAdmin = asString(values[1]);

  if (oldAdmin === undefined || newAdmin === undefined) {
    return undefined;
  }

  return {
    type: "AdminTransferred",
    oldAdmin,
    newAdmin,
  };
}

export function decodeRewardIncreased(
  rawEvent: RawEvent,
): RewardIncreasedEvent | undefined {
  const values = readTaskAmountEvent(
    rawEvent,
    "topup",
  );

  if (!values) {
    return undefined;
  }

  return {
    type: "RewardIncreased",
    taskId: values.taskId,
    newReward: values.amount,
  };
}

export function decodeDeadlineExtended(
  rawEvent: RawEvent,
): DeadlineExtendedEvent | undefined {
  const values = readTaskAmountEvent(
    rawEvent,
    "extend",
  );

  if (!values) {
    return undefined;
  }

  return {
    type: "DeadlineExtended",
    taskId: values.taskId,
    newDeadline: values.amount,
  };
}

export function decodeMinRewardUpdated(
  rawEvent: RawEvent,
): MinRewardUpdatedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "minrwd" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const oldMin = asBigInt(values[0]);
  const newMin = asBigInt(values[1]);

  if (oldMin === undefined || newMin === undefined) {
    return undefined;
  }

  return {
    type: "MinRewardUpdated",
    oldMin,
    newMin,
  };
}

export function decodeFeesSwept(
  rawEvent: RawEvent,
): FeesSweptEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "sweep" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 3) {
    return undefined;
  }

  const treasury = asString(values[0]);
  const amount = asBigInt(values[1]);
  const remaining = asBigInt(values[2]);

  if (
    treasury === undefined ||
    amount === undefined ||
    remaining === undefined
  ) {
    return undefined;
  }

  return {
    type: "FeesSwept",
    treasury,
    amount,
    remaining,
  };
}

export function decodeInitialized(
  rawEvent: RawEvent,
): InitializedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "init" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 3) {
    return undefined;
  }

  const admin = asString(values[0]);
  const rewardToken = asString(values[1]);
  const feeBps = asBigInt(values[2]);

  if (
    admin === undefined ||
    rewardToken === undefined ||
    feeBps === undefined
  ) {
    return undefined;
  }

  return {
    type: "Initialized",
    admin,
    rewardToken,
    feeBps: Number(feeBps),
  };
}

export function decodeUpgraded(
  rawEvent: RawEvent,
): UpgradedEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== "upgrade" ||
    topics[1] !== "admin"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const admin = asString(values[0]);

  if (admin === undefined) {
    return undefined;
  }

  return {
    type: "Upgraded",
    admin,
    newWasmHash: Buffer.from(values[1] as Uint8Array),
  };
}

export function decodeEvent(
  rawEvent: RawEvent,
): KeeperEvent | undefined {
  const topics = normalizeTopics(rawEvent);

  if (!topics) {
    return undefined;
  }

  const key = `${topics[0]}/${topics[1]}`;

  switch (key) {
    case "reg/task":
      return decodeTaskRegistered(rawEvent);

    case "claim/task":
      return decodeTaskClaimed(rawEvent);

    case "exec/task":
      return decodeTaskExecuted(rawEvent);

    case "exp/task":
      return decodeTaskExpired(rawEvent);

    case "cancel/task":
      return decodeTaskCancelled(rawEvent);

    case "wdraw/reward":
      return decodeRewardsWithdrawn(rawEvent);

    case "paused/admin":
      return decodePaused(rawEvent);

    case "fee/admin":
      return decodeFeeUpdated(rawEvent);

    case "admin/xfer":
      return decodeAdminTransferred(rawEvent);

    case "topup/task":
      return decodeRewardIncreased(rawEvent);

    case "extend/task":
      return decodeDeadlineExtended(rawEvent);

    case "minrwd/admin":
      return decodeMinRewardUpdated(rawEvent);

    case "sweep/admin":
      return decodeFeesSwept(rawEvent);

    case "init/admin":
      return decodeInitialized(rawEvent);

    case "upgrade/admin":
      return decodeUpgraded(rawEvent);

    default:
      return undefined;
  }
}

function decodeSimpleTaskEvent<T>(
  rawEvent: RawEvent,
  verb: string,
  build: (taskId: bigint) => T,
): T | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== verb ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 1) {
    return undefined;
  }

  const taskId = asBigInt(values[0]);

  return taskId === undefined
    ? undefined
    : build(taskId);
}

function readTaskAmountEvent(
  rawEvent: RawEvent,
  verb: string,
): { taskId: bigint; amount: bigint } | undefined {
  const topics = normalizeTopics(rawEvent);

  if (
    !topics ||
    topics[0] !== verb ||
    topics[1] !== "task"
  ) {
    return undefined;
  }

  const values = asArray(nativeValue(rawEvent));

  if (!values || values.length !== 2) {
    return undefined;
  }

  const taskId = asBigInt(values[0]);
  const amount = asBigInt(values[1]);

  if (taskId === undefined || amount === undefined) {
    return undefined;
  }

  return {
    taskId,
    amount,
  };
}
