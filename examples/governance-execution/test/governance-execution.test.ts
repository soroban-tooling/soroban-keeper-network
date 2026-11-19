import test from "node:test";
import assert from "node:assert/strict";
import { GovernanceExecutionManager } from "../src/governance-execution.ts";
import { registerTaskOnProposalPassed } from "../scripts/register-governance-task.ts";

test("Criterion 1: Task is registered when a proposal passes and executes after the timelock", () => {
  const start = 1_000_000;
  const timelock = 86400; // 24-hour timelock (ends at 1,086,400)
  const manager = new GovernanceExecutionManager(start);

  // Proposal 1 passes and is queued
  const proposal = manager.queuePassedProposal(
    1,
    "SIP-004: Adjust Base Protocol Fee to 250 bps",
    "CC_REGISTRY_CONTRACT",
    "set_fee_bps(250)",
    timelock
  );

  assert.equal(proposal.id, 1);
  assert.equal(proposal.status, "PASSED_AND_QUEUED");
  assert.equal(proposal.eta, 1_086_400);

  // Script registers task immediately when proposal passes
  const task = registerTaskOnProposalPassed("CC_GOVERNANCE_CONTRACT", proposal);

  // Verifies task is registered targeting post-timelock execution:
  assert.equal(task.proposalId, 1);
  assert.equal(task.targetContract, "CC_GOVERNANCE_CONTRACT");
  assert.equal(task.functionName, "execute_proposal");
  assert.deepEqual(task.args, [1]);
  assert.equal(task.timelockEta, 1_086_400);
  assert.equal(task.condition.minimumTimestamp, 1_086_400);
});

test("Criterion 2: Execution before the timelock fails on-chain", () => {
  const start = 2_000_000;
  const timelock = 7200; // 2-hour timelock (ETA: 2,007,200)
  const manager = new GovernanceExecutionManager(start);

  const proposal = manager.queuePassedProposal(
    99,
    "Emergency Migration Timelock",
    "CC_TARGET",
    "upgrade_v2",
    timelock
  );

  const keeper = "GD_KEEPER_BOT_RUNNER";

  // 1. Immediately after passing (0s elapsed) -> MUST FAIL
  assert.throws(
    () => manager.executeProposal(proposal.id, keeper),
    /TIMELOCK_NOT_ELAPSED.*wait 7200s/,
    "Immediate execution before timelock must fail"
  );

  // 2. Half-way through timelock (1 hour elapsed, 1 hour remaining) -> MUST FAIL
  manager.advanceSeconds(3600);
  assert.throws(
    () => manager.executeProposal(proposal.id, keeper),
    /TIMELOCK_NOT_ELAPSED.*wait 3600s/,
    "Execution mid-timelock must fail"
  );

  // 3. 5 seconds before ETA -> MUST FAIL
  manager.setTimestamp(proposal.eta - 5);
  assert.throws(
    () => manager.executeProposal(proposal.id, keeper),
    /TIMELOCK_NOT_ELAPSED.*wait 5s/,
    "Execution 5s before timelock must fail"
  );

  // 4. Exactly at or after ETA -> Execution succeeds!
  manager.setTimestamp(proposal.eta);
  const result = manager.executeProposal(proposal.id, keeper);

  assert.equal(result.proposalId, 99);
  assert.equal(result.executedBy, keeper);
  assert.equal(manager.getProposal(proposal.id).status, "EXECUTED");
});
