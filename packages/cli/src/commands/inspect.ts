import {
  KeeperRegistryClient,
  checkContractCompatibility,
  type ContractCompatibility,
} from "@soroban-keeper-network/sdk";
import { parseCommandArgs, loadConfig, type CommandContext } from "../args.js";
import { jsonResult, ok, usage, type RunResult } from "../output.js";
import { SettingsError, resolveSettings } from "../settings.js";

/** `skn inspect version`: the deployed contract's VERSION, and whether this CLI supports it. */
export async function runInspectVersion(args: readonly string[], context: CommandContext): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn inspect version' takes no arguments; got '${positionals[0]}'`, json);
  }

  const config = await loadConfig(context);
  const settings = resolveSettings(
    {
      network: values.network as string | undefined,
      rpcUrl: values["rpc-url"] as string | undefined,
      contractId: values["contract-id"] as string | undefined,
      profile: values.profile as string | undefined,
    },
    config,
  );
  if (settings.contractId === undefined) {
    return usage("--contract-id is required (or set contractId in the selected profile)", json);
  }

  const warnings: string[] = [];
  let client: KeeperRegistryClient;
  try {
    client = new KeeperRegistryClient({
      contractId: settings.contractId,
      networkPassphrase: settings.networkPassphrase,
      ...(context.server
        ? { server: context.server }
        : { rpcUrl: settings.rpcUrl }),
      warn: (message) => warnings.push(message),
    });
  } catch (err) {
    throw new SettingsError(`invalid contract ID: ${err instanceof Error ? err.message : String(err)}`);
  }

  const compatibility = await checkContractCompatibility(client);
  const result = printVersion(settings.contractId, settings.network, compatibility, json);
  const stderr = [...warnings, ...(compatibility.warning ? [compatibility.warning] : [])]
    .map((line) => `skn: warning: ${line}\n`)
    .join("");
  return { ...result, stderr };
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
    return jsonResult({
      contractId,
      network,
      contractVersion: compatibility.contractVersion,
      compatible,
      status: compatibility.status,
      supportedVersions: { min, max },
    });
  }
  const support = compatible
    ? "supported by this CLI"
    : `outside this CLI's supported range ${min} to ${max}`;
  return ok(
    `contract ${contractId} on ${network}\nVERSION ${compatibility.contractVersion} (${support})\n`,
  );
}
