import type { Command } from "commander";

import { CliError, ExitCode } from "../../cliError.js";
import type { CommandContext } from "../../context.js";
import {
  describeLedgers,
  openSigningSession,
  parseTaskId,
  type GlobalOptions,
  type SigningSession,
} from "../../session.js";

export function registerClaimCommand(task: Command, ctx: CommandContext): void {
  task
    .command("claim")
    .description("claim a task as the signing key's account and report when the lock expires")
    .argument("<task-id>", "ID of the task to claim")
    .action(async (taskIdArg: string, _options: unknown, command: Command) => {
      await claim(ctx, command.optsWithGlobals<GlobalOptions>(), parseTaskId(taskIdArg));
    });
}

async function claim(ctx: CommandContext, options: GlobalOptions, taskId: bigint): Promise<void> {
  const { client, key, ledgers } = await openSigningSession(ctx, options);

  const outcome = await client.claimTask({ keeper: key.publicKey, taskId });

  if (outcome.status === "lock_period_active") {
    throw new CliError(
      `Task ${taskId} is locked by another keeper's claim. Nothing was submitted; ` +
        `try again once that lock expires.`,
      ExitCode.Contract,
    );
  }
  if (outcome.status === "deadline_passed") {
    throw new CliError(
      `Task ${taskId}'s deadline has passed, so it can no longer be claimed. Nothing was submitted.`,
      ExitCode.Contract,
    );
  }

  ctx.out(`Claimed task ${taskId} as ${key.publicKey}.`);

  // The claim is already on-chain, so a failure to read it back must not
  // turn into a failing exit code that suggests the claim did not happen.
  try {
    ctx.out(await describeLockExpiry(client, ledgers, taskId));
  } catch (error) {
    ctx.err(`warning: could not read the lock expiry: ${(error as Error).message}`);
  }
  ctx.out(`Execute before the lock expires: skn task execute ${taskId} --proof <hex>`);
}

/**
 * The contract releases the lock once the ledger sequence reaches
 * claim_ledger + lock_ledgers (`lock_expired` in internal.rs).
 */
async function describeLockExpiry(
  client: SigningSession["client"],
  ledgers: SigningSession["ledgers"],
  taskId: bigint,
): Promise<string> {
  const claimed = await client.getTask(taskId);
  if (claimed.claimLedger === undefined) return "Lock expiry unknown: the task reports no claim ledger.";
  const expiresAt = claimed.claimLedger + claimed.lockLedgers;
  const { sequence } = await ledgers.getLatestLedger();
  return (
    `Lock expires at ledger ${expiresAt} (${expiresAt - sequence} ledgers from ledger ${sequence}, ` +
    `${describeLedgers(expiresAt - sequence)}).`
  );
}
