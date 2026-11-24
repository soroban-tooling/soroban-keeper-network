/**
 * The single source of truth for `skn --help` and the generated command
 * reference in `docs/CLI.md`.
 *
 * Command implementations validate their own flags with `node:util`.parseArgs;
 * this catalogue describes those flags for humans. A test checks that every
 * catalogue path still answers `--help`, and the docs generator renders each
 * page by calling `run([...path, "--help"])`, so help and docs cannot drift
 * apart unnoticed.
 */

import { CLI_VERSION } from "./version.js";

export interface FlagHelp {
  /** Syntax as typed on the command line, for example `--network <name>`. */
  flag: string;
  description: string;
}

export interface CommandHelp {
  /** Path after `skn`; the empty path is the top-level help page. */
  path: readonly string[];
  /** One-line description, also used in the group list on the root page. */
  summary: string;
  /** Command line, without the global flags (those are listed separately). */
  usage: string;
  /** Flags specific to this command. */
  flags: readonly FlagHelp[];
  /** Extra guidance shown after the flags. */
  notes: readonly string[];
}

/** Groups in the order shown on the root help page. */
export const HELP_GROUPS: readonly { name: string; summary: string }[] = [
  { name: "config", summary: "init | show: manage the config file and named profiles" },
  { name: "task", summary: "register | cancel | expire | increase-reward | extend-deadline (show, list, claim, execute: not yet)" },
  { name: "keeper", summary: "balance | withdraw | stake | unbond | withdraw-stake | unbonding" },
  { name: "admin", summary: "pause | unpause | set-fee-bps | set-min-reward | set-min-stake | set-dispute-window | sweep-fees" },
  { name: "batch", summary: "register: batch task registration from JSON or CSV" },
  { name: "deploy", summary: "registry | treasury | all: upload WASM, deploy and initialize contracts" },
  { name: "events", summary: "watch contract events (not implemented yet)" },
  { name: "inspect", summary: "[summary | version]: print protocol state and SDK compatibility" },
];

/** Flags accepted by every command, from `GLOBAL_OPTIONS` in `args.ts`. */
export const GLOBAL_FLAG_HELP: readonly FlagHelp[] = [
  { flag: "--profile <name>", description: "named profile from the config file" },
  { flag: "--network <name>", description: "testnet, futurenet or mainnet (default: profile's, else testnet)" },
  { flag: "--rpc-url <url>", description: "override the preset's RPC URL" },
  { flag: "--contract-id <id>", description: "keeper-registry contract ID" },
  { flag: "--treasury-contract-id <id>", description: "treasury contract ID" },
  { flag: "--key-file <path>", description: "read the signing key from a file (must not be readable by others)" },
  { flag: "--identity <name>", description: "read the signing key from a Stellar CLI identity" },
  { flag: "--confirm-mainnet", description: "required to send a transaction on mainnet" },
  { flag: "--json", description: "print machine-readable JSON" },
];

const YES: FlagHelp = { flag: "--yes", description: "approve the change without an interactive prompt" };
const KEEPER: FlagHelp = { flag: "--keeper <address>", description: "address to inspect (default: the signing key's)" };

export const COMMAND_HELP: readonly CommandHelp[] = [
  {
    path: [],
    summary: "Command-line tool for the Soroban Keeper Network",
    usage: "skn <group> [command] [flags]",
    flags: [],
    notes: [],
  },
  {
    path: ["config"],
    summary: "Manage the config file and named profiles",
    usage: "skn config <init|show> [flags]",
    flags: [],
    notes: ["Config file: SKN_CONFIG, or ~/.config/skn/skn.config.json."],
  },
  {
    path: ["config", "init"],
    summary: "Write a default config file",
    usage: "skn config init [--force]",
    flags: [{ flag: "--force", description: "overwrite an existing config file" }],
    notes: ["Creates testnet, futurenet and mainnet profiles. No secrets are stored."],
  },
  {
    path: ["config", "show"],
    summary: "Print the effective configuration",
    usage: "skn config show",
    flags: [],
    notes: ["Shows the key's source and origin only, never the secret."],
  },
  {
    path: ["task"],
    summary: "Manage a task as its owner",
    usage: "skn task <register|cancel|expire|increase-reward|extend-deadline> [flags]",
    flags: [],
    notes: ["show, list, claim and execute are planned but not implemented yet."],
  },
  {
    path: ["task", "register"],
    summary: "Register a task and escrow its reward",
    usage: "skn task register --type <name> --reward <stroops> --deadline <time> --ttl-ledgers <n> --lock-ledgers <n> [--calldata <hex>] [--verifier <address>]",
    flags: [
      { flag: "--type <name>", description: "task type name or numeric discriminant (required)" },
      { flag: "--reward <stroops>", description: "reward paid to the keeper (required)" },
      { flag: "--deadline <time>", description: "Unix seconds or an ISO 8601 time such as 2030-01-01T00:00:00Z (required)" },
      { flag: "--ttl-ledgers <n>", description: "task time to live in ledgers (required)" },
      { flag: "--lock-ledgers <n>", description: "claim lock duration in ledgers (required)" },
      { flag: "--calldata <hex>", description: "opaque bytes handed to the keeper's executor" },
      { flag: "--verifier <address>", description: "optional verifier contract address" },
    ],
    notes: ["The signing key is the task owner. The command prints the task's state as read back from the registry."],
  },
  {
    path: ["task", "cancel"],
    summary: "Cancel a task and refund its reward",
    usage: "skn task cancel <task-id>",
    flags: [],
    notes: ["A live claim lock prevents cancellation; the refusal names the keeper and the unlock ledger."],
  },
  {
    path: ["task", "expire"],
    summary: "Expire a task whose deadline has passed",
    usage: "skn task expire <task-id>",
    flags: [],
    notes: ["Any account may do this; the signing key only pays the fee."],
  },
  {
    path: ["task", "increase-reward"],
    summary: "Escrow more reward for a task",
    usage: "skn task increase-reward <task-id> --by <amount>",
    flags: [{ flag: "--by <stroops>", description: "additional reward (required)" }],
    notes: [],
  },
  {
    path: ["task", "extend-deadline"],
    summary: "Move a task's deadline later",
    usage: "skn task extend-deadline <task-id> --to <time>",
    flags: [{ flag: "--to <time>", description: "new deadline (required)" }],
    notes: [],
  },
  {
    path: ["keeper"],
    summary: "Inspect a keeper's balance, stake and rewards",
    usage: "skn keeper <balance|withdraw|stake|unbond|withdraw-stake|unbonding> [flags]",
    flags: [],
    notes: [],
  },
  {
    path: ["keeper", "balance"],
    summary: "Print reward balance, stake, unbonding and reputation",
    usage: "skn keeper balance [--keeper <address>]",
    flags: [KEEPER],
    notes: [],
  },
  {
    path: ["keeper", "withdraw"],
    summary: "Withdraw the signing keeper's accrued rewards",
    usage: "skn keeper withdraw",
    flags: [],
    notes: ["A zero balance sends no transaction."],
  },
  {
    path: ["keeper", "stake"],
    summary: "Deposit keeper collateral",
    usage: "skn keeper stake <amount>",
    flags: [],
    notes: [],
  },
  {
    path: ["keeper", "unbond"],
    summary: "Start the unbonding delay",
    usage: "skn keeper unbond <amount>",
    flags: [],
    notes: ["Only one unbond request can be pending at a time."],
  },
  {
    path: ["keeper", "withdraw-stake"],
    summary: "Release unbonded stake",
    usage: "skn keeper withdraw-stake",
    flags: [],
    notes: ["Before the unlock ledger the command reports the remaining wait and sends nothing."],
  },
  {
    path: ["keeper", "unbonding"],
    summary: "Show the pending unbond request",
    usage: "skn keeper unbonding [--keeper <address>]",
    flags: [KEEPER],
    notes: [],
  },
  {
    path: ["admin"],
    summary: "Run privileged registry operations",
    usage: "skn admin <pause|unpause|set-fee-bps|set-min-reward|set-min-stake|set-dispute-window|sweep-fees> [flags]",
    flags: [],
    notes: [
      "Every admin command verifies that the signing key is the contract's current admin before submitting.",
      "The current and new values are shown before a change is sent.",
    ],
  },
  {
    path: ["admin", "pause"],
    summary: "Pause the registry",
    usage: "skn admin pause [--yes]",
    flags: [YES],
    notes: [],
  },
  {
    path: ["admin", "unpause"],
    summary: "Resume the registry",
    usage: "skn admin unpause [--yes]",
    flags: [YES],
    notes: [],
  },
  {
    path: ["admin", "set-fee-bps"],
    summary: "Set the protocol fee in basis points",
    usage: "skn admin set-fee-bps <bps> [--yes]",
    flags: [YES, { flag: "--fee-bps <bps>", description: "value as a flag; --bps is an alias" }],
    notes: ["The value must be an integer from 0 to 10000."],
  },
  {
    path: ["admin", "set-min-reward"],
    summary: "Set the smallest reward a task may carry",
    usage: "skn admin set-min-reward <amount> [--yes]",
    flags: [YES, { flag: "--min-reward <stroops>", description: "value as a flag; --amount is an alias" }],
    notes: [],
  },
  {
    path: ["admin", "set-min-stake"],
    summary: "Set the minimum keeper stake",
    usage: "skn admin set-min-stake <amount> [--yes]",
    flags: [YES, { flag: "--min-stake <stroops>", description: "value as a flag; --amount is an alias" }],
    notes: [],
  },
  {
    path: ["admin", "set-dispute-window"],
    summary: "Set the dispute window in ledgers",
    usage: "skn admin set-dispute-window <ledgers> [--yes]",
    flags: [YES, { flag: "--ledgers <n>", description: "value as a flag; --dispute-window is an alias" }],
    notes: [],
  },
  {
    path: ["admin", "sweep-fees"],
    summary: "Sweep accrued fees to a treasury",
    usage: "skn admin sweep-fees [<treasury>] [<amount>] [--yes]",
    flags: [
      YES,
      { flag: "--treasury <address>", description: "destination; --to is an alias" },
      { flag: "--amount <stroops>", description: "amount to sweep" },
    ],
    notes: ["With no treasury argument the treasury from the selected profile is used."],
  },
  {
    path: ["batch"],
    summary: "Batch task registration",
    usage: "skn batch register <tasks.json|tasks.csv> [flags]",
    flags: [],
    notes: [],
  },
  {
    path: ["batch", "register"],
    summary: "Register tasks from a JSON or CSV file",
    usage: "skn batch register <file> [--dry-run]",
    flags: [
      { flag: "--dry-run", description: "validate and preview without submitting" },
      { flag: "--file <path>", description: "task file as a flag instead of a positional argument" },
      { flag: "--from <path>", description: "alias for --file, kept for compatibility" },
      { flag: "--buffer-bps <n>", description: "safety margin added to the reward budget (0 to 10000)" },
    ],
    notes: ["The file is validated locally, then registrations are chunked by the contract's max_batch_size."],
  },
  {
    path: ["deploy"],
    summary: "Upload, deploy and initialize the contracts",
    usage: "skn deploy [registry|treasury|all] [flags]",
    flags: [
      { flag: "--wasm <path>", description: "WASM path used for both contracts" },
      { flag: "--registry-wasm <path>", description: "registry WASM path" },
      { flag: "--treasury-wasm <path>", description: "treasury WASM path" },
      { flag: "--admin <address>", description: "initial registry admin" },
      { flag: "--reward-token <address>", description: "reward token contract ID" },
      { flag: "--fee-bps <n>", description: "initial protocol fee" },
      YES,
    ],
    notes: ["Every parameter is shown before submission. Mainnet also needs --confirm-mainnet."],
  },
  {
    path: ["events"],
    summary: "Watch contract events (not implemented yet)",
    usage: "skn events watch",
    flags: [],
    notes: ["This group is reserved; no events command is implemented on this revision."],
  },
  {
    path: ["inspect"],
    summary: "Print protocol state and SDK compatibility",
    usage: "skn inspect [summary|version] [flags]",
    flags: [],
    notes: ["Read-only: every value comes from a simulated contract view."],
  },
  {
    path: ["inspect", "summary"],
    summary: "Print the registry summary",
    usage: "skn inspect summary",
    flags: [],
    notes: [],
  },
  {
    path: ["inspect", "version"],
    summary: "Check SDK and contract VERSION compatibility",
    usage: "skn inspect version",
    flags: [],
    notes: [],
  },
];

/** Every help page path, used by the docs generator and the drift test. */
export const HELP_PATHS: readonly (readonly string[])[] = COMMAND_HELP.map((entry) => entry.path);

const BY_PATH = new Map(COMMAND_HELP.map((entry) => [entry.path.join(" "), entry]));

const ROOT_HELP = COMMAND_HELP[0];
if (ROOT_HELP === undefined) throw new Error("help catalogue is missing its root page");

/** Text printed by `skn --help`. */
export const HELP_TEXT = renderHelp(ROOT_HELP);

/** Returns the help page for a command path, or `undefined` when there is none. */
export function helpFor(path: readonly string[]): string | undefined {
  const entry = BY_PATH.get(path.join(" "));
  return entry === undefined ? undefined : renderHelp(entry);
}

/** Extracts a help path from argv. Returns `undefined` when no help flag is present. */
export function helpPathFromArgs(argv: readonly string[]): readonly string[] | undefined {
  if (!argv.includes("--help") && !argv.includes("-h")) return undefined;
  return argv.filter((arg) => arg !== "--help" && arg !== "-h" && arg !== "help");
}

function globalFlags(): string {
  const width = Math.max(...GLOBAL_FLAG_HELP.map((entry) => entry.flag.length));
  return GLOBAL_FLAG_HELP.map((entry) => `  ${entry.flag.padEnd(width)}  ${entry.description}`).join("\n");
}

function renderHelp(entry: CommandHelp): string {
  if (entry.path.length === 0) {
    const groups = HELP_GROUPS.map((group) => `  ${group.name.padEnd(8)} ${group.summary}`).join("\n");
    return `skn ${CLI_VERSION}: command-line tool for the Soroban Keeper Network

Usage:
  ${entry.usage}

Command groups:
${groups}

Global flags (accepted by every command):
${globalFlags()}

Signing key precedence: --key-file, then --identity, then SKN_SECRET_KEY.
Config file: SKN_CONFIG, or ~/.config/skn/skn.config.json.

Exit codes:
  0 success     1 internal error   2 usage error
  3 RPC error   4 contract error   5 not found
`;
  }

  const command = `skn${entry.path.length === 0 ? "" : ` ${entry.path.join(" ")}`}`;
  const lines = [`${command}: ${entry.summary}`, "", "Usage:", `  ${entry.usage}`];
  if (entry.flags.length > 0) {
    const width = Math.max(...entry.flags.map((flag) => flag.flag.length));
    lines.push("", "Command flags:");
    for (const flag of entry.flags) {
      lines.push(`  ${flag.flag.padEnd(width)}  ${flag.description}`);
    }
  }
  lines.push("", "Global flags (accepted by every command):", globalFlags());
  if (entry.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of entry.notes) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}
