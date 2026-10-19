import type { Command } from "commander";

import type { CommandContext } from "../../context.js";
import { registerClaimCommand } from "./claim.js";
import { registerExecuteCommand } from "./execute.js";

export function registerTaskCommands(program: Command, ctx: CommandContext): void {
  const task = program.command("task").description("register, inspect, claim and execute tasks");
  registerClaimCommand(task, ctx);
  registerExecuteCommand(task, ctx);
}
