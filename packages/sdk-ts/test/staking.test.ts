import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { KeeperErrorCode, isKeeperError } from "../src/errors.js";
import { ADMIN, ADMIN_KEYPAIR, KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";
import { FakeRegistry, clientFor } from "./support/fakeRegistry.js";

describe("client staking (epic E06)", () => {
  describe("stake_deposit / initiate_unbond / withdraw_stake", () => {
    it("deposits, unbonds, and withdraws stake, agreeing with the SDK's own views at each step", async () => {
      const registry = new FakeRegistry();
      const { client, address } = clientFor(registry);

      expect(await client.keeperStake(address)).toBe(0n);

      await client.stakeDeposit({ keeper: address, amount: 500_000n });
      expect(await client.keeperStake(address)).toBe(500_000n);

      await client.initiateUnbond({ keeper: address, amount: 200_000n });

      // The unbonding amount leaves the effective (claim-gating) stake right
      // away, well before the delay elapses -- see docs/STAKING_DESIGN.md §3.
      expect(await client.keeperStake(address)).toBe(300_000n);
      const pending = await client.pendingUnbond(address);
      expect(pending?.amount).toBe(200_000n);
      expect(pending?.unlockLedger).toBe(registry.ledgerSequence + 86_400);

      // Withdrawing before the delay elapses is rejected.
      const tooEarly = await client.withdrawStake({ keeper: address }).catch((e: unknown) => e);
      expect(isKeeperError(tooEarly, KeeperErrorCode.UnbondNotReady)).toBe(true);

      registry.ledgerSequence = pending?.unlockLedger as number;
      const withdrawn = await client.withdrawStake({ keeper: address });
      expect(withdrawn).toBe(200_000n);
      expect(await client.pendingUnbond(address)).toBeUndefined();
      // The unbonded amount is released; the still-bonded remainder is untouched.
      expect(await client.keeperStake(address)).toBe(300_000n);
    });

    it("rejects a second unbond request while one is already pending", async () => {
      const registry = new FakeRegistry();
      const { client, address } = clientFor(registry);
      await client.stakeDeposit({ keeper: address, amount: 500_000n });
      await client.initiateUnbond({ keeper: address, amount: 100_000n });

      const rejection = await client
        .initiateUnbond({ keeper: address, amount: 50_000n })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.UnbondAlreadyPending)).toBe(true);
    });

    it("rejects unbonding more than the current stake", async () => {
      const registry = new FakeRegistry();
      const { client, address } = clientFor(registry);
      await client.stakeDeposit({ keeper: address, amount: 100_000n });

      const rejection = await client
        .initiateUnbond({ keeper: address, amount: 200_000n })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.InsufficientStake)).toBe(true);
    });

    it("rejects withdrawing with no pending unbond request on file", async () => {
      const registry = new FakeRegistry();
      const { client, address } = clientFor(registry);
      await client.stakeDeposit({ keeper: address, amount: 100_000n });

      const rejection = await client.withdrawStake({ keeper: address }).catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.NoPendingUnbond)).toBe(true);
    });

    it("sends the keeper address and amount the contract expects", async () => {
      const { client, rpc } = testClient();

      await client.stakeDeposit({
        keeper: KEEPER,
        amount: 250_000n,
        signer: keypairSigner(KEEPER_KEYPAIR),
      });

      expect(rpc.onlyCall.method).toBe("stake_deposit");
      expect(rpc.onlyCall.args[0]).toBe(KEEPER);
      expect(rpc.onlyCall.args[1]).toBe(250_000n);
      expect(rpc.onlyCall.rawArgs[1]?.switch().name).toBe("scvI128");
    });
  });

  describe("slash / raise_slash_appeal / resolve_slash_appeal", () => {
    it("reduces a keeper's stake and returns a slash id", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      const treasury = ADMIN;
      await client.stakeDeposit({ keeper, amount: 1_000n });

      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury,
      });

      expect(await client.keeperStake(keeper)).toBe(800n);
      const record = await admin.getSlash(slashId);
      expect(record).toEqual({
        keeper,
        amount: 200n,
        reason: "fraud",
        ledger: registry.ledgerSequence,
        appealed: false,
      });
    });

    it("draws from a pending unbond amount when the bonded stake alone is not enough", async () => {
      // Security-review case (docs/STAKING_SECURITY_REVIEW.md, "Unbonding as
      // a slash-evasion path"): a keeper cannot dodge a slash by front-running
      // it with initiate_unbond -- the funds are still fully in the
      // contract's custody until withdraw_stake actually releases them.
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      await client.initiateUnbond({ keeper, amount: 800n });
      expect(await client.keeperStake(keeper)).toBe(200n);

      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      await admin.slash({ admin: ADMIN, keeper, amount: 500n, reason: "fraud", treasury: ADMIN });

      expect(await client.keeperStake(keeper)).toBe(0n);
      const pending = await client.pendingUnbond(keeper);
      expect(pending?.amount).toBe(500n);
    });

    it("rejects a slash exceeding bonded stake plus any pending unbond", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });

      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const rejection = await admin
        .slash({ admin: ADMIN, keeper, amount: 2_000n, reason: "fraud", treasury: ADMIN })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.InsufficientStake)).toBe(true);
    });

    it("tracks aggregate slash history across multiple slashes", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;

      expect(await client.slashHistory(keeper)).toEqual({ count: 0, totalSlashed: 0n });

      await admin.slash({ admin: ADMIN, keeper, amount: 100n, reason: "fraud", treasury: ADMIN });
      await admin.slash({ admin: ADMIN, keeper, amount: 50n, reason: "late", treasury: ADMIN });

      expect(await client.slashHistory(keeper)).toEqual({ count: 2, totalSlashed: 150n });
    });

    it("upholding an appeal refunds the slashed amount and restores stake", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury: ADMIN,
      });

      await client.raiseSlashAppeal({ keeper, slashId });
      await admin.resolveSlashAppeal({ admin: ADMIN, slashId, upholdAppeal: true });

      expect(await client.keeperStake(keeper)).toBe(1_000n);
      expect(await admin.getSlash(slashId)).toBeUndefined();
    });

    it("rejecting an appeal leaves the slash standing", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury: ADMIN,
      });

      await client.raiseSlashAppeal({ keeper, slashId });
      await admin.resolveSlashAppeal({ admin: ADMIN, slashId, upholdAppeal: false });

      expect(await client.keeperStake(keeper)).toBe(800n);
      expect(await admin.getSlash(slashId)).toBeUndefined();
    });

    it("rejects an appeal raised by anyone other than the slashed keeper", async () => {
      const registry = new FakeRegistry();
      const { client: keeperClient, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await keeperClient.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury: ADMIN,
      });

      const { client: strangerClient, address: stranger } = clientFor(registry);
      const rejection = await strangerClient
        .raiseSlashAppeal({ keeper: stranger, slashId })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.NotSlashedKeeper)).toBe(true);
    });

    it("rejects a second appeal for the same slash", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury: ADMIN,
      });
      await client.raiseSlashAppeal({ keeper, slashId });

      const rejection = await client
        .raiseSlashAppeal({ keeper, slashId })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.AppealAlreadyRaised)).toBe(true);
    });

    it("rejects an appeal raised after the dispute window has closed", async () => {
      const registry = new FakeRegistry();
      const { client, address: keeper } = clientFor(registry, KEEPER_KEYPAIR);
      await client.stakeDeposit({ keeper, amount: 1_000n });
      const admin = clientFor(registry, ADMIN_KEYPAIR).client;
      const slashId = await admin.slash({
        admin: ADMIN,
        keeper,
        amount: 200n,
        reason: "fraud",
        treasury: ADMIN,
      });

      registry.ledgerSequence += 51_840 + 1;

      const rejection = await client
        .raiseSlashAppeal({ keeper, slashId })
        .catch((e: unknown) => e);
      expect(isKeeperError(rejection, KeeperErrorCode.AppealWindowClosed)).toBe(true);
    });

    it("rejects reason strings outside a Soroban Symbol's character set locally, without a network call", async () => {
      const { client, rpc } = testClient();

      await expect(
        client.slash({
          admin: ADMIN,
          keeper: KEEPER,
          amount: 200n,
          reason: "not a valid symbol!",
          treasury: ADMIN,
          signer: keypairSigner(ADMIN_KEYPAIR),
        }),
      ).rejects.toThrow(/1-32 characters/);
      expect(rpc.calls).toHaveLength(0);
    });
  });

  describe("set_min_stake / claim_task gating", () => {
    it("defaults to 0n -- no requirement", async () => {
      const registry = new FakeRegistry();
      const { client } = clientFor(registry);
      expect(await client.minStake()).toBe(0n);
    });

    it("sends the admin address and new floor the contract expects", async () => {
      const { client, rpc } = testClient();

      await client.setMinStake({
        admin: ADMIN,
        minStake: 500_000n,
        signer: keypairSigner(ADMIN_KEYPAIR),
      });

      expect(rpc.onlyCall.method).toBe("set_min_stake");
      expect(rpc.onlyCall.args[0]).toBe(ADMIN);
      expect(rpc.onlyCall.args[1]).toBe(500_000n);
    });
  });
});
