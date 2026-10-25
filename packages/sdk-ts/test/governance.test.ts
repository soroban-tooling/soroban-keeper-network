import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  GovernanceContractError,
  GovernanceErrorCode,
  ProposalStatus,
  VoteType,
} from "../src/governance/index.js";
import { clientFor, FakeGovernance } from "./support/fakeGovernance.js";

describe("GovernanceClient against a modelled local network", () => {
  it("initializes and verifies contract views", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client: adminClient } = clientFor(gov, adminKeypair);

    const kprsToken = Keypair.random().publicKey();
    const registry = Keypair.random().publicKey();

    expect(await adminClient.version()).toBe(1);

    await adminClient.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken,
      registry,
    });

    expect(await adminClient.admin()).toBe(adminKeypair.publicKey());
    expect(await adminClient.kprsToken()).toBe(kprsToken);
    expect(await adminClient.registry()).toBe(registry);

    // Double-initialization should fail with AlreadyInitialized
    await expect(
      adminClient.initialize({
        admin: adminKeypair.publicKey(),
        kprsToken,
        registry,
      }),
    ).rejects.toMatchObject({
      code: GovernanceErrorCode.AlreadyInitialized,
    });
  });

  it("checks voting power, creates proposals, votes, timelocks, and executes", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client: adminClient } = clientFor(gov, adminKeypair);

    const kprsToken = Keypair.random().publicKey();
    const registry = Keypair.random().publicKey();
    await adminClient.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken,
      registry,
    });

    const proposerKeypair = Keypair.random();
    const { client: proposerClient } = clientFor(gov, proposerKeypair);
    gov.setVotingPower(proposerKeypair.publicKey(), 500_000_000n);

    expect(await proposerClient.getVotingPower(proposerKeypair.publicKey())).toBe(500_000_000n);

    const now = 1_700_000_000n;
    gov.setTimestamp(now);
    const eta = now + 172_800n; // 48-hour timelock

    // Create proposal: SetFeeBps
    const proposalId = await proposerClient.createProposal({
      proposer: proposerKeypair.publicKey(),
      action: { type: "SetFeeBps", newBps: 250 },
      eta,
    });
    expect(proposalId).toBe(1n);

    let proposal = await proposerClient.getProposal(proposalId);
    expect(proposal.id).toBe(1n);
    expect(proposal.proposer).toBe(proposerKeypair.publicKey());
    expect(proposal.action).toEqual({ type: "SetFeeBps", newBps: 250 });
    expect(proposal.eta).toBe(eta);
    expect(proposal.status).toBe(ProposalStatus.Queued);

    // Voter casts vote
    const voterKeypair = Keypair.random();
    const { client: voterClient } = clientFor(gov, voterKeypair);
    await voterClient.castVote({
      voter: voterKeypair.publicKey(),
      proposalId,
      support: VoteType.For,
    });

    // Attempting to execute before timelock elapses must be rejected
    await expect(
      proposerClient.executeProposal({ proposalId }),
    ).rejects.toMatchObject({
      code: GovernanceErrorCode.TimelockNotElapsed,
    });

    // Advance time past the timelock ETA
    gov.advanceTime(173_000n);

    // Execution succeeds
    await proposerClient.executeProposal({ proposalId });

    proposal = await proposerClient.getProposal(proposalId);
    expect(proposal.status).toBe(ProposalStatus.Executed);

    // Double-execution is prevented
    await expect(
      proposerClient.executeProposal({ proposalId }),
    ).rejects.toMatchObject({
      code: GovernanceErrorCode.ProposalAlreadyExecuted,
    });
  });

  it("handles various governable action types", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client } = clientFor(gov, adminKeypair);

    await client.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken: Keypair.random().publicKey(),
      registry: Keypair.random().publicKey(),
    });

    const now = 1_700_000_000n;
    gov.setTimestamp(now);

    const p1 = await client.createProposal({
      proposer: adminKeypair.publicKey(),
      action: { type: "SetMinReward", minReward: 10_000_000n },
      eta: now + 100n,
    });
    const prop1 = await client.getProposal(p1);
    expect(prop1.action).toEqual({ type: "SetMinReward", minReward: 10_000_000n });

    const p2 = await client.createProposal({
      proposer: adminKeypair.publicKey(),
      action: { type: "Pause" },
      eta: now + 100n,
    });
    const prop2 = await client.getProposal(p2);
    expect(prop2.action).toEqual({ type: "Pause" });

    const p3 = await client.createProposal({
      proposer: adminKeypair.publicKey(),
      action: { type: "Unpause" },
      eta: now + 100n,
    });
    const prop3 = await client.getProposal(p3);
    expect(prop3.action).toEqual({ type: "Unpause" });
  });

  it("fails when querying non-existent proposal", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client } = clientFor(gov, adminKeypair);

    await client.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken: Keypair.random().publicKey(),
      registry: Keypair.random().publicKey(),
    });

    await expect(client.getProposal(9999n)).rejects.toMatchObject({
      code: GovernanceErrorCode.ProposalNotFound,
    });
  });
});
