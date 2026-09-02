import { describe, expect, it } from "vitest";

import { KeeperContractError, KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { KEEPER, OWNER, testClient } from "./support/client.js";

const TASK_ID = 7n;

describe("client.increaseReward", () => {
  it("tops up a task and encodes every contract argument", async () => {
    const { client, rpc } = testClient();

    await expect(
      client.increaseReward({ owner: OWNER, taskId: TASK_ID, additional: 5_000_000n }),
    ).resolves.toBeUndefined();

    expect(rpc.onlyCall.method).toBe("increase_reward");
    expect(rpc.onlyCall.args[0]).toBe(OWNER);
    expect(rpc.onlyCall.args[1]).toBe(TASK_ID);
    expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvU64");
    expect(rpc.onlyCall.args[2]).toBe(5_000_000n);
  });

  it("accepts a number task id, per the SDK's u64 convention", async () => {
    const { client, rpc } = testClient();

    await client.increaseReward({ owner: OWNER, taskId: 7, additional: 1n });

    expect(rpc.onlyCall.args[1]).toBe(TASK_ID);
  });

  it("rejects a non-positive amount locally, without building a transaction", async () => {
    for (const additional of [0n, -1n]) {
      const { client, rpc } = testClient();
      const rejection = await client
        .increaseReward({ owner: OWNER, taskId: TASK_ID, additional })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.InvalidReward)).toBe(true);
      expect((rejection as KeeperContractError).local).toBe(true);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("refuses to sign for an owner the client has no signer for", async () => {
    const { client, rpc } = testClient();

    await expect(
      client.increaseReward({ owner: KEEPER, taskId: TASK_ID, additional: 1n }),
    ).rejects.toThrow(/must be authorized by/);
    expect(rpc.calls).toHaveLength(0);
  });

  it("surfaces a contract-side status rejection with its decoded code", async () => {
    // Whether a task is still Pending or Claimed is not something the client
    // knows without an extra read, so this one is only caught on-chain.
    const { client } = testClient({
      simulationErrors: { increase_reward: "HostError: Error(Contract, #5)" },
    });

    const rejection = await client
      .increaseReward({ owner: OWNER, taskId: TASK_ID, additional: 1n })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.InvalidTaskStatus)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(false);
  });
});
