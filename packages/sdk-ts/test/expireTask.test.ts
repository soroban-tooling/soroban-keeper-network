import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { TaskStatus } from "../src/types.js";
import { OWNER, OWNER_KEYPAIR, testClient } from "./support/client.js";
import { FakeRegistry, clientFor } from "./support/fakeRegistry.js";

describe("client.expireTask", () => {
  it("lets an account unrelated to the task expire it past its deadline", async () => {
    // The defining property of this method: no owner, keeper, or claimer
    // relationship is required. The caller below is none of the three.
    const registry = new FakeRegistry();
    const owner = Keypair.random().publicKey();
    const taskId = registry.seedTask({ owner });

    const keeper = clientFor(registry);
    await keeper.client.claimTask({ keeper: keeper.address, taskId });
    registry.passDeadlineOf(taskId);

    const stranger = clientFor(registry);
    expect(stranger.address).not.toBe(owner);
    expect(stranger.address).not.toBe(registry.task(taskId).claimer);

    await stranger.client.expireTask({ taskId, caller: stranger.address });

    expect(registry.task(taskId).status).toBe(TaskStatus.Expired);
  });

  it("expires a Pending task that nobody ever claimed", async () => {
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    registry.passDeadlineOf(taskId);
    const stranger = clientFor(registry);

    await stranger.client.expireTask({ taskId, caller: stranger.address });

    expect(registry.task(taskId).status).toBe(TaskStatus.Expired);
  });

  it("rejects a task whose deadline has not passed", async () => {
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    const stranger = clientFor(registry);

    const rejection = await stranger.client
      .expireTask({ taskId, caller: stranger.address })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.DeadlineNotPassed)).toBe(true);
    expect(registry.task(taskId).status).toBe(TaskStatus.Pending);
  });

  it("rejects a task that has already left Pending or Claimed", async () => {
    const registry = new FakeRegistry();
    const stranger = clientFor(registry);

    for (const status of [TaskStatus.Executed, TaskStatus.Cancelled, TaskStatus.Expired]) {
      const taskId = registry.seedTask({ status });
      registry.passDeadlineOf(taskId);

      const rejection = await stranger.client
        .expireTask({ taskId, caller: stranger.address })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.InvalidTaskStatus)).toBe(true);
    }
  });

  it("passes only the task id -- the contract takes no caller argument", async () => {
    // `caller` is the transaction source account and nothing more; it must not
    // leak into the invocation, or the call would not match the contract's ABI.
    const { client, rpc } = testClient();

    await client.expireTask({ taskId: 3, caller: OWNER, signer: keypairSigner(OWNER_KEYPAIR) });

    expect(rpc.onlyCall.method).toBe("expire_task");
    expect(rpc.onlyCall.rawArgs).toHaveLength(1);
    expect(rpc.onlyCall.args[0]).toBe(3n);
    expect(rpc.onlyCall.rawArgs[0]?.switch().name).toBe("scvU64");
  });

  it("refuses to sign for a caller the client has no signer for", async () => {
    // Not an authorization rule of the contract's -- naming a source account
    // this client cannot sign for would build a transaction nobody can submit.
    const { client, rpc } = testClient({}, { signer: keypairSigner(Keypair.random()) });

    await expect(client.expireTask({ taskId: 3, caller: OWNER })).rejects.toThrow(
      /must be authorized by/,
    );
    expect(rpc.calls).toHaveLength(0);
  });
});
