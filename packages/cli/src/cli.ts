import { parseArgs } from "node:util";
import {
  KeeperContractError,
  KeeperRegistryClient,
  KeeperRpcError,
  NETWORK_NAMES,
  NETWORK_PRESETS,
  SUPPORTED_CONTRACT_VERSIONS,
  checkContractCompatibility,
  isNetworkName,
  type ContractCompatibility,
  type RpcServerLike,
} from "@soroban-keeper-network/sdk";
import { EXIT, type ExitCode } from "./exitCodes.js";
import { CLI_VERSION } from "./version.js";

export interface RunOptions {
  /**
   * RPC server to use instead of connecting to `--rpc-url`. Tests inject the
   * SDK's fake RPC through this seam; the bin never sets it.
   */
  server?: RpcServerLike | undefined;
}

export interface RunResult {
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
}

/** Command groups from `docs/CLI_DESIGN.md`. Each one appears in help, implemented or not. */
export const COMMAND_GROUPS = [
  "config",
  "task",
  "keeper",
  "admin",
  "batch",
  "deploy",
  "events",
  "inspect",
] as const;

export const HELP_TEXT = `skn ${CLI_VERSION}: command-line tool for the Soroban Keeper Network

Usage:
  skn <group> <command> [flags]
  skn --help | --version

Command groups:
  config    manage the config file and named profiles (not implemented yet)
  task      register, show, list, claim and execute tasks (not implemented yet)
  keeper    keeper balance and withdrawal (not implemented yet)
  admin     admin controls (not implemented yet)
  batch     batch task registration (not implemented yet)
  deploy    deploy the registry and treasury contracts (not implemented yet)
  events    watch contract events (not implemented yet)
  inspect   read-only views of the deployed contract
            version   print the contract's VERSION and whether this CLI supports it

Global flags (accepted by every command):
  --network <testnet|futurenet|mainnet>  network preset (default: testnet)
  --rpc-url <url>                        override the preset's RPC URL
  --contract-id <id>                     keeper-registry contract ID (required)
  --json                                 print machine-readable JSON

Exit codes:
  0 success     1 internal error   2 usage error
  3 RPC error   4 contract error   5 not found
`;

function versionText(): string {
  const { min, max } = SUPPORTED_CONTRACT_VERSIONS;
  return `skn ${CLI_VERSION}\nsupported contract VERSION: ${min} to ${max}\n`;
}

function ok(stdout: string): RunResult {
  return { exitCode: EXIT.ok, stdout, stderr: "" };
}

/**
 * Failure output. With `--json` the error goes to stdout as a JSON object so a
 * script can parse it; otherwise it goes to stderr as one line plus a hint.
 */
function fail(
  exitCode: ExitCode,
  code: string,
  message: string,
  json: boolean,
): RunResult {
  if (json) {
    const body = { error: { code, message } };
    return { exitCode, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: "" };
  }
  return {
    exitCode,
    stdout: "",
    stderr: `skn: ${message}\nRun 'skn --help' for usage.\n`,
  };
}

function usage(message: string, json: boolean): RunResult {
  return fail(EXIT.usage, "USAGE_ERROR", message, json);
}

function isCommandGroup(value: string): value is (typeof COMMAND_GROUPS)[number] {
  return (COMMAND_GROUPS as readonly string[]).includes(value);
}

/**
 * Runs `skn` with the given arguments (without the node and script path) and
 * returns what it would print and the exit code. Never throws and never calls
 * `process.exit`, so the bin and the tests share one code path.
 */
export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const json = argv.includes("--json");
  const [first, second] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return ok(HELP_TEXT);
  }
  if (first === "--version" || first === "-v") {
    return ok(versionText());
  }
  if (!isCommandGroup(first)) {
    return usage(`unknown command '${first}'`, json);
  }
  if (first === "inspect" && second === "version") {
    return inspectVersion(argv.slice(2), options);
  }
  if (second === undefined || second.startsWith("-")) {
    return usage(`'skn ${first}' needs a command`, json);
  }
  return usage(`'skn ${first} ${second}' is not implemented yet`, json);
}

async function inspectVersion(
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const json = args.includes("--json");

  let values: {
    network?: string | undefined;
    "rpc-url"?: string | undefined;
    "contract-id"?: string | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        network: { type: "string" },
        "rpc-url": { type: "string" },
        "contract-id": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return usage(errorMessage(err), json);
  }

  const network = values.network ?? "testnet";
  if (!isNetworkName(network)) {
    return usage(
      `unknown network '${network}'; expected one of ${NETWORK_NAMES.join(", ")}`,
      json,
    );
  }
  const contractId = values["contract-id"];
  if (!contractId) {
    return usage("--contract-id is required", json);
  }

  const preset = NETWORK_PRESETS[network];
  const warnings: string[] = [];
  let client: KeeperRegistryClient;
  try {
    client = new KeeperRegistryClient({
      contractId,
      networkPassphrase: preset.networkPassphrase,
      ...(options.server
        ? { server: options.server }
        : { rpcUrl: values["rpc-url"] ?? preset.rpcUrl }),
      warn: (message) => warnings.push(message),
    });
  } catch (err) {
    return usage(errorMessage(err), json);
  }

  try {
    const compatibility = await checkContractCompatibility(client);
    const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
    if (compatibility.warning) {
      return {
        ...printVersion(contractId, network, compatibility, json),
        stderr: `${stderr}skn: warning: ${compatibility.warning}\n`,
      };
    }
    return { ...printVersion(contractId, network, compatibility, json), stderr };
  } catch (err) {
    return commandError(err, json);
  }
}

function printVersion(
  contractId: string,
  network: string,
  compatibility: ContractCompatibility,
  json: boolean,
): RunResult {
  const { min, max } = compatibility.supported;
  const compatible = compatibility.status === "compatible";
  if (json) {
    const body = {
      contractId,
      network,
      contractVersion: compatibility.contractVersion,
      compatible,
      status: compatibility.status,
      supportedVersions: { min, max },
    };
    return ok(`${JSON.stringify(body, null, 2)}\n`);
  }
  const support = compatible
    ? "supported by this CLI"
    : `outside this CLI's supported range ${min} to ${max}`;
  return ok(
    `contract ${contractId} on ${network}\nVERSION ${compatibility.contractVersion} (${support})\n`,
  );
}

/** Maps an SDK failure to an exit code. RPC and contract errors keep their own codes. */
function commandError(err: unknown, json: boolean): RunResult {
  if (err instanceof KeeperRpcError) {
    return fail(EXIT.rpc, "RPC_ERROR", err.message, json);
  }
  if (err instanceof KeeperContractError) {
    return fail(EXIT.contract, "CONTRACT_ERROR", err.message, json);
  }
  return fail(EXIT.internal, "INTERNAL_ERROR", errorMessage(err), json);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
