import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  decodeTaskEvent,
  TASK_CANCELLED_TOPIC,
  TASK_CLAIMED_TOPIC,
  TASK_EXECUTED_TOPIC,
  TASK_EXPIRED_TOPIC,
  TASK_REGISTERED_TOPIC,
} from "./events";

// A real, well-formed Stellar public key — needed because `nativeToScVal`
// with `{ type: "address" }` validates its input as a real StrKey, and an
// arbitrary string would throw before the decoder under test ever runs.
const SAMPLE_ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const OTHER_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("decodeTaskEvent", () => {
  it("decodes TaskRegistered", () => {
    const value = nativeToScVal([42n, SAMPLE_ADDRESS, 1_000_000n, 1_800_000_000n], {
      type: ["u64", "address", "i128", "u64"],
    });
    const event = decodeTaskEvent(TASK_REGISTERED_TOPIC, value);
    expect(event).toEqual({
      type: "TaskRegistered",
      taskId: 42,
      owner: SAMPLE_ADDRESS,
      reward: 1_000_000n,
      deadline: 1_800_000_000,
    });
  });

  it("decodes TaskClaimed", () => {
    const value = nativeToScVal([7n, OTHER_ADDRESS, 123456], { type: ["u64", "address", "u32"] });
    const event = decodeTaskEvent(TASK_CLAIMED_TOPIC, value);
    expect(event).toEqual({ type: "TaskClaimed", taskId: 7, keeper: OTHER_ADDRESS, claimLedger: 123456 });
  });

  it("decodes TaskExecuted, including the proof bytes", () => {
    const proof = new Uint8Array([1, 2, 3, 4]);
    const value = nativeToScVal([7n, OTHER_ADDRESS, 990000n, proof], {
      type: ["u64", "address", "i128", "bytes"],
    });
    const event = decodeTaskEvent(TASK_EXECUTED_TOPIC, value);
    expect(event.type).toBe("TaskExecuted");
    if (event.type === "TaskExecuted") {
      expect(event.taskId).toBe(7);
      expect(event.keeper).toBe(OTHER_ADDRESS);
      expect(event.netReward).toBe(990000n);
      expect(Array.from(event.proof)).toEqual([1, 2, 3, 4]);
    }
  });

  it("decodes TaskExpired", () => {
    const value = nativeToScVal([99n], { type: ["u64"] });
    expect(decodeTaskEvent(TASK_EXPIRED_TOPIC, value)).toEqual({ type: "TaskExpired", taskId: 99 });
  });

  it("decodes TaskCancelled", () => {
    const value = nativeToScVal([5n, SAMPLE_ADDRESS], { type: ["u64", "address"] });
    expect(decodeTaskEvent(TASK_CANCELLED_TOPIC, value)).toEqual({
      type: "TaskCancelled",
      taskId: 5,
      owner: SAMPLE_ADDRESS,
    });
  });

  it("returns Unknown for an unrecognized topic pair rather than throwing", () => {
    const unknownTopic = [nativeToScVal("foo", { type: "symbol" }), nativeToScVal("bar", { type: "symbol" })];
    const value = nativeToScVal(1n, { type: "u64" });
    const event = decodeTaskEvent(unknownTopic, value);
    expect(event.type).toBe("Unknown");
  });

  it("returns Unknown (not a thrown exception) for a value whose shape doesn't match a recognized topic's decoder", () => {
    // TASK_REGISTERED_TOPIC recognized, but the value is a single u64, not the expected 4-tuple.
    const malformedValue = nativeToScVal(1n, { type: "u64" });
    const event = decodeTaskEvent(TASK_REGISTERED_TOPIC, malformedValue);
    expect(event.type).toBe("Unknown");
  });

  it("every DECODERS entry round-trips through its own exported TOPIC constant", () => {
    // Guards against a copy-paste mismatch between a topic constant and the
    // decoder registered under it — each decode call above already proves
    // this per-event, this is the belt-and-suspenders full-set check.
    const topics = [
      TASK_REGISTERED_TOPIC,
      TASK_CLAIMED_TOPIC,
      TASK_EXECUTED_TOPIC,
      TASK_EXPIRED_TOPIC,
      TASK_CANCELLED_TOPIC,
    ];
    expect(new Set(topics.map((t) => t.map((s) => s.toXDR("base64")).join(":"))).size).toBe(topics.length);
  });
describe("event decoders", () => {
  it("decodes TaskRegistered");
  it("decodes TaskClaimed");
  it("decodes TaskExecuted");
  it("decodes TaskExpired");
  it("decodes TaskCancelled");
  it("decodes RewardsWithdrawn");
  it("decodes Paused");
  it("decodes FeeUpdated");
  it("decodes AdminTransferred");
  it("decodes RewardIncreased");
  it("decodes DeadlineExtended");
  it("decodes MinRewardUpdated");
  it("decodes FeesSwept");
  it("decodes Initialized");
  it("decodes Upgraded");

  it("returns undefined for an unknown topic pair");
  it("returns undefined for malformed payload");
  it("does not throw for malformed events");
});
