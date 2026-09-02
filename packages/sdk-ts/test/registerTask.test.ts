import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  MAX_CALLDATA_LEN,
  MAX_LOCK_LEDGERS,
  MIN_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
} from "../src/constants.js";
import { KeeperContractError, KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { TaskType } from "../src/types.js";
import { CONTRACT_ID, KEEPER, OWNER, testClient } from "./support/client.js";

const TASK_ID = 42n;
const CALLDATA = new Uint8Array(Buffer.from("target-call"));

/** A deadline comfortably in the future, in Unix seconds. */
function futureDeadline(): number {
  return Math.floor(Date.now() / 1000) + 3_600;
}

function validParams() {
  return {
    owner: OWNER,
    taskType: TaskType.Liquidation,
    calldata: CALLDATA,
    reward: 10_000_000n,
    deadline: futureDeadline(),
    ttlLedgers: 20_000,
    lockLedgers: 120,
  };
}

function ownerClient(rpcOptions = {}) {
  return testClient({
    results: { register_task: nativeToScVal(TASK_ID, { type: "u64" }) },
    ...rpcOptions,
  });
}

describe("client.registerTask", () => {
  it("returns the new task id and encodes every contract argument", async () => {
    const { client, rpc } = ownerClient();
    const params = validParams();

    await expect(client.registerTask(params)).resolves.toBe(TASK_ID);

    expect(rpc.onlyCall.method).toBe("register_task");
    const { args, rawArgs } = rpc.onlyCall;
    expect(args[0]).toBe(OWNER);
    // TaskType is a simple contracttype enum, so it goes over the wire as its
    // u32 discriminant -- a mismatch here silently registers the wrong kind of
    // task, so the exact number is asserted alongside the TypeScript name.
    expect(args[1]).toBe(TaskType.Liquidation);
    expect(args[1]).toBe(0);
    expect(rawArgs[1]?.switch().name).toBe("scvU32");
    expect(new Uint8Array(args[2] as Buffer)).toEqual(CALLDATA);
    expect(args[3]).toBe(10_000_000n);
    expect(args[4]).toBe(BigInt(params.deadline));
    expect(rawArgs[4]?.switch().name).toBe("scvU64");
    expect(args[5]).toBe(20_000);
    expect(args[6]).toBe(120);
  });

  it("accepts a Date deadline as the same Unix-second argument", async () => {
    const seconds = futureDeadline();
    const { client, rpc } = ownerClient();

    await client.registerTask({ ...validParams(), deadline: new Date(seconds * 1000) });

    expect(rpc.onlyCall.args[4]).toBe(BigInt(seconds));
  });

  it("passes an omitted verifier as None rather than dropping the argument", async () => {
    const { client, rpc } = ownerClient();

    await client.registerTask(validParams());

    // `register_task` takes eight positional arguments as of contract VERSION 4;
    // omitting the trailing Option would shift nothing here but would silently
    // change the entry point's arity.
    expect(rpc.onlyCall.rawArgs).toHaveLength(8);
    expect(rpc.onlyCall.rawArgs[7]?.switch().name).toBe("scvVoid");
  });

  it("passes a verifier through as Some(address)", async () => {
    const { client, rpc } = ownerClient();

    await client.registerTask({ ...validParams(), verifier: CONTRACT_ID });

    expect(rpc.onlyCall.rawArgs[7]?.switch().name).toBe("scvAddress");
    expect(rpc.onlyCall.args[7]).toBe(CONTRACT_ID);
  });

  it("rejects a non-positive reward locally, without building a transaction", async () => {
    const { client, rpc } = ownerClient();

    const rejection = await client
      .registerTask({ ...validParams(), reward: 0n })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.InvalidReward)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(true);
    // The point of the local check is saving the round trip, so the absence of
    // a call is the assertion that matters.
    expect(rpc.calls).toHaveLength(0);
  });

  it("rejects a deadline that has already passed, locally", async () => {
    const { client, rpc } = ownerClient();

    const rejection = await client
      .registerTask({ ...validParams(), deadline: 1 })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.DeadlinePassed)).toBe(true);
    expect(rpc.calls).toHaveLength(0);
  });

  it("rejects out-of-range lockLedgers and ttlLedgers, locally", async () => {
    const cases = [
      { params: { lockLedgers: MIN_LOCK_LEDGERS - 1 }, code: KeeperErrorCode.InvalidTaskParams },
      { params: { lockLedgers: MAX_LOCK_LEDGERS + 1 }, code: KeeperErrorCode.InvalidTaskParams },
      { params: { ttlLedgers: MIN_TTL_LEDGERS - 1 }, code: KeeperErrorCode.TtlTooShort },
    ];

    for (const { params, code } of cases) {
      const { client, rpc } = ownerClient();
      const rejection = await client
        .registerTask({ ...validParams(), ...params })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, code)).toBe(true);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("rejects calldata over MAX_CALLDATA_LEN, locally", async () => {
    const { client, rpc } = ownerClient();

    const rejection = await client
      .registerTask({ ...validParams(), calldata: new Uint8Array(MAX_CALLDATA_LEN + 1) })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.CalldataTooLarge)).toBe(true);
    expect(rpc.calls).toHaveLength(0);
  });

  it("refuses to sign for an owner the client has no signer for", async () => {
    const { client, rpc } = ownerClient();

    await expect(client.registerTask({ ...validParams(), owner: KEEPER })).rejects.toThrow(
      /must be authorized by/,
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it("surfaces a contract-side rejection with its decoded code", async () => {
    // MinReward is configurable per deployment, so a reward above zero can
    // still be rejected on-chain -- the local check is an optimisation, not a
    // replacement for the contract's own validation.
    const { client } = ownerClient({
      simulationErrors: { register_task: "HostError: Error(Contract, #8)" },
    });

    const rejection = await client
      .registerTask({ ...validParams(), reward: 1n })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.InvalidReward)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(false);
  });
});
