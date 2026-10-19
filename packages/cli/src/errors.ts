/**
 * Plain-language explanations for every contract error (issue #694). Each entry
 * says what happened and what to do next. Written as `Record` over the SDK's
 * `KeeperErrorCode` enum, so adding a code to the enum without a message is a
 * type error, and `test/errors.test.ts` checks the same at run time.
 */
import { KeeperErrorCode } from "@soroban-keeper-network/sdk";

export interface ContractErrorHelp {
  name: string;
  message: string;
  hint: string;
}

const HELP: Record<KeeperErrorCode, { message: string; hint: string }> = {
  [KeeperErrorCode.AlreadyInitialized]: {
    message: "The registry is already initialized.",
    hint: "Nothing to do. Use the existing deployment, or deploy a new registry.",
  },
  [KeeperErrorCode.Unauthorized]: {
    message: "The signing account is not allowed to perform this action.",
    hint: "Sign with the admin account for admin commands, or check the key source with 'skn config show'.",
  },
  [KeeperErrorCode.ContractPaused]: {
    message: "The registry is paused, so state-changing calls are refused.",
    hint: "Wait for the admin to unpause the registry, then retry.",
  },
  [KeeperErrorCode.TaskNotFound]: {
    message: "No task exists with that ID.",
    hint: "Check the ID with 'skn task list', or confirm you are on the right network and contract.",
  },
  [KeeperErrorCode.InvalidTaskStatus]: {
    message: "The task is not in a status that allows this action.",
    hint: "Run 'skn task show <id>' to see its current status, then use an action that matches it.",
  },
  [KeeperErrorCode.DeadlinePassed]: {
    message: "The task's deadline has already passed.",
    hint: "Register a new task with a later deadline. Expired tasks cannot be claimed or extended.",
  },
  [KeeperErrorCode.DeadlineNotPassed]: {
    message: "The task's deadline has not passed yet.",
    hint: "Wait until the deadline, then retry the action that needs an expired task.",
  },
  [KeeperErrorCode.InvalidReward]: {
    message: "The reward is outside the range the registry accepts.",
    hint: "Use a reward at or above the registry's minimum, and within its ceiling.",
  },
  [KeeperErrorCode.LockPeriodActive]: {
    message: "Another keeper holds this task during its lock window.",
    hint: "Wait for the lock window to end, then retry. 'skn task show <id>' prints the lock expiry.",
  },
  [KeeperErrorCode.InvalidFeeBps]: {
    message: "The fee is outside the allowed basis-point range.",
    hint: "Use a fee between 0 and the registry's maximum basis points.",
  },
  [KeeperErrorCode.NotTaskOwner]: {
    message: "Only the task's owner can do this.",
    hint: "Sign with the account that registered the task.",
  },
  [KeeperErrorCode.NotTaskClaimer]: {
    message: "Only the keeper who claimed this task can do this.",
    hint: "Sign with the keeper that holds the claim, or wait for the lock to expire.",
  },
  [KeeperErrorCode.NoRewardsAvailable]: {
    message: "There are no rewards to withdraw.",
    hint: "Check 'skn keeper balance' after tasks are executed.",
  },
  [KeeperErrorCode.ProofTooLarge]: {
    message: "The proof is larger than the registry accepts.",
    hint: "Shorten the proof, or check the proof limit in the SDK documentation.",
  },
  [KeeperErrorCode.NotInitialized]: {
    message: "The registry has not been initialized yet.",
    hint: "Run the registry's initialize step after deploying it.",
  },
  [KeeperErrorCode.TtlTooShort]: {
    message: "The storage lifetime is shorter than the minimum the registry requires.",
    hint: "Raise the TTL so it is at least the registry's minimum, and at least the task's deadline.",
  },
  [KeeperErrorCode.CalldataTooLarge]: {
    message: "The task's calldata is larger than the registry accepts.",
    hint: "Reduce the arguments, or pass fewer of them.",
  },
  [KeeperErrorCode.InvalidTaskParams]: {
    message: "The task parameters are not valid together.",
    hint: "Check the lock, TTL and deadline values. The lock must be within the allowed range.",
  },
  [KeeperErrorCode.ArithmeticOverflow]: {
    message: "A calculation would overflow.",
    hint: "Use smaller amounts or a smaller range. Report it if a normal input triggers this.",
  },
  [KeeperErrorCode.IncompatibleVerifierInterface]: {
    message: "The verifier contract does not implement the interface the registry expects.",
    hint: "Use a verifier built for this registry version, or omit --verifier.",
  },
  [KeeperErrorCode.BatchTooLarge]: {
    message: "The batch has more entries than the registry allows in one call.",
    hint: "Split the batch into smaller groups and submit each one.",
  },
  [KeeperErrorCode.EmptyBatch]: {
    message: "The batch is empty.",
    hint: "Add at least one entry, or skip the call.",
  },
  [KeeperErrorCode.BatchRewardCeilingExceeded]: {
    message: "The batch's total reward is above the per-batch ceiling.",
    hint: "Reduce the rewards in the batch, or split it into smaller batches.",
  },
  [KeeperErrorCode.VerificationFailed]: {
    message: "The verifier rejected the keeper's proof.",
    hint: "Regenerate the proof from the task's inputs, then submit it again.",
  },
  [KeeperErrorCode.InsufficientStake]: {
    message: "The keeper's stake is smaller than the amount requested.",
    hint: "Request an amount at or below the current stake. 'skn keeper balance' shows it.",
  },
  [KeeperErrorCode.UnbondNotReady]: {
    message: "The unbonding period has not finished yet.",
    hint: "Wait until the unlock ledger, then withdraw the stake.",
  },
  [KeeperErrorCode.UnbondAlreadyPending]: {
    message: "An unbond request is already pending for this keeper.",
    hint: "Withdraw the pending request before starting another.",
  },
  [KeeperErrorCode.NoPendingUnbond]: {
    message: "There is no unbond request to withdraw.",
    hint: "Start an unbond request first, then withdraw after the unlock ledger.",
  },
  [KeeperErrorCode.MinStakeNotMet]: {
    message: "The keeper's stake is below the registry's minimum.",
    hint: "Deposit more stake before claiming tasks.",
  },
  [KeeperErrorCode.SlashNotFound]: {
    message: "No slash record exists with that ID.",
    hint: "Check the slash ID in the registry's slash history.",
  },
  [KeeperErrorCode.AppealWindowClosed]: {
    message: "The appeal window for this slash has closed.",
    hint: "Appeals must be raised within the dispute window after the slash.",
  },
  [KeeperErrorCode.AppealAlreadyRaised]: {
    message: "An appeal has already been raised for this slash.",
    hint: "Wait for the existing appeal to be resolved.",
  },
  [KeeperErrorCode.NotSlashedKeeper]: {
    message: "Only the slashed keeper can appeal this slash.",
    hint: "Sign with the keeper account that was slashed.",
  },
  [KeeperErrorCode.NoPendingCredit]: {
    message: "There is no pending credit for this task and keeper.",
    hint: "Check the task's execution status with 'skn task show <id>'.",
  },
  [KeeperErrorCode.ExecutionAlreadyDisputed]: {
    message: "This execution has already been disputed.",
    hint: "Wait for the dispute to be resolved.",
  },
  [KeeperErrorCode.DisputeWindowClosed]: {
    message: "The dispute window for this execution has closed.",
    hint: "Disputes must be raised before the credit's unlock ledger.",
  },
  [KeeperErrorCode.NoDisputedCredit]: {
    message: "There is no disputed credit to resolve for this task.",
    hint: "Check the dispute ID and task ID, and confirm a dispute was raised.",
  },
  [KeeperErrorCode.ReputationBelowFloor]: {
    message: "The keeper's reputation is below the registry's floor.",
    hint: "Improve the keeper's track record, or ask the admin about the floor.",
  },
  [KeeperErrorCode.InvalidReputationFloor]: {
    message: "The reputation floor is above the highest value a keeper can reach.",
    hint: "Set a floor within the allowed range.",
  },
};

/**
 * Returns the explanation for a contract error code. An unknown code (a newer
 * deployment) still gets a useful line rather than a bare number.
 */
export function explainContractError(code: number): ContractErrorHelp {
  const name = KeeperErrorCode[code] as string | undefined;
  const help = HELP[code as KeeperErrorCode];
  if (name === undefined || help === undefined) {
    return {
      name: `UnknownContractError(${code})`,
      message: `The contract returned error code ${code}, which this CLI does not recognize.`,
      hint: "Check that this CLI version supports the deployed contract: 'skn --version' lists the supported range.",
    };
  }
  return { name, ...help };
}
