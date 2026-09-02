import { describe, expect, it } from "vitest";

import { SUPPORTED_CONTRACT_VERSIONS } from "../src/constants.js";
import {
  KeeperContractError,
  KeeperErrorCode,
  isKeeperError,
} from "../src/errors.js";
import { TaskStatus, TaskType } from "../src/types.js";
import { CONTRACT_ID, KEEPER, OWNER, testClient } from "./support/client.js";

/** A registry on which `initialize` has never run: Options are None. */
const FRESH_REGISTRY = {
  results: {
    admin: null,
    reward_token_address: null,
    get_fee_bps: 0,
    is_paused: false,
    fees_accrued: 0n,
    min_reward: 0n,
    version: SUPPORTED_CONTRACT_VERSIONS.max,
  },
};

/** A configured registry with a fee, a paused flag, accrued fees, and a floor. */
const CONFIGURED_REGISTRY = {
  results: {
    admin: OWNER,
    reward_token_address: CONTRACT_ID,
    get_fee_bps: 300,
    is_paused: true,
    fees_accrued: 4_200_000n,
    min_reward: 10_000_000n,
    version: SUPPORTED_CONTRACT_VERSIONS.max,
  },
};

describe("contract-level views on an uninitialized registry", () => {
  it("reports no admin as undefined rather than throwing", async () => {
    const { client } = testClient(FRESH_REGISTRY);

    // The contract's views-never-error policy: an unconfigured registry has an
    // unambiguous answer, and a caller must be able to tell "not configured"
    // from "configured as someone else" without a try/catch.
    await expect(client.admin()).resolves.toBeUndefined();
  });

  it("reports no reward token as undefined", async () => {
    const { client } = testClient(FRESH_REGISTRY);
    await expect(client.rewardTokenAddress()).resolves.toBeUndefined();
  });

  it("reports the natural defaults for the remaining views", async () => {
    const { client } = testClient(FRESH_REGISTRY);

    await expect(client.getFeeBps()).resolves.toBe(0);
    await expect(client.isPaused()).resolves.toBe(false);
    await expect(client.feesAccrued()).resolves.toBe(0n);
    await expect(client.minReward()).resolves.toBe(0n);
  });

  it("needs no signer and no funded account", async () => {
    // No `signer` at all: a read must never require one.
    const { client, rpc } = testClient(FRESH_REGISTRY, { signer: undefined });

    await expect(client.isPaused()).resolves.toBe(false);
    expect(rpc.submitted).toHaveLength(0);
  });
});

describe("contract-level views on a configured registry", () => {
  it("returns the admin address", async () => {
    const { client, rpc } = testClient(CONFIGURED_REGISTRY);

    await expect(client.admin()).resolves.toBe(OWNER);
    expect(rpc.onlyCall.method).toBe("admin");
  });

  it("returns the reward token address", async () => {
    const { client } = testClient(CONFIGURED_REGISTRY);
    await expect(client.rewardTokenAddress()).resolves.toBe(CONTRACT_ID);
  });

  it("returns the fee as a number and the i128 amounts as bigint", async () => {
    const { client } = testClient(CONFIGURED_REGISTRY);

    const feeBps = await client.getFeeBps();
    expect(feeBps).toBe(300);
    expect(typeof feeBps).toBe("number");

    const accrued = await client.feesAccrued();
    expect(accrued).toBe(4_200_000n);
    expect(typeof accrued).toBe("bigint");

    await expect(client.minReward()).resolves.toBe(10_000_000n);
  });

  it("reports the paused flag", async () => {
    const { client } = testClient(CONFIGURED_REGISTRY);
    await expect(client.isPaused()).resolves.toBe(true);
  });
});

describe("client.version and the SDK compatibility check", () => {
  it("returns the deployed version without warning when it is supported", async () => {
    const warnings: string[] = [];
    const { client } = testClient(
      { results: { version: SUPPORTED_CONTRACT_VERSIONS.max } },
      { warn: (message) => warnings.push(message) },
    );

    await expect(client.version()).resolves.toBe(SUPPORTED_CONTRACT_VERSIONS.max);
    expect(warnings).toEqual([]);
  });

  it("warns, but still returns, when the contract is newer than this SDK", async () => {
    const warnings: string[] = [];
    const newer = SUPPORTED_CONTRACT_VERSIONS.max + 1;
    const { client } = testClient(
      { results: { version: newer } },
      { warn: (message) => warnings.push(message) },
    );

    // Warn, not throw: a newer contract is additive, and refusing to run
    // against it would strand every integrator the day it is upgraded.
    await expect(client.version()).resolves.toBe(newer);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/newer than/);
  });

  it("warns when the contract is older than this SDK supports", async () => {
    const warnings: string[] = [];
    const older = SUPPORTED_CONTRACT_VERSIONS.min - 1;
    const { client } = testClient(
      { results: { version: older } },
      { warn: (message) => warnings.push(message) },
    );

    await expect(client.version()).resolves.toBe(older);
    expect(warnings[0]).toMatch(/older than/);
  });

  it("warns once per client, so a polling bot does not fill its log", async () => {
    const warnings: string[] = [];
    const { client } = testClient(
      { results: { version: SUPPORTED_CONTRACT_VERSIONS.max + 1 } },
      { warn: (message) => warnings.push(message) },
    );

    await client.version();
    await client.version();
    await client.version();

    expect(warnings).toHaveLength(1);
  });

  it("can be silenced per call", async () => {
    const warnings: string[] = [];
    const { client } = testClient(
      { results: { version: SUPPORTED_CONTRACT_VERSIONS.max + 1 } },
      { warn: (message) => warnings.push(message) },
    );

    await client.version({ warnOnMismatch: false });
    expect(warnings).toEqual([]);
  });

  it("exposes the comparison without emitting anything, for callers deciding themselves", async () => {
    const warnings: string[] = [];
    const newer = SUPPORTED_CONTRACT_VERSIONS.max + 1;
    const { client } = testClient(
      { results: { version: newer } },
      { warn: (message) => warnings.push(message) },
    );

    const compatibility = await client.checkContractCompatibility();

    expect(compatibility).toMatchObject({
      contractVersion: newer,
      status: "contract-newer",
      supported: SUPPORTED_CONTRACT_VERSIONS,
    });
    expect(compatibility.warning).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("reports a supported version as compatible with no warning text", async () => {
    const { client } = testClient({ results: { version: SUPPORTED_CONTRACT_VERSIONS.min } });

    const compatibility = await client.checkContractCompatibility();

    expect(compatibility.status).toBe("compatible");
    expect(compatibility.warning).toBeUndefined();
  });
});

// -- per-task and per-keeper views --------------------------------------------

/** A Pending task: no claimer, no claim ledger -- the contract's Option::None. */
const PENDING_TASK = {
  owner: OWNER,
  task_type: 0,
  calldata: new Uint8Array([1, 2, 3]),
  reward: 5_000_000n,
  deadline: 1_700_000_000n,
  ttl_ledgers: 17_280,
  status: 0,
  claimer: undefined,
  claim_ledger: undefined,
  lock_ledgers: 100,
};

describe("client.getTask", () => {
  it("remaps the contract's snake_case struct to the SDK's camelCase Task", async () => {
    const { client, rpc } = testClient({ results: { get_task: PENDING_TASK } });

    const task = await client.getTask(1);

    expect(task.owner).toBe(OWNER);
    expect(task.taskType).toBe(TaskType.Liquidation);
    expect(task.status).toBe(TaskStatus.Pending);
    expect(task.ttlLedgers).toBe(17_280);
    expect(task.lockLedgers).toBe(100);
    // No snake_case escapes the module.
    expect(task).not.toHaveProperty("task_type");
    expect(task).not.toHaveProperty("ttl_ledgers");
    expect(rpc.onlyCall.method).toBe("get_task");
    // A view: simulated, never submitted.
    expect(rpc.submitted).toHaveLength(0);
  });

  it("keeps reward a bigint and deadline a number, per the conventions", async () => {
    const { client } = testClient({ results: { get_task: PENDING_TASK } });

    const task = await client.getTask(1);

    expect(typeof task.reward).toBe("bigint");
    expect(task.reward).toBe(5_000_000n);
    expect(typeof task.deadline).toBe("number");
    expect(task.deadline).toBe(1_700_000_000);
    // One line from a Date, which is the point of keeping it a number.
    expect(new Date(task.deadline * 1000).getUTCFullYear()).toBe(2023);
  });

  it("surfaces an absent claimer as undefined rather than a Soroban Option", async () => {
    const { client } = testClient({ results: { get_task: PENDING_TASK } });

    const task = await client.getTask(1);

    expect(task.claimer).toBeUndefined();
    expect(task.claimLedger).toBeUndefined();
  });

  it("rejects a nonexistent id as TaskNotFound instead of a nullish task", async () => {
    const { client } = testClient({
      simulationErrors: { get_task: "host invocation failed: Error(Contract, #4)" },
    });

    const rejection = await client.getTask(999).catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.TaskNotFound)).toBe(true);
    expect((rejection as KeeperContractError).codeName).toBe("TaskNotFound");
  });

  it("accepts a bigint id as well as a number", async () => {
    const { client, rpc } = testClient({ results: { get_task: PENDING_TASK } });

    await client.getTask(7n);

    expect(rpc.onlyCall.args).toEqual([7n]);
  });

  it("refuses an unsafe number id rather than addressing the wrong task", async () => {
    const { client, rpc } = testClient({ results: { get_task: PENDING_TASK } });

    await expect(client.getTask(Number.MAX_SAFE_INTEGER + 2)).rejects.toThrow(
      /safe integer range/,
    );
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("client.taskCount", () => {
  it("reports the count as a number", async () => {
    const { client, rpc } = testClient({ results: { task_count: 42n } });

    const count = await client.taskCount();

    expect(count).toBe(42);
    expect(typeof count).toBe("number");
    expect(rpc.onlyCall.method).toBe("task_count");
  });

  it("reports zero on a registry with no tasks yet", async () => {
    const { client } = testClient({ results: { task_count: 0n } });

    await expect(client.taskCount()).resolves.toBe(0);
  });
});

describe("client.keeperBalance", () => {
  it("returns an i128 balance as a bigint", async () => {
    const { client, rpc } = testClient({ results: { keeper_balance: 12_500_000n } });

    const balance = await client.keeperBalance(KEEPER);

    expect(balance).toBe(12_500_000n);
    expect(typeof balance).toBe("bigint");
    expect(rpc.onlyCall.args).toEqual([KEEPER]);
  });

  it("returns 0n for an address that has never earned anything", async () => {
    const { client } = testClient({ results: { keeper_balance: 0n } });

    await expect(client.keeperBalance(KEEPER)).resolves.toBe(0n);
  });

  it("rejects a malformed address locally", async () => {
    const { client, rpc } = testClient();

    await expect(client.keeperBalance("not-an-address")).rejects.toThrow(/must be a Stellar/);
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("client.isClaimable", () => {
  it("reports a claimable task as true", async () => {
    const { client, rpc } = testClient({ results: { is_claimable: true } });

    await expect(client.isClaimable(1)).resolves.toBe(true);
    expect(rpc.onlyCall.method).toBe("is_claimable");
  });

  it("treats a nonexistent id as not claimable rather than an error", async () => {
    // Mirrors the contract's own is_claimable, which answers false rather
    // than raising TaskNotFound -- unlike getTask.
    const { client } = testClient({ results: { is_claimable: false } });

    await expect(client.isClaimable(999)).resolves.toBe(false);
  });
});
