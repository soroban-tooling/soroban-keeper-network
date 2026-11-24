/**
 * RPC wiring shared by the read-only ops tools.
 *
 * Both tools take an injectable RPC server so their tests run without a live
 * network. No signing key is loaded here: every call is a simulation or a
 * ledger-entry read.
 */

import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { KeeperRegistryClient, NETWORK_PRESETS, isNetworkName } from "@soroban-keeper-network/sdk";

export function resolveNetwork(network) {
  if (isNetworkName(network)) return network;
  return "testnet";
}

export function buildRpcServer({ network, rpcUrl }) {
  const preset = NETWORK_PRESETS[resolveNetwork(network)];
  return new rpc.Server(rpcUrl || preset.rpcUrl);
}

export function buildRegistryClient({ contractId, network, rpcUrl, server, warn }) {
  const preset = NETWORK_PRESETS[resolveNetwork(network)];
  return new KeeperRegistryClient({
    contractId,
    networkPassphrase: preset.networkPassphrase,
    rpcUrl: rpcUrl || preset.rpcUrl,
    server,
    warn,
  });
}

/** Ledger key for a contract instance, used to read its remaining TTL. */
export function contractInstanceKey(contractId) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

const LEDGER_SECONDS = 5;

/**
 * Approximate seconds left on the contract instance TTL.
 *
 * RPC reports an expiry ledger, not a timestamp, so the conversion uses the
 * protocol's five-second ledger target. The value is deliberately an
 * estimate, labelled as such in the metric help text.
 */
export async function instanceTtlRemainingSeconds(server, contractId) {
  const response = await server.getLedgerEntries([contractInstanceKey(contractId)]);
  const entry = response.entries?.[0];
  if (!entry || entry.liveUntilLedgerSeq === undefined) return 0;
  const remainingLedgers = Math.max(0, entry.liveUntilLedgerSeq - response.latestLedger);
  return remainingLedgers * LEDGER_SECONDS;
}
