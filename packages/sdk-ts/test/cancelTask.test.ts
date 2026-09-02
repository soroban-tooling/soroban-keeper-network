import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { TaskStatus } from "../src/types.js";
import { OWNER, OWNER_KEYPAIR, testClient } from "./support/client.js";
import { FakeRegistry, clientFor } from "./support/fakeRegistry.js";

describe("client.cancelTask", () => {
  it("cancels a Pending task", async () => {
    const registry = new FakeRegistry();
    const owner = Keypair.random();
    const taskId = registry.seedTask({ owner: owner.publicKey() });
    const { client, address } = clientFor(registry, owner);

    await expect(client.cancelTask({ owner: address, taskId })).resolves.toEqual({
      status: "cancelled",
    });
    expect(registry.task(taskId).status).toBe(TaskStatus.Cancelled);
  });

  it("cancels a Claimed task whose lock has lapsed", async () => {
    // The second accepted precondition, added after the contract widened
    // cancel_task beyond Pending-only. An SDK encoding the older rule would
    // wrongly refuse this.
    const registry = new FakeRegistry();
    const owner = Keypair.random();
    const taskId = registry.seedTask({ owner: owner.publicKey() });

    const keeper = clientFor(registry);
    await keeper.client.claimTask({ keeper: keeper.address, taskId });
    expect(registry.task(taskId).status).toBe(TaskStatus.Claimed);
    registry.lapseLockOf(taskId);

    const { client, address } = clientFor(registry, owner);

    await expect(client.cancelTask({ owner: address, taskId })).resolves.toEqual({
      status: "cancelled",
    });
    expect(registry.task(taskId).status).toBe(TaskStatus.Cancelled);
  });

  it("reports LockPeriodActive for a still-locked Claimed task", async () => {
    // Retryable: the same call succeeds once the lock lapses, which the
    // second assertion confirms rather than assuming.
    const registry = new FakeRegistry();
    const owner = Keypair.random();
    const taskId = registry.seedTask({ owner: owner.publicKey() });

    const keeper = clientFor(registry);
    await keeper.client.claimTask({ keeper: keeper.address, taskId });

    const { client, address } = clientFor(registry, owner);
    await expect(client.cancelTask({ owner: address, taskId })).resolves.toEqual({
      status: "lock_period_active",
    });

    registry.lapseLockOf(taskId);
    await expect(client.cancelTask({ owner: address, taskId })).resolves.toEqual({
      status: "cancelled",
    });
  });

  it("reports InvalidTaskStatus distinctly from LockPeriodActive", async () => {
    // Not retryable: a task that has already left Pending/Claimed can never be
    // cancelled, which is why this is a different outcome from a live lock.
    const registry = new FakeRegistry();
    const owner = Keypair.random();
    const { client, address } = clientFor(registry, owner);

    for (const status of [TaskStatus.Executed, TaskStatus.Cancelled, TaskStatus.Expired]) {
      const taskId = registry.seedTask({ owner: owner.publicKey(), status });

      await expect(client.cancelTask({ owner: address, taskId })).resolves.toEqual({
        status: "invalid_task_status",
      });
    }
  });

  it("still throws when the caller is not the task's owner", async () => {
    const registry = new FakeRegistry();
    const taskId = registry.seedTask({ owner: Keypair.random().publicKey() });
    const stranger = clientFor(registry);

    const rejection = await stranger.client
      .cancelTask({ owner: stranger.address, taskId })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.NotTaskOwner)).toBe(true);
  });

  it("sends the owner address and task id the contract expects", async () => {
    const { client, rpc } = testClient();

    await client.cancelTask({ owner: OWNER, taskId: 5, signer: keypairSigner(OWNER_KEYPAIR) });

    expect(rpc.onlyCall.method).toBe("cancel_task");
    expect(rpc.onlyCall.args[0]).toBe(OWNER);
    expect(rpc.onlyCall.args[1]).toBe(5n);
    expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvU64");
  });

  it("refuses to sign for an owner the client has no signer for", async () => {
    const { client, rpc } = testClient({}, { signer: keypairSigner(Keypair.random()) });

    await expect(client.cancelTask({ owner: OWNER, taskId: 5 })).rejects.toThrow(
      /must be authorized by/,
    );
    expect(rpc.calls).toHaveLength(0);
  });
});
