import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  GovernanceContractError,
  GovernanceErrorCode,
} from "../src/governance/errors.js";
import { VoteChoice } from "../src/governance/types.js";
import { clientFor, FakeGovernance } from "./support/fakeGovernance.js";

describe("GovernanceClient against a modelled local network", () => {
  it("initializes, creates a proposal, votes, evaluates, queues, and executes after timelock", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client: adminClient } = clientFor(gov, adminKeypair);

    const kprsToken = Keypair.random().publicKey();
    const registry = Keypair.random().publicKey();

    // 1. Initialize
    await adminClient.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken,
      registry,
    });

    expect(await adminClient.admin()).toBe(adminKeypair.publicKey());
    expect(await adminClient.kprsToken()).toBe(kprsToken);
    expect(await adminClient.registry()).toBe(registry);
    expect(await adminClient.version()).toBe(1);
    expect(await adminClient.proposalCount()).toBe(0n);

    // 2. Proposer setup
    const proposerKeypair = Keypair.random();
    const proposer = proposerKeypair.publicKey();
    gov.setVoterBalance(proposer, 500_000_0000000n); // Above proposal threshold

    const { client: proposerClient } = clientFor(gov, proposerKeypair);

    const proposalId = await proposerClient.createProposal({
      proposer,
      action: { type: "SetFeeBps", bps: 500 },
    });
    expect(proposalId).toBe(1n);
    expect(await adminClient.proposalCount()).toBe(1n);

    const proposal = await adminClient.getProposal(proposalId);
    expect(proposal.id).toBe(1n);
    expect(proposal.status).toBe("Active");
    expect(proposal.proposer).toBe(proposer);

    // 3. Voting
    const voterKeypair = Keypair.random();
    const voter = voterKeypair.publicKey();
    gov.setVoterBalance(voter, 10_000_000_0000000n); // Substantial voting weight (10% supply)

    const { client: voterClient } = clientFor(gov, voterKeypair);
    await voterClient.vote({
      voter,
      proposalId,
      choice: VoteChoice.For,
    });

    expect(await adminClient.hasVoted(proposalId, voter)).toBe(true);
    const tallies = await adminClient.getTallies(proposalId);
    expect(tallies[0]).toBe(10_000_000_0000000n); // votesFor

    // 4. Advance past voting period and evaluate
    const votingPeriod = await adminClient.votingPeriod();
    gov.ledgerSequence += votingPeriod + 1;

    const evaluatedStatus = await adminClient.evaluateProposal({
      caller: adminKeypair.publicKey(),
      proposalId,
    });
    expect(evaluatedStatus).toBe("Passed");

    // 5. Queue proposal
    const eta = await adminClient.queueProposal({
      caller: adminKeypair.publicKey(),
      proposalId,
    });
    expect(eta).toBeGreaterThan(BigInt(gov.ledgerSequence));
    expect(await adminClient.isExecutable(proposalId)).toBe(false);

    // 6. Timelock progression and execution
    const remainingDelay = await adminClient.getRemainingDelay(proposalId);
    gov.ledgerSequence += Number(remainingDelay) + 1;

    expect(await adminClient.isExecutable(proposalId)).toBe(true);

    await adminClient.executeProposal({
      caller: adminKeypair.publicKey(),
      proposalId,
    });

    const finalProposal = await adminClient.getProposal(proposalId);
    expect(finalProposal.status).toBe("Executed");
  });

  it("rejects proposal creation when proposer holds insufficient tokens with typed error", async () => {
    const gov = new FakeGovernance();
    const adminKeypair = Keypair.random();
    const { client: adminClient } = clientFor(gov, adminKeypair);

    await adminClient.initialize({
      admin: adminKeypair.publicKey(),
      kprsToken: Keypair.random().publicKey(),
      registry: Keypair.random().publicKey(),
    });

    const poorProposerKeypair = Keypair.random();
    gov.setVoterBalance(poorProposerKeypair.publicKey(), 100n); // Below threshold

    const { client: poorProposerClient } = clientFor(gov, poorProposerKeypair);

    await expect(
      poorProposerClient.createProposal({
        proposer: poorProposerKeypair.publicKey(),
        action: { type: "PauseRegistry" },
      }),
    ).rejects.toMatchObject({
      code: GovernanceErrorCode.InsufficientProposerBalance,
    });
  });
});
