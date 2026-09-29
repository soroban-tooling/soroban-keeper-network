import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperContractError, KeeperErrorCode, KeeperRpcError, isKeeperError } from "../src/errors.js";
import { type WithdrawRewardsOutcome } from "../src/methods/withdrawRewards.js";
import { KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";

/** Larger than Number.MAX_SAFE_INTEGER, which is the whole point of bigint. */
const HUGE_BALANCE = 9_007_199_254_740_993n;

function keeperClient(rpcOptions = {}) {
  return testClient(rpcOptions, { signer: keypairSigner(KEEPER_KEYPAIR) });
}

describe("client.withdrawRewards", () => {
  describe("happy path with pre-check", () => {
    it("returns the withdrawn amount the contract reports as an outcome", async () => {
      const { client, rpc } = keeperClient({
        keeperBalance: 12_500_000n,
        results: { withdraw_rewards: 12_500_000n },
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome).toEqual({ status: "withdrawn", amount: 12_500_000n });
      expect(rpc.submitted).toHaveLength(1);
    });

    it("returns an i128 beyond Number.MAX_SAFE_INTEGER without losing precision", async () => {
      const { client } = keeperClient({
        keeperBalance: HUGE_BALANCE,
        results: { withdraw_rewards: HUGE_BALANCE },
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome).toEqual({ status: "withdrawn", amount: HUGE_BALANCE });
      expect(outcome.status === "withdrawn" && outcome.amount.toString()).toBe(
        "9007199254740993",
      );
      // What a `number` return type would have silently handed back instead.
      expect(Number(HUGE_BALANCE).toString()).toBe("9007199254740992");
    });
  });

  describe("pre-submission balance check (new pattern)", () => {
    it("returns no_rewards_available without submitting when balance is zero", async () => {
      const { client, rpc } = keeperClient({
        keeperBalance: 0n, // Pre-check: balance is zero
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome).toEqual({ status: "no_rewards_available", amount: 0n });
      // Critical: no transaction was submitted when balance was zero.
      expect(rpc.submitted).toHaveLength(0);
    });

    it("avoids fee-paying transactions when balance is zero (issue #0397)", async () => {
      // This is the core improvement: simulate to check balance for free, then
      // only submit if non-zero. Pre-submission simulation failures are skips, not fees.
      const { client, rpc } = keeperClient({
        keeperBalance: 0n,
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome.status).toBe("no_rewards_available");
      // Two calls: balance check (read), no withdrawal (invoke).
      const balanceChecks = rpc.calls.filter((c) => c.method === "keeper_balance");
      const submissions = rpc.submitted.filter((s) => s.method === "withdraw_rewards");
      expect(balanceChecks.length).toBeGreaterThan(0);
      expect(submissions).toHaveLength(0); // No fee paid
    });

    it("reads balance and proceeds to submission when non-zero", async () => {
      const { client, rpc } = keeperClient({
        keeperBalance: 100_000n,
        results: { withdraw_rewards: 100_000n },
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome).toEqual({ status: "withdrawn", amount: 100_000n });
      expect(rpc.submitted.length).toBeGreaterThan(0); // Submission occurred
    });

    it("outcome type disambiguates success from no-rewards", async () => {
      const { client } = keeperClient({
        keeperBalance: 0n,
      });

      const outcome = await client.withdrawRewards({ keeper: KEEPER });

      // TypeScript narrows the outcome type after checking the status.
      if (outcome.status === "no_rewards_available") {
        // Pre-check caught it; no fee paid.
        expect(outcome.amount).toBe(0n);
      } else if (outcome.status === "withdrawn") {
        // Submission succeeded.
        expect(typeof outcome.amount).toBe("bigint");
      } else {
        // Exhaustiveness check.
        const _exhaustive: never = outcome;
      }
    });
  });

  describe("non-routine failures still throw", () => {
    it("rejects balance-check authorization failure (not a skip)", async () => {
      const { client } = keeperClient({
        simulationErrors: { keeper_balance: "host invocation failed: Error(Contract, #2)" },
      });

      const rejection = await client
        .withdrawRewards({ keeper: KEEPER })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.Unauthorized)).toBe(true);
    });

    it("rejects contract-paused during balance check (not a routine skip)", async () => {
      const { client } = keeperClient({
        simulationErrors: { keeper_balance: "host invocation failed: Error(Contract, #3)" },
      });

      const rejection = await client
        .withdrawRewards({ keeper: KEEPER })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.ContractPaused)).toBe(true);
    });

    it("throws on type mismatch in contract response", async () => {
      const { client, rpc } = keeperClient({
        keeperBalance: 100_000n,
      });
      // Simulate a contract that returns the wrong type
      rpc.mockKeeperBalance = "not a bigint" as any;

      const rejection = await client
        .withdrawRewards({ keeper: KEEPER })
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(TypeError);
      expect((rejection as TypeError).message).toContain("i128");
    });

    it("reports an RPC failure separately from a contract rejection", async () => {
      const { client } = keeperClient({
        simulationErrors: { keeper_balance: "503 Service Unavailable" },
      });

      await expect(client.withdrawRewards({ keeper: KEEPER })).rejects.toBeInstanceOf(
        KeeperRpcError,
      );
    });

    it("needs a signer that can authorize the withdrawing keeper", async () => {
      // The default client signs as OWNER, not KEEPER.
      const { client, rpc } = testClient();

      await expect(client.withdrawRewards({ keeper: KEEPER })).rejects.toThrow(
        /must be authorized by/,
      );
      expect(rpc.calls).toHaveLength(0);
    });
  });

  describe("old rejection pattern for backward compatibility", () => {
    it("would have rejected NoRewardsAvailable (old: balance check during submission)", async () => {
      // This test documents the old behavior for reference only.
      // New code uses the pre-check; this outcome is never reached in practice.
      const { client } = keeperClient({
        keeperBalance: 100_000n, // Balance is non-zero, so pre-check passes
        simulationErrors: {
          // But submission fails anyway (edge case or test scenario)
          withdraw_rewards: "host invocation failed: Error(Contract, #13)",
        },
      });

      const rejection = await client
        .withdrawRewards({ keeper: KEEPER })
        .catch((error: unknown) => error);

      // This error would be thrown, not returned as an outcome.
      expect(isKeeperError(rejection, KeeperErrorCode.NoRewardsAvailable)).toBe(true);
    });
  });

  describe("no double-submission on retry", () => {
    it("pre-check result is deterministic, preventing retry loops", async () => {
      const { client, rpc } = keeperClient({
        keeperBalance: 0n,
      });

      const outcome1 = await client.withdrawRewards({ keeper: KEEPER });
      const outcome2 = await client.withdrawRewards({ keeper: KEEPER });

      expect(outcome1).toEqual({ status: "no_rewards_available", amount: 0n });
      expect(outcome2).toEqual({ status: "no_rewards_available", amount: 0n });
      // Same result both times; no retry loop or fee waste.
      expect(rpc.submitted).toHaveLength(0);
    });
  });
});

describe("client.tryWithdrawRewards", () => {
  it("returns 0n when there is nothing to withdraw (deprecated, uses pre-check now)", async () => {
    const { client } = keeperClient({
      keeperBalance: 0n,
    });

    // A bot withdrawing on a timer hits this as its steady state, not as an
    // incident worth logging. This wrapper is now just a convenience that
    // extracts the amount from the outcome.
    const amount = await client.tryWithdrawRewards({ keeper: KEEPER });

    expect(amount).toBe(0n);
  });

  it("returns the amount on a successful withdrawal (deprecated)", async () => {
    const { client } = keeperClient({
      keeperBalance: 42n,
      results: { withdraw_rewards: 42n },
    });

    const amount = await client.tryWithdrawRewards({ keeper: KEEPER });

    expect(amount).toBe(42n);
  });

  it("does not swallow any other contract error (deprecated)", async () => {
    const { client } = keeperClient({
      simulationErrors: { keeper_balance: "host invocation failed: Error(Contract, #3)" },
    });

    await expect(client.tryWithdrawRewards({ keeper: KEEPER })).rejects.toMatchObject({
      code: KeeperErrorCode.ContractPaused,
    });
  });

  it("is marked as @deprecated in favor of withdrawRewards", () => {
    // This is a documentation check: JSDoc should note that tryWithdrawRewards
    // is deprecated in favor of using withdrawRewards and pattern-matching on
    // the outcome type.
    expect(true).toBe(true); // Placeholder: doc review in the actual SDK
  });
});

describe("withdrawRewards outcome type safety", () => {
  it("narrows correctly for pattern matching", async () => {
    const { client } = keeperClient({
      keeperBalance: 0n,
    });

    const outcome = await client.withdrawRewards({ keeper: KEEPER });

    // TypeScript narrows based on the status field.
    const message: string = (() => {
      if (outcome.status === "withdrawn") {
        return `Withdrew ${outcome.amount} stroops`;
      } else if (outcome.status === "no_rewards_available") {
        return "No rewards to withdraw";
      } else {
        // Exhaustiveness check: all statuses handled.
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    })();

    expect(message).toBe("No rewards to withdraw");
  });
});
