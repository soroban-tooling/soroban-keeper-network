import { KeeperRegistryClient } from "@soroban-keeper-network/sdk";
import { rpc } from "@stellar/stellar-sdk";

import { CliError } from "./cliError.js";
import {
  requireContractId,
  requireMainnetConfirmation,
  resolveConfig,
  type ConnectionFlags,
  type EffectiveConfig,
} from "./config.js";
import type { CommandContext } from "./context.js";
import { loadSigningKey, type KeyFlags, type SigningKey } from "./keys.js";

/** Every global option, as `command.optsWithGlobals()` returns them. */
export interface GlobalOptions extends ConnectionFlags, KeyFlags {
  confirmMainnet?: boolean | undefined;
}

/** The one RPC read the CLI makes itself rather than through the SDK client. */
export interface LedgerSource {
  getLatestLedger(): Promise<{ sequence: number }>;
}

/** What a transaction-sending command works with. */
export interface SigningSession {
  config: EffectiveConfig;
  key: SigningKey;
  client: KeeperRegistryClient;
  ledgers: LedgerSource;
}

/**
 * Resolves config, enforces the mainnet confirmation, loads the key and
 * builds a client -- in that order, so a missing `--confirm-mainnet` or
 * contract ID is reported before any key material is touched.
 */
export async function openSigningSession(
  ctx: CommandContext,
  options: GlobalOptions,
): Promise<SigningSession> {
  const config = await resolveConfig(options, ctx.io);
  requireMainnetConfirmation(config, options.confirmMainnet === true);
  const contractId = requireContractId(config);
  const rpcUrl = requireHttpsUrl(config.rpcUrl.value);
  const key = await loadSigningKey(options, ctx.io, ctx.redactor);

  // Without an injected server the SDK builds its own from `rpcUrl`, with
  // its own copy of @stellar/stellar-sdk. Handing it a server built from
  // this package's copy would mix XDR objects from two copies of the
  // library during transaction assembly whenever a `file:` install leaves
  // both on disk.
  const client = new KeeperRegistryClient({
    contractId,
    networkPassphrase: config.networkPassphrase.value,
    rpcUrl,
    server: ctx.io.server,
    signer: key.signer,
    warn: (message) => ctx.err(`warning: ${message}`),
  });
  const ledgers: LedgerSource = ctx.io.server ?? new rpc.Server(rpcUrl);
  return { config, key, client, ledgers };
}

/** The stellar-sdk's RPC client refuses plain HTTP; say so up front. */
function requireHttpsUrl(rpcUrl: string): string {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new CliError(`Invalid RPC URL "${rpcUrl}".`);
  }
  if (url.protocol !== "https:") {
    throw new CliError(`RPC URL "${rpcUrl}" must use https.`);
  }
  return rpcUrl;
}

/** Parses a task ID argument as a non-negative `u64`. */
export function parseTaskId(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`Invalid task ID "${value}": expected a non-negative integer.`);
  }
  const id = BigInt(value);
  if (id > 0xffff_ffff_ffff_ffffn) {
    throw new CliError(`Invalid task ID "${value}": larger than a u64.`);
  }
  return id;
}

/** Ledgers close roughly every five seconds; good enough for an estimate. */
const SECONDS_PER_LEDGER = 5;

/** "about 8m 20s" for a ledger count, as an estimate an operator can plan with. */
export function describeLedgers(ledgers: number): string {
  const total = Math.max(0, ledgers) * SECONDS_PER_LEDGER;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return `about ${parts.join(" ")}`;
}
