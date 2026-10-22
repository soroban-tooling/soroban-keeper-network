import type { xdr } from "@stellar/stellar-sdk";
import {
  KeeperRegistryClient,
  NETWORK_PRESETS,
  isNetworkName,
  keypairSigner,
  type AuthEntrySigner,
  type ContractCaller,
  type TransactionSigner,
} from "@soroban-keeper-network/sdk";

import { CliError, ExitCode, usageError } from "./errors.js";
import { loadKey, type LoadedKey } from "./keys.js";
import { Output, formatStroops } from "./output.js";
import type { Runtime } from "./runtime.js";

/** Options declared on the root command, available to every subcommand. */
export interface GlobalOptions {
  network?: string;
  rpcUrl?: string;
  passphrase?: string;
  contractId?: string;
  keyFile?: string;
  json?: boolean;
}

export interface Connection {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

/**
 * Resolves where to connect. Precedence, highest first: flag, environment
 * variable, the network preset (`testnet` unless told otherwise).
 */
export function resolveConnection(rt: Runtime, g: GlobalOptions): Connection {
  const network = g.network ?? rt.env.SKN_NETWORK ?? "testnet";
  if (!isNetworkName(network)) {
    throw usageError(`Unknown network "${network}". Use testnet, futurenet or mainnet.`);
  }
  const preset = NETWORK_PRESETS[network];

  const contractId = g.contractId ?? rt.env.SKN_CONTRACT_ID;
  if (!contractId) {
    throw usageError(
      "No registry contract. Pass --contract-id <C...> or set SKN_CONTRACT_ID.",
    );
  }

  return {
    network,
    rpcUrl: g.rpcUrl ?? rt.env.SKN_RPC_URL ?? preset.rpcUrl,
    networkPassphrase: g.passphrase ?? rt.env.SKN_NETWORK_PASSPHRASE ?? preset.networkPassphrase,
    contractId,
  };
}

export interface Session {
  conn: Connection;
  client: KeeperRegistryClient;
  out: Output;
  /** Present only when the command asked for a key. */
  key?: LoadedKey;
}

/** Builds the SDK client for one command invocation. */
export function openSession(
  rt: Runtime,
  g: GlobalOptions,
  options: { needsKey: boolean },
): Session {
  const out = new Output(rt.io, g.json === true);
  const conn = resolveConnection(rt, g);
  const key = options.needsKey ? loadKey(rt, g.keyFile) : undefined;

  const client = new KeeperRegistryClient({
    contractId: conn.contractId,
    rpcUrl: conn.rpcUrl,
    networkPassphrase: conn.networkPassphrase,
    signer: key ? keypairSigner(key.keypair) : undefined,
    server: rt.server,
    pollIntervalMs: rt.confirmPollIntervalMs,
    warn: (message) => out.warn(message),
  });

  return key ? { conn, client, out, key } : { conn, client, out };
}

/**
 * Refuses to send a transaction nobody approved.
 *
 * `--yes` approves in advance. Otherwise a person must answer at a terminal;
 * with no terminal, or with `--json` (where a prompt would corrupt the output),
 * the command fails instead of guessing.
 */
export async function requireConfirmation(
  rt: Runtime,
  options: { yes: boolean | undefined; json: boolean; question: string },
): Promise<void> {
  if (options.yes) return;
  if (options.json || !rt.io.isTTY) {
    throw usageError(
      "Refusing to submit a transaction without confirmation. Re-run with --yes to approve it.",
    );
  }
  if (!(await rt.io.confirm(options.question))) {
    throw new CliError("Aborted. Nothing was submitted.", ExitCode.Failure, "aborted");
  }
}

export interface FeePreview {
  method: string;
  /** Estimated total fee in stroops, from the simulation. */
  feeStroops: string;
}

/**
 * Wraps the SDK client so every state-changing call is simulated and its fee
 * shown to `onPreview` before anything is signed. `onPreview` may throw to stop
 * the call (a declined prompt); the real submission, which simulates again,
 * only happens if it returns.
 *
 * Reads pass straight through. Because the SDK's typed entry points take a
 * `ContractCaller`, this reuses their argument encoding and local validation
 * unchanged instead of re-implementing them.
 */
export class PreviewCaller implements ContractCaller {
  constructor(
    private readonly client: KeeperRegistryClient,
    private readonly onPreview: (preview: FeePreview) => Promise<void>,
  ) {}

  read<T>(method: string, args?: xdr.ScVal[]): Promise<T> {
    return this.client.read<T>(method, args);
  }

  async invoke<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
  }): Promise<T> {
    const assembled = await this.client.buildAssembledTransaction(
      params.source,
      params.method,
      params.args ?? [],
    );
    await this.onPreview({ method: params.method, feeStroops: assembled.fee });
    return this.client.invoke<T>(params);
  }

  invokeMultiAuth<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
    authSigners: readonly AuthEntrySigner[];
  }): Promise<T> {
    return this.client.invokeMultiAuth<T>(params);
  }

  warn(message: string): void {
    this.client.warn(message);
  }
}

/**
 * The common write path: a caller that previews the fee on stderr, asks for
 * confirmation, and records the fee for the command's result.
 */
export function previewingCaller(
  rt: Runtime,
  session: Session,
  options: { yes: boolean | undefined },
): { caller: PreviewCaller; feeStroops: () => string | undefined } {
  let fee: string | undefined;
  const caller = new PreviewCaller(session.client, async (preview) => {
    fee = preview.feeStroops;
    session.out.note(`Estimated fee for ${preview.method}: ${formatStroops(preview.feeStroops)}`);
    await requireConfirmation(rt, {
      yes: options.yes,
      json: session.out.json,
      question: `Submit ${preview.method} to ${session.conn.network}?`,
    });
  });
  return { caller, feeStroops: () => fee };
}
