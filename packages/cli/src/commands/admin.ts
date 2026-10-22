import type { Command } from "commander";
import {
  admin as readAdmin,
  getFeeBps,
  isPaused,
  minReward as readMinReward,
  pause,
  rewardTokenAddress,
  setFeeBps,
  setMinReward,
  unpause,
} from "@soroban-keeper-network/sdk";

import { usageError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import {
  openSession,
  previewingCaller,
  type GlobalOptions,
  type Session,
} from "../session.js";

interface WriteFlags {
  yes?: boolean;
}

function parseBps(input: string): number {
  if (!/^\d+$/.test(input.trim())) {
    throw usageError(`<bps> must be a whole number between 0 and 10000, got "${input}".`);
  }
  return Number(input.trim());
}

function parseAmount(input: string): bigint {
  if (!/^\d+$/.test(input.trim())) {
    throw usageError(`<amount> must be a non-negative whole number, got "${input}".`);
  }
  return BigInt(input.trim());
}

/** The signing key's address: the registry's admin must authorize every admin write. */
function adminAddress(session: Session): string {
  return (session.key as NonNullable<Session["key"]>).publicKey;
}

/**
 * Registers `skn admin`: one read (`show`) and the four single-signature
 * controls. The two-signature controls (`transfer-admin`, `sweep-fees`,
 * `upgrade`) are intentionally absent; they need a second signer and belong
 * to a later change.
 */
export function registerAdmin(program: Command, rt: Runtime): void {
  const group = program
    .command("admin")
    .description("Administer the registry (requires the admin's key for writes)");

  group
    .command("show")
    .description("Show the registry's admin, pause state, fee and reward floor")
    .action(async (_flags: object, cmd: Command) => {
      const g = cmd.optsWithGlobals() as GlobalOptions;
      const session = openSession(rt, g, { needsKey: false });

      const adminAddr = (await readAdmin(session.client)) ?? null;
      const paused = await isPaused(session.client);
      const feeBps = await getFeeBps(session.client);
      const floor = await readMinReward(session.client);
      const token = (await rewardTokenAddress(session.client)) ?? null;

      session.out.result(
        {
          admin: adminAddr,
          paused,
          feeBps,
          minReward: floor,
          rewardToken: token,
          network: session.conn.network,
          contractId: session.conn.contractId,
        },
        [
          `admin:        ${adminAddr ?? "(not initialized)"}`,
          `paused:       ${paused}`,
          `fee:          ${feeBps} bps`,
          `min reward:   ${floor}`,
          `reward token: ${token ?? "(none)"}`,
        ].join("\n"),
      );
    });

  const write = (
    name: string,
    description: string,
    run: (
      session: Session,
      caller: ReturnType<typeof previewingCaller>["caller"],
      args: string[],
    ) => Promise<{ data: Record<string, unknown>; human: string }>,
    argSpec?: string,
  ): void => {
    const command = argSpec ? group.command(`${name} ${argSpec}`) : group.command(name);
    command
      .description(description)
      .option("--yes", "skip the confirmation prompt")
      .action(async (...received: unknown[]) => {
        const cmd = received[received.length - 1] as Command;
        const args = received.slice(0, command.registeredArguments.length) as string[];
        const all = cmd.optsWithGlobals() as WriteFlags & GlobalOptions;

        const session = openSession(rt, all, { needsKey: true });
        const { caller, feeStroops } = previewingCaller(rt, session, { yes: all.yes });
        const { data, human } = await run(session, caller, args);
        session.out.result(
          {
            ...data,
            admin: adminAddress(session),
            feeStroops: feeStroops() ?? null,
            network: session.conn.network,
            contractId: session.conn.contractId,
          },
          human,
        );
      });
  };

  write("pause", "Pause the registry: blocks register, claim and execute", async (session, caller) => {
    await pause(caller, { admin: adminAddress(session) });
    return { data: { action: "pause", paused: true }, human: "Registry paused" };
  });

  write("unpause", "Lift a pause", async (session, caller) => {
    await unpause(caller, { admin: adminAddress(session) });
    return { data: { action: "unpause", paused: false }, human: "Registry unpaused" };
  });

  write(
    "set-fee-bps",
    "Set the protocol fee in basis points (0-10000)",
    async (session, caller, [bps]) => {
      const newBps = parseBps(bps as string);
      await setFeeBps(caller, { admin: adminAddress(session), newBps });
      return { data: { action: "set-fee-bps", feeBps: newBps }, human: `Fee set to ${newBps} bps` };
    },
    "<bps>",
  );

  write(
    "set-min-reward",
    "Set the smallest reward a task may be registered with",
    async (session, caller, [amount]) => {
      const minReward = parseAmount(amount as string);
      await setMinReward(caller, { admin: adminAddress(session), minReward });
      return {
        data: { action: "set-min-reward", minReward },
        human: `Minimum reward set to ${minReward}`,
      };
    },
    "<amount>",
  );
}
