import type { Command } from "commander";

import { CliError, ExitCode } from "../../cliError.js";
import type { CommandContext } from "../../context.js";
import { writeResult, type CommandOutput } from "../../output.js";
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
      const options = command.optsWithGlobals<GlobalOptions>();
      await claim(ctx, options, parseTaskId(taskIdArg));
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

  // The claim is already on-chain, so a failure to read it back must not
  // turn into a failing exit code that suggests the claim did not happen.
  let lock: LockExpiry | undefined;
  let readFailed = false;
  try {
    lock = await readLockExpiry(client, ledgers, taskId);
  } catch (error) {
    readFailed = true;
    ctx.err(`warning: could not read the lock expiry: ${(error as Error).message}`);
  }

  const lines = [`Claimed task ${taskId} as ${key.publicKey}.`];
  if (!readFailed) lines.push(describeLock(lock));
  lines.push(`Execute before the lock expires: skn task execute ${taskId} --proof <hex>`);

  const output: CommandOutput = {
    lines,
    data: {
      taskId,
      keeper: key.publicKey,
      status: "claimed",
      lockExpiresAtLedger: lock?.expiresAtLedger ?? null,
      currentLedger: lock?.currentLedger ?? null,
      ledgersRemaining: lock?.ledgersRemaining ?? null,
    },
  };
  writeResult(ctx, options.json === true, output);
}

interface LockExpiry {
  expiresAtLedger: number;
  currentLedger: number;
  ledgersRemaining: number;
}

/**
 * The contract releases the lock once the ledger sequence reaches
 * claim_ledger + lock_ledgers (`lock_expired` in internal.rs). Undefined when
 * the task reports no claim ledger.
 */
async function readLockExpiry(
  client: SigningSession["client"],
  ledgers: SigningSession["ledgers"],
  taskId: bigint,
): Promise<LockExpiry | undefined> {
  const claimed = await client.getTask(taskId);
  if (claimed.claimLedger === undefined) return undefined;
  const expiresAtLedger = claimed.claimLedger + claimed.lockLedgers;
  const { sequence } = await ledgers.getLatestLedger();
  return { expiresAtLedger, currentLedger: sequence, ledgersRemaining: expiresAtLedger - sequence };
}

function describeLock(lock: LockExpiry | undefined): string {
  if (lock === undefined) return "Lock expiry unknown: the task reports no claim ledger.";
  return (
    `Lock expires at ledger ${lock.expiresAtLedger} (${lock.ledgersRemaining} ledgers from ledger ` +
    `${lock.currentLedger}, ${describeLedgers(lock.ledgersRemaining)}).`
  );
}
