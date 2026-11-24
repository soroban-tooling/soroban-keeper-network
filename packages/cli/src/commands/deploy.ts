import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  KeeperContractError,
  KeeperErrorCode,
  KeeperRpcError,
  NETWORK_PRESETS,
  decodeKeeperErrorCode,
  keypairSigner,
  type NetworkName,
  type RpcServerLike,
  type TransactionSigner,
} from "@soroban-keeper-network/sdk";
import {
  UsageError,
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
} from "../args.js";
import { openRegistry, openTreasury } from "../client.js";
import { defaultConfig, writeConfig, type ConfigFile } from "../config.js";
import type { ConfirmFn } from "../confirm.js";
import { resolveKey } from "../keys.js";
import { jsonResult, ok, usage, type RunResult } from "../output.js";
import { redactSecrets } from "../redact.js";
import { requireMainnetConfirmation, resolveSettings } from "../settings.js";

/** Default native XLM SAC addresses per network. */
export const DEFAULT_REWARD_TOKENS: Record<NetworkName, string> = {
  testnet: Asset.native().contractId(NETWORK_PRESETS.testnet.networkPassphrase),
  futurenet: Asset.native().contractId(NETWORK_PRESETS.futurenet.networkPassphrase),
  mainnet: Asset.native().contractId(NETWORK_PRESETS.mainnet.networkPassphrase),
};

export const DEFAULT_FEE_BPS = 300;
const MAX_FEE_BPS = 10_000;

export type DeployTarget = "registry" | "treasury" | "all";

export interface DeployOptions {
  confirm?: ConfirmFn | undefined;
}

export interface DeployedContractResult {
  target: "registry" | "treasury";
  wasmPath: string;
  wasmHash: string;
  contractId: string;
}

/**
 * `skn deploy [registry|treasury|all]`:
 *
 *   1. Validates all initialization parameters (`admin`, `rewardToken`, `feeBps`)
 *      and WASM files locally before touching the network.
 *   2. Refuses mainnet without `--confirm-mainnet`.
 *   3. Shows every initialization parameter first and requires confirmation
 *      (unless `--yes` is set).
 *   4. Uploads WASM, deploys each contract, and calls `initialize`.
 *   5. Saves the deployed contract IDs (`contractId` and/or `treasuryContractId`)
 *      to the selected profile in the config file.
 *   6. Prints the contract IDs, WASM hashes, and initialization parameters.
 */
export async function runDeploy(
  targetArg: string | undefined,
  args: readonly string[],
  context: CommandContext,
  options: DeployOptions = {},
): Promise<RunResult> {
  // If `targetArg` is a flag (e.g. `skn deploy --registry-wasm ... --treasury-wasm ...`),
  // include it back in the args to parse.
  const fullArgs =
    targetArg !== undefined && targetArg.startsWith("-")
      ? [targetArg, ...args]
      : [...args];
  const explicitTarget =
    targetArg !== undefined && !targetArg.startsWith("-") ? targetArg : undefined;

  const { values, positionals } = parseCommandArgs(fullArgs, {
    wasm: { type: "string" },
    "registry-wasm": { type: "string" },
    "treasury-wasm": { type: "string" },
    admin: { type: "string" },
    "reward-token": { type: "string" },
    "fee-bps": { type: "string" },
    yes: { type: "boolean" },
  });
  const json = values.json === true;

  if (positionals.length > 0) {
    return usage(`'skn deploy' unexpected positional argument '${positionals[0]}'`, json);
  }

  const target = resolveDeployTarget(explicitTarget, values);
  const existingConfig = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), existingConfig);

  // Refuse mainnet without --confirm-mainnet before any network call.
  requireMainnetConfirmation(settings);

  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    { env: context.env, homeDir: context.homeDir, platform: context.platform },
  );
  if (key === undefined) {
    return usage("no signing key: set --key-file, --identity, or SKN_SECRET_KEY", json);
  }

  const keypair = Keypair.fromSecret(key.secret);
  const deployerAddress = keypair.publicKey();
  const signer = keypairSigner(keypair);

  // Validate initialization parameters locally before uploading anything.
  const adminAddress = (values.admin as string | undefined) ?? deployerAddress;
  if (
    !StrKey.isValidEd25519PublicKey(adminAddress) &&
    !StrKey.isValidContract(adminAddress)
  ) {
    throw new UsageError(
      `--admin must be a valid Stellar account (G...) or contract (C...) address; got '${adminAddress}'`,
    );
  }

  const rewardToken =
    (values["reward-token"] as string | undefined) ??
    DEFAULT_REWARD_TOKENS[settings.network];
  if (!StrKey.isValidContract(rewardToken)) {
    throw new UsageError(
      `--reward-token must be a valid Soroban contract address (C...); got '${rewardToken}'`,
    );
  }

  const rawFeeBps = values["fee-bps"] as string | undefined;
  let feeBps = DEFAULT_FEE_BPS;
  if (rawFeeBps !== undefined) {
    const cleaned = rawFeeBps.replace(/_/g, "");
    const parsed = Number(cleaned);
    if (!/^\d+$/.test(cleaned) || !Number.isInteger(parsed) || parsed < 0 || parsed > MAX_FEE_BPS) {
      throw new KeeperContractError(
        KeeperErrorCode.InvalidFeeBps,
        `--fee-bps must be an integer between 0 and ${MAX_FEE_BPS}, got '${rawFeeBps}'.`,
        { local: true },
      );
    }
    feeBps = parsed;
  }

  // Load and validate WASM files before any network call.
  const wasmPlan = await loadWasmFiles(target, values);
  const selectedProfile = settings.profile ?? existingConfig?.defaultProfile ?? settings.network;

  // Format every initialization parameter so the operator sees them first.
  const paramLines = [
    `deploy ${target} on ${settings.network} (profile: ${selectedProfile})`,
    `  rpc url:      ${redactSecrets(settings.rpcUrl)}`,
    `  deployer:     ${deployerAddress}`,
    `  admin:        ${adminAddress}`,
    `  reward_token: ${rewardToken}`,
  ];
  if (wasmPlan.registry !== undefined) {
    paramLines.push(`  fee_bps:      ${feeBps} (${(feeBps / 100).toFixed(2)}%)`);
    paramLines.push(`  registry wasm: ${wasmPlan.registry.path} (${wasmPlan.registry.bytes.length} bytes)`);
  }
  if (wasmPlan.treasury !== undefined) {
    paramLines.push(`  treasury wasm: ${wasmPlan.treasury.path} (${wasmPlan.treasury.bytes.length} bytes)`);
  }
  const paramSummary = paramLines.join("\n");

  if (!values.yes) {
    if (options.confirm === undefined) {
      return usage(
        `not submitted: confirmation required for 'skn deploy ${target}'\n${paramSummary}\nPass --yes to confirm.`,
        json,
      );
    }
    const confirmed = await options.confirm(
      `${paramSummary}\nConfirm deployment? [y/N] `,
    );
    if (!confirmed) {
      if (json) {
        return jsonResult({
          submitted: false,
          target,
          network: settings.network,
          profile: selectedProfile,
          parameters: {
            deployer: deployerAddress,
            admin: adminAddress,
            rewardToken,
            ...(wasmPlan.registry !== undefined ? { feeBps } : {}),
          },
        });
      }
      return ok(`${paramSummary}\nnot submitted\n`);
    }
  }

  const server = (context.server ?? new rpc.Server(settings.rpcUrl)) as RpcServerLike;
  const warnings: string[] = [];
  const deployed: {
    registry?: DeployedContractResult;
    treasury?: DeployedContractResult;
  } = {};

  if (wasmPlan.registry !== undefined) {
    const wasmHashBytes = await uploadWasm(
      server,
      deployerAddress,
      settings.networkPassphrase,
      signer,
      wasmPlan.registry.bytes,
    );
    const wasmHash = Buffer.from(wasmHashBytes).toString("hex");
    const contractId = await createContractInstance(
      server,
      deployerAddress,
      settings.networkPassphrase,
      signer,
      wasmHashBytes,
      1,
    );

    const registryClient = openRegistry(settings, context, warnings, {
      signer,
      server,
      contractId,
    });
    await registryClient.invoke<void>({
      method: "initialize",
      source: adminAddress,
      args: [
        nativeToScVal(adminAddress, { type: "address" }),
        nativeToScVal(rewardToken, { type: "address" }),
        nativeToScVal(feeBps, { type: "u32" }),
      ],
      signer,
    });

    deployed.registry = {
      target: "registry",
      wasmPath: wasmPlan.registry.path,
      wasmHash,
      contractId,
    };
  }

  if (wasmPlan.treasury !== undefined) {
    const wasmHashBytes = await uploadWasm(
      server,
      deployerAddress,
      settings.networkPassphrase,
      signer,
      wasmPlan.treasury.bytes,
    );
    const wasmHash = Buffer.from(wasmHashBytes).toString("hex");
    const contractId = await createContractInstance(
      server,
      deployerAddress,
      settings.networkPassphrase,
      signer,
      wasmHashBytes,
      2,
    );

    const treasuryClient = openTreasury(settings, context, warnings, {
      signer,
      server,
      contractId,
    });
    await treasuryClient.initialize({
      admin: adminAddress,
      rewardToken,
      signer,
    });

    deployed.treasury = {
      target: "treasury",
      wasmPath: wasmPlan.treasury.path,
      wasmHash,
      contractId,
    };
  }

  // Save the deployed contract IDs to the selected profile in the config file.
  const updatedConfig = saveDeployedIdsToProfile(
    existingConfig,
    selectedProfile,
    settings.network,
    deployed.registry?.contractId,
    deployed.treasury?.contractId,
  );
  await writeConfig(context.configFile, updatedConfig, true);

  const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
  if (json) {
    const payload: Record<string, unknown> = {
      submitted: true,
      target,
      network: settings.network,
      profile: selectedProfile,
      configFile: context.configFile,
      parameters: {
        deployer: deployerAddress,
        admin: adminAddress,
        rewardToken,
        ...(deployed.registry !== undefined ? { feeBps } : {}),
      },
      ...(deployed.registry !== undefined
        ? {
            contractId: deployed.registry.contractId,
            wasmHash: deployed.registry.wasmHash,
            registry: {
              contractId: deployed.registry.contractId,
              wasmHash: deployed.registry.wasmHash,
              wasmPath: deployed.registry.wasmPath,
            },
          }
        : {}),
      ...(deployed.treasury !== undefined
        ? {
            ...(deployed.registry === undefined
              ? {
                  contractId: deployed.treasury.contractId,
                  wasmHash: deployed.treasury.wasmHash,
                }
              : {}),
            treasuryContractId: deployed.treasury.contractId,
            treasuryWasmHash: deployed.treasury.wasmHash,
            treasury: {
              contractId: deployed.treasury.contractId,
              wasmHash: deployed.treasury.wasmHash,
              wasmPath: deployed.treasury.wasmPath,
            },
          }
        : {}),
    };
    return { ...jsonResult(payload), stderr };
  }

  const outLines = [...paramLines, ""];
  if (deployed.registry !== undefined) {
    outLines.push(`registry wasm hash:   ${deployed.registry.wasmHash}`);
    outLines.push(`registry contract id: ${deployed.registry.contractId}`);
  }
  if (deployed.treasury !== undefined) {
    outLines.push(`treasury wasm hash:   ${deployed.treasury.wasmHash}`);
    outLines.push(`treasury contract id: ${deployed.treasury.contractId}`);
  }
  outLines.push(`saved to profile '${selectedProfile}' in ${context.configFile}`);
  return { ...ok(`${outLines.join("\n")}\n`), stderr };
}

function resolveDeployTarget(
  explicitTarget: string | undefined,
  values: Record<string, string | boolean | undefined>,
): DeployTarget {
  if (explicitTarget !== undefined) {
    if (
      explicitTarget === "registry" ||
      explicitTarget === "treasury" ||
      explicitTarget === "all"
    ) {
      return explicitTarget;
    }
    throw new UsageError(
      `unknown deploy target '${explicitTarget}'; expected registry, treasury, or all`,
    );
  }
  const hasRegistry = values["registry-wasm"] !== undefined;
  const hasTreasury = values["treasury-wasm"] !== undefined;
  if (hasRegistry && hasTreasury) return "all";
  if (hasTreasury) return "treasury";
  return "registry";
}

interface WasmFile {
  path: string;
  bytes: Buffer;
}

async function loadWasmFiles(
  target: DeployTarget,
  values: Record<string, string | boolean | undefined>,
): Promise<{ registry?: WasmFile; treasury?: WasmFile }> {
  const readWasm = async (flag: string, path: string | undefined): Promise<WasmFile> => {
    if (path === undefined || path.trim() === "") {
      throw new UsageError(`${flag} is required`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new UsageError(`WASM file not found or unreadable: ${path}`);
    }
    if (bytes.length === 0) {
      throw new UsageError(`WASM file ${path} is empty`);
    }
    return { path, bytes };
  };

  if (target === "registry") {
    const path =
      (values["registry-wasm"] as string | undefined) ??
      (values.wasm as string | undefined);
    return { registry: await readWasm("--wasm", path) };
  }
  if (target === "treasury") {
    const path =
      (values["treasury-wasm"] as string | undefined) ??
      (values.wasm as string | undefined);
    return { treasury: await readWasm("--wasm", path) };
  }
  return {
    registry: await readWasm("--registry-wasm", values["registry-wasm"] as string | undefined),
    treasury: await readWasm("--treasury-wasm", values["treasury-wasm"] as string | undefined),
  };
}

function saveDeployedIdsToProfile(
  existing: ConfigFile | undefined,
  profileName: string,
  network: NetworkName,
  registryContractId: string | undefined,
  treasuryContractId: string | undefined,
): ConfigFile {
  const base = existing ?? defaultConfig();
  const currentProfile = base.profiles[profileName] ?? { network };
  const updatedProfile = {
    ...currentProfile,
    network: currentProfile.network ?? network,
    ...(registryContractId !== undefined ? { contractId: registryContractId } : {}),
    ...(treasuryContractId !== undefined ? { treasuryContractId } : {}),
  };
  return {
    ...base,
    profiles: {
      ...base.profiles,
      [profileName]: updatedProfile,
    },
  };
}

/**
 * Uploads contract WASM bytes via `Operation.uploadContractWasm` and returns
 * the 32-byte WASM hash.
 */
async function uploadWasm(
  server: RpcServerLike,
  source: string,
  networkPassphrase: string,
  signer: TransactionSigner,
  wasmBytes: Buffer,
): Promise<Buffer> {
  const context = "upload_contract_wasm failed";
  const account = await server.getAccount(source);
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
    .setTimeout(60)
    .build();

  const retVal = await simulateSignAndSend(server, built, networkPassphrase, signer, context);
  if (retVal instanceof Uint8Array && retVal.length === 32) {
    return Buffer.from(retVal);
  }
  if (typeof retVal === "string" && /^[0-9a-f]{64}$/i.test(retVal)) {
    return Buffer.from(retVal, "hex");
  }
  return createHash("sha256").update(wasmBytes).digest();
}

/**
 * Deploys a contract instance from an uploaded 32-byte WASM hash via
 * `Operation.createCustomContract` and returns its `C...` contract address.
 */
async function createContractInstance(
  server: RpcServerLike,
  source: string,
  networkPassphrase: string,
  signer: TransactionSigner,
  wasmHash: Buffer,
  saltIndex: number,
): Promise<string> {
  const context = "create_contract failed";
  const account = await server.getAccount(source);
  const salt = createHash("sha256")
    .update(wasmHash)
    .update(Buffer.from([saltIndex]))
    .digest();

  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(source),
        wasmHash,
        salt,
      }),
    )
    .setTimeout(60)
    .build();

  const retVal = await simulateSignAndSend(server, built, networkPassphrase, signer, context);
  if (typeof retVal === "string" && StrKey.isValidContract(retVal)) {
    return retVal;
  }
  if (retVal instanceof Uint8Array && retVal.length === 32) {
    return StrKey.encodeContract(Buffer.from(retVal));
  }
  return StrKey.encodeContract(salt);
}

async function simulateSignAndSend(
  server: RpcServerLike,
  built: ReturnType<TransactionBuilder["build"]>,
  networkPassphrase: string,
  signer: TransactionSigner,
  context: string,
): Promise<unknown> {
  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(built);
  } catch (cause) {
    throw mapDeployError(cause, context);
  }
  if (rpc.Api.isSimulationError(simulation)) {
    throw mapDeployError(simulation.error, context);
  }

  const prepared = rpc.assembleTransaction(built, simulation).build();
  const signedXdr = await signer.signTransaction(prepared.toXDR(), {
    networkPassphrase,
  });
  const signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(signed as never);
  } catch (cause) {
    throw mapDeployError(cause, context);
  }
  if (sent.status !== "PENDING") {
    throw mapDeployError(sent.errorResult ?? `submission returned ${sent.status}`, context);
  }

  const result = await server.getTransaction(sent.hash);
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw mapDeployError(result, context);
  }
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new KeeperRpcError(`${context}: transaction ${sent.hash} returned status ${result.status}`);
  }
  return result.returnValue ? scValToNative(result.returnValue) : undefined;
}

function mapDeployError(cause: unknown, context: string): Error {
  const code = decodeKeeperErrorCode(cause);
  if (code !== undefined) {
    return new KeeperContractError(code, `${context}: contract error #${code}`);
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new KeeperRpcError(`${context}: ${detail}`);
}
