import { readFile } from "node:fs/promises";

import { KeeperSdkError, MAX_PROOF_LEN, toProofBytes } from "@soroban-keeper-network/sdk";
import type { Command } from "commander";

import { CliError, ExitCode } from "../../cliError.js";
import type { CommandContext } from "../../context.js";
import { openSigningSession, parseTaskId, type GlobalOptions } from "../../session.js";

interface ExecuteOptions {
  proof?: string;
  proofFile?: string;
}

export function registerExecuteCommand(task: Command, ctx: CommandContext): void {
  task
    .command("execute")
    .description("submit a proof for a task you have claimed and report the reward credited")
    .argument("<task-id>", "ID of the claimed task")
    .option("--proof <hex>", "proof as hex, with or without a 0x prefix")
    .option("--proof-file <path>", "read the hex proof from a file (surrounding whitespace is ignored)")
    .action(async (taskIdArg: string, options: ExecuteOptions, command: Command) => {
      const taskId = parseTaskId(taskIdArg);
      // Validate the proof before touching keys or the network.
      const proof = await readProof(options);
      await execute(ctx, command.optsWithGlobals<GlobalOptions>(), taskId, proof);
    });
}

/** Reads and decodes the proof with the SDK's own rules (`toProofBytes`). */
async function readProof(options: ExecuteOptions): Promise<Uint8Array> {
  if ((options.proof === undefined) === (options.proofFile === undefined)) {
    throw new CliError("Pass exactly one of --proof <hex> or --proof-file <path>.");
  }

  let hex: string;
  let origin: string;
  if (options.proof !== undefined) {
    hex = options.proof;
    origin = "--proof";
  } else {
    const path = options.proofFile as string;
    origin = `proof file ${path}`;
    try {
      hex = (await readFile(path, "utf8")).trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new CliError(`Cannot read proof file ${path}: ${code === "ENOENT" ? "no such file" : code}.`);
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = toProofBytes(hex);
  } catch (error) {
    if (error instanceof KeeperSdkError) throw new CliError(`Invalid ${origin}: ${error.message}`);
    throw error;
  }
  if (bytes.length > MAX_PROOF_LEN) {
    throw new CliError(
      `Invalid ${origin}: the proof is ${bytes.length} bytes, over the contract's ` +
        `${MAX_PROOF_LEN}-byte limit.`,
    );
  }
  return bytes;
}

async function execute(
  ctx: CommandContext,
  options: GlobalOptions,
  taskId: bigint,
  proof: Uint8Array,
): Promise<void> {
  const { client, key } = await openSigningSession(ctx, options);

  // execute_task returns nothing, so the credit is computed the way the
  // contract does (`split_reward` in internal.rs) from values read just
  // before submitting. An admin fee change landing in between would make
  // this report stale; the on-chain credit is authoritative.
  const task = await client.getTask(taskId);
  const feeBps = await client.getFeeBps();
  const disputeWindow = await client.disputeWindow().catch(() => undefined);

  const outcome = await client.executeTask({ keeper: key.publicKey, taskId, proof });

  switch (outcome.status) {
    case "executed":
      break;
    case "invalid_task_status":
      throw new CliError(
        `Task ${taskId} is not in the Claimed state (it may have been executed, cancelled or ` +
          `expired, or never claimed). Nothing was submitted.`,
        ExitCode.Contract,
      );
    case "not_task_claimer":
      throw new CliError(
        `Task ${taskId} is claimed by another keeper, not ${key.publicKey}. Nothing was submitted.`,
        ExitCode.Contract,
      );
    case "deadline_passed":
      throw new CliError(
        `Task ${taskId}'s deadline has passed. Nothing was submitted.`,
        ExitCode.Contract,
      );
    case "verification_failed":
      throw new CliError(
        `The task's verifier rejected this proof. Nothing was submitted.`,
        ExitCode.Contract,
      );
  }

  const fee = (task.reward * BigInt(feeBps)) / 10_000n;
  const credited = task.reward - fee;

  ctx.out(`Executed task ${taskId} as ${key.publicKey}.`);
  ctx.out(
    `Reward credited: ${credited} (task reward ${task.reward}, protocol fee ${fee} at ${feeBps} bps).`,
  );
  if (disputeWindow === undefined) {
    ctx.out("Withdraw it with withdraw_rewards once it is available.");
  } else if (disputeWindow === 0) {
    ctx.out("It is withdrawable now with withdraw_rewards.");
  } else {
    ctx.out(
      `It is held as a pending credit for the ${disputeWindow}-ledger dispute window, ` +
        `then becomes withdrawable with withdraw_rewards.`,
    );
  }
}
