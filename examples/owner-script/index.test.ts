/* Authorized Protocol Quality Assurance & Formal Verification Test Suite */

import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { runOwnerScript } from "./index.js";
import { TaskStatus, TaskType } from "@soroban-keeper-network/sdk";

test("runOwnerScript: successfully registers task and waits for keeper execution", async () => {
  const keypair = Keypair.random();
  const mockTaskId = 42n;

  let registeredParams: any = null;
  const mockClient: any = {
    registerTask: async (params: any) => {
      registeredParams = params;
      return mockTaskId;
    },
    getTask: async (id: bigint) => {
      assert.equal(id, mockTaskId);
      return {
        owner: keypair.publicKey(),
        taskType: TaskType.Custom,
        calldata: new Uint8Array([1, 2, 3]),
        reward: 10_000_000n,
        deadline: Math.floor(Date.now() / 1000) + 100,
        ttlLedgers: 100,
        status: TaskStatus.Executed,
        claimer: "G_KEEPER_ADDRESS_12345",
        claimLedger: 50,
        lockLedgers: 10
      };
    },
    expireTask: async () => {
      assert.fail("expireTask should not be called when task executes");
    }
  };

  const result = await runOwnerScript({
    client: mockClient,
    keypair,
    deadlineSeconds: 50,
    pollIntervalMs: 10
  });

  assert.equal(result.taskId, mockTaskId);
  assert.equal(result.status, "executed");
  assert.equal(result.claimer, "G_KEEPER_ADDRESS_12345");
  assert.equal(registeredParams.owner, keypair.publicKey());
  assert.equal(registeredParams.taskType, TaskType.Custom);
});

test("runOwnerScript: handles not-executed-before-deadline by triggering expireTask to reclaim escrow", async () => {
  const keypair = Keypair.random();
  const mockTaskId = 99n;

  let expireCalled = false;
  const mockClient: any = {
    registerTask: async () => mockTaskId,
    getTask: async () => {
      return {
        owner: keypair.publicKey(),
        taskType: TaskType.Custom,
        calldata: new Uint8Array([1, 2, 3]),
        reward: 10_000_000n,
        deadline: Math.floor(Date.now() / 1000) - 1, // expired
        ttlLedgers: 100,
        status: TaskStatus.Pending,
        claimer: undefined,
        claimLedger: undefined,
        lockLedgers: 10
      };
    },
    expireTask: async (params: any) => {
      assert.equal(params.taskId, mockTaskId);
      expireCalled = true;
      return true;
    }
  };

  const result = await runOwnerScript({
    client: mockClient,
    keypair,
    deadlineSeconds: 0, // expires immediately
    pollIntervalMs: 10
  });

  assert.equal(result.taskId, mockTaskId);
  assert.equal(result.status, "expired");
  assert.equal(expireCalled, true, "expireTask must be called to reclaim escrow");
});

test("runOwnerScript: handles task cancellation gracefully", async () => {
  const keypair = Keypair.random();
  const mockTaskId = 101n;

  const mockClient: any = {
    registerTask: async () => mockTaskId,
    getTask: async () => ({
      owner: keypair.publicKey(),
      taskType: TaskType.Custom,
      calldata: new Uint8Array([1, 2, 3]),
      reward: 10_000_000n,
      deadline: Math.floor(Date.now() / 1000) + 500,
      ttlLedgers: 100,
      status: TaskStatus.Cancelled,
      claimer: undefined,
      claimLedger: undefined,
      lockLedgers: 10
    }),
    expireTask: async () => {
      assert.fail("expireTask should not be called on cancelled task");
    }
  };

  const result = await runOwnerScript({
    client: mockClient,
    keypair,
    deadlineSeconds: 50,
    pollIntervalMs: 10
  });

  assert.equal(result.taskId, mockTaskId);
  assert.equal(result.status, "cancelled");
});
