import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { keypairAuthSigner } from "../src/core/auth.js";
import { TreasuryContractError, TreasuryErrorCode } from "../src/treasury/errors.js";
import { clientFor, FakeTreasury } from "./support/fakeTreasury.js";

describe("TreasuryClient against a modelled local network", () => {
  it("configures recipients, distributes, and confirms every view agrees with on-chain state", async () => {
    const treasury = new FakeTreasury();
    const adminKeypair = Keypair.random();
    const { client: admin } = clientFor(treasury, adminKeypair);
    const rewardToken = Keypair.random().publicKey();

    await admin.initialize({ admin: adminKeypair.publicKey(), rewardToken });
    expect(await admin.admin()).toBe(adminKeypair.publicKey());
    expect(await admin.rewardTokenAddress()).toBe(rewardToken);
    expect(await admin.isPaused()).toBe(false);

    const r1Keypair = Keypair.random();
    const r1 = r1Keypair.publicKey();
    const r2 = Keypair.random().publicKey();
    await admin.addRecipient({ admin: adminKeypair.publicKey(), recipient: r1, sharesBps: 3_000 });
    await admin.addRecipient({ admin: adminKeypair.publicKey(), recipient: r2, sharesBps: 7_000 });

    const recipients = await admin.recipients();
    expect(recipients).toEqual([
      { address: r1, sharesBps: 3_000 },
      { address: r2, sharesBps: 7_000 },
    ]);
    expect(await admin.recipientShares(r1)).toBe(3_000);
    expect(await admin.recipientShares(r2)).toBe(7_000);

    await admin.distribute({ caller: adminKeypair.publicKey(), amount: 1_000_000n });

    expect(await admin.recipientBalance(r1)).toBe(300_000n);
    expect(await admin.recipientBalance(r2)).toBe(700_000n);
    expect(await admin.recipientTotalReceived(r1)).toBe(300_000n);
    expect(await admin.totalDistributed()).toBe(1_000_000n);

    // Reweighting mid-sequence: r1 now takes half, and only affects future
    // distributions, per the SDK's view of on-chain state.
    await admin.updateRecipientShares({ admin: adminKeypair.publicKey(), recipient: r1, newSharesBps: 5_000 });
    await admin.updateRecipientShares({ admin: adminKeypair.publicKey(), recipient: r2, newSharesBps: 5_000 });
    await admin.distribute({ caller: adminKeypair.publicKey(), amount: 1_000_000n });

    expect(await admin.recipientBalance(r1)).toBe(300_000n + 500_000n);
    expect(await admin.recipientBalance(r2)).toBe(700_000n + 500_000n);
    expect(await admin.totalDistributed()).toBe(2_000_000n);

    // Withdrawing r1's balance moves exactly what was credited, and only
    // resets the withdrawable balance -- never the lifetime-received total.
    const { client: r1Client } = clientFor(treasury, r1Keypair);
    const withdrawn = await r1Client.withdraw({ recipient: r1 });
    expect(withdrawn).toBe(800_000n);
    expect(await admin.recipientBalance(r1)).toBe(0n);
    expect(await admin.recipientTotalReceived(r1)).toBe(800_000n);
    expect(await admin.totalDistributed()).toBe(2_000_000n);

    expect(await admin.version()).toBe(1);
    expect(await admin.maxRecipients()).toBe(50);
  });

  it("blocks distribute while paused but leaves withdraw and views open", async () => {
    const treasury = new FakeTreasury();
    const adminKeypair = Keypair.random();
    const { client: admin } = clientFor(treasury, adminKeypair);
    await admin.initialize({ admin: adminKeypair.publicKey(), rewardToken: Keypair.random().publicKey() });

    const r1 = Keypair.random().publicKey();
    await admin.addRecipient({ admin: adminKeypair.publicKey(), recipient: r1, sharesBps: 1 });
    await admin.distribute({ caller: adminKeypair.publicKey(), amount: 1_000n });

    await admin.pause({ admin: adminKeypair.publicKey() });
    expect(await admin.isPaused()).toBe(true);

    await expect(admin.distribute({ caller: adminKeypair.publicKey(), amount: 1_000n })).rejects.toMatchObject({
      code: TreasuryErrorCode.ContractPaused,
    });

    // Withdraw and views remain available while paused.
    expect(await admin.recipientBalance(r1)).toBe(1_000n);

    await admin.unpause({ admin: adminKeypair.publicKey() });
    expect(await admin.isPaused()).toBe(false);
  });

  it("tryWithdraw resolves to 0n instead of rejecting on an empty balance", async () => {
    const treasury = new FakeTreasury();
    const adminKeypair = Keypair.random();
    const { client: admin } = clientFor(treasury, adminKeypair);
    await admin.initialize({ admin: adminKeypair.publicKey(), rewardToken: Keypair.random().publicKey() });

    const r1Keypair = Keypair.random();
    const { client: r1Client } = clientFor(treasury, r1Keypair);
    const withdrawn = await r1Client.tryWithdraw({ recipient: r1Keypair.publicKey() });
    expect(withdrawn).toBe(0n);
  });

  it("rejects a non-admin's attempt to add a recipient with a typed TreasuryContractError", async () => {
    const treasury = new FakeTreasury();
    const adminKeypair = Keypair.random();
    const { client: admin } = clientFor(treasury, adminKeypair);
    await admin.initialize({ admin: adminKeypair.publicKey(), rewardToken: Keypair.random().publicKey() });

    const strangerKeypair = Keypair.random();
    const { client: stranger } = clientFor(treasury, strangerKeypair);

    await expect(
      stranger.addRecipient({
        admin: strangerKeypair.publicKey(),
        recipient: Keypair.random().publicKey(),
        sharesBps: 1_000,
      }),
    ).rejects.toBeInstanceOf(TreasuryContractError);
  });

  it("transferAdmin requires both parties' authorization", async () => {
    const treasury = new FakeTreasury();
    const adminKeypair = Keypair.random();
    const newAdminKeypair = Keypair.random();
    const { client: admin } = clientFor(treasury, adminKeypair);
    await admin.initialize({ admin: adminKeypair.publicKey(), rewardToken: Keypair.random().publicKey() });

    await admin.transferAdmin({
      currentAdmin: adminKeypair.publicKey(),
      newAdmin: newAdminKeypair.publicKey(),
      authSigners: [keypairAuthSigner(adminKeypair), keypairAuthSigner(newAdminKeypair)],
    });

    expect(await admin.admin()).toBe(newAdminKeypair.publicKey());
  });
});
