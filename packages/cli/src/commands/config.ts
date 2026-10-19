import { defaultConfig, writeConfig } from "../config.js";
import { resolveKey } from "../keys.js";
import { ok, jsonResult, usage, type RunResult } from "../output.js";
import { resolveSettings } from "../settings.js";
import { loadConfig, parseCommandArgs, type CommandContext } from "../args.js";

/** `skn config init [--force]`: writes a config with testnet, futurenet and mainnet profiles. */
export async function runConfigInit(args: readonly string[], context: CommandContext): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, { force: { type: "boolean" } });
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn config init' takes no arguments; got '${positionals[0]}'`, json);
  }

  const config = defaultConfig();
  await writeConfig(context.configFile, config, values.force === true);

  if (json) {
    return jsonResult({
      path: context.configFile,
      defaultProfile: config.defaultProfile,
      profiles: Object.keys(config.profiles),
    });
  }
  return ok(
    `wrote ${context.configFile}\nprofiles: ${Object.keys(config.profiles).join(", ")}\n`,
  );
}

/**
 * `skn config show`: prints the effective settings after flags, profile and
 * defaults are applied. It shows where the signing key comes from, never the
 * key itself.
 */
export async function runConfigShow(args: readonly string[], context: CommandContext): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn config show' takes no arguments; got '${positionals[0]}'`, json);
  }

  const config = await loadConfig(context);
  const settings = resolveSettings(
    {
      network: values.network as string | undefined,
      rpcUrl: values["rpc-url"] as string | undefined,
      contractId: values["contract-id"] as string | undefined,
      profile: values.profile as string | undefined,
      confirmMainnet: values["confirm-mainnet"] === true,
    },
    config,
  );
  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    { env: context.env, homeDir: context.homeDir, platform: context.platform },
  );

  const view = {
    configFile: context.configFile,
    configFound: config !== undefined,
    profile: settings.profile ?? null,
    network: settings.network,
    rpcUrl: settings.rpcUrl,
    networkPassphrase: settings.networkPassphrase,
    contractId: settings.contractId ?? null,
    confirmMainnet: settings.confirmMainnet,
    // The key's source and origin only. The secret is never part of this view.
    key: key === undefined ? null : { source: key.source, origin: key.origin },
  };

  if (json) {
    return jsonResult(view);
  }
  const lines = [
    `config file:       ${view.configFile}${view.configFound ? "" : " (not found; using defaults)"}`,
    `profile:           ${view.profile ?? "(none)"}`,
    `network:           ${view.network}`,
    `rpc url:           ${view.rpcUrl}`,
    `contract id:       ${view.contractId ?? "(unset)"}`,
    `confirm mainnet:   ${view.confirmMainnet}`,
    `signing key:       ${key === undefined ? "none" : `${key.source} (${key.origin})`}`,
  ];
  return ok(`${lines.join("\n")}\n`);
}
