import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { TaskStatus } from "../src/types.js";
import { KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";
import { FakeRegistry, clientFor } from "./support/fakeRegistry.js";

describe("client.claimTask", () => {
  it("claims a Pending task", async () => {
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    const { client, address } = clientFor(registry);

    await expect(client.claimTask({ keeper: address, taskId })).resolves.toEqual({
      status: "claimed",
    });
    expect(registry.task(taskId).status).toBe(TaskStatus.Claimed);
    expect(registry.task(taskId).claimer).toBe(address);
  });

  it("reports LockPeriodActive as a typed outcome rather than throwing", async () => {
    // Losing a claim race is routine for a keeper bot, not exceptional: it
    // should move on to the next task and come back once the lock lapses.
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    const first = clientFor(registry);
    await first.client.claimTask({ keeper: first.address, taskId });

    const second = clientFor(registry);

    await expect(second.client.claimTask({ keeper: second.address, taskId })).resolves.toEqual({
      status: "lock_period_active",
    });
    expect(registry.task(taskId).claimer).toBe(first.address);
  });

  it("succeeds on a re-claim once the previous keeper's lock has lapsed", async () => {
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    const first = clientFor(registry);
    await first.client.claimTask({ keeper: first.address, taskId });
    registry.lapseLockOf(taskId);

    const second = clientFor(registry);

    await expect(second.client.claimTask({ keeper: second.address, taskId })).resolves.toEqual({
      status: "claimed",
    });
    expect(registry.task(taskId).claimer).toBe(second.address);
  });

  it("reports DeadlinePassed distinctly from LockPeriodActive", async () => {
    // The distinction is the whole point: lock_period_active means keep
    // scanning, deadline_passed means this task is dead -- stop retrying it.
    const registry = new FakeRegistry();
    const taskId = registry.seedTask();
    registry.passDeadlineOf(taskId);
    const { client, address } = clientFor(registry);

    await expect(client.claimTask({ keeper: address, taskId })).resolves.toEqual({
      status: "deadline_passed",
    });
  });

  it("still throws for failures outside normal claim racing", async () => {
    const registry = new FakeRegistry();
    const { client, address } = clientFor(registry);

    const rejection = await client
      .claimTask({ keeper: address, taskId: 404 })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.TaskNotFound)).toBe(true);
  });

  it("is permissionless -- any account may claim, not just the owner", async () => {
    const registry = new FakeRegistry();
    const owner = Keypair.random().publicKey();
    const taskId = registry.seedTask({ owner });
    const stranger = clientFor(registry);

    await expect(stranger.client.claimTask({ keeper: stranger.address, taskId })).resolves.toEqual({
      status: "claimed",
    });
    expect(stranger.address).not.toBe(owner);
  });

  it("sends the keeper address and task id the contract expects", async () => {
    const { client, rpc } = testClient();

    await client.claimTask({ keeper: KEEPER, taskId: 9, signer: keypairSigner(KEEPER_KEYPAIR) });

    expect(rpc.onlyCall.method).toBe("claim_task");
    expect(rpc.onlyCall.args[0]).toBe(KEEPER);
    expect(rpc.onlyCall.args[1]).toBe(9n);
    expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvU64");
  });

  it("refuses to sign for a keeper the client has no signer for", async () => {
    const { client, rpc } = testClient();

    await expect(client.claimTask({ keeper: KEEPER, taskId: 9 })).rejects.toThrow(
      /must be authorized by/,
    );
    expect(rpc.calls).toHaveLength(0);
  });
});
