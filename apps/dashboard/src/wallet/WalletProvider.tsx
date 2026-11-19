import { getAddress, getNetwork, isConnected, requestAccess, signTransaction, WatchWalletChanges } from "@stellar/freighter-api";
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNetwork } from "../config";
import { DataProvider } from "../data/context";
import type { RegisterTaskInput, RegistryOperations, RegistryReader } from "../data/types";
import { KeeperRegistryClient } from "../../../../packages/sdk-ts/src/client";
import { TaskType } from "../../../../packages/sdk-ts/src/types";
import { addressArg, bytesArg, i128Arg, optionalAddressArg, u32Arg, u64Arg } from "../../../../packages/sdk-ts/src/core/scval";
import { buildTransaction, submitSignedTransaction } from "../../../../packages/sdk-ts/src/transactionBuilder";

interface WalletState {
  account?: string;
  connecting: boolean;
  error?: string;
  wrongNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const [account, setAccount] = useState<string>();
  const [walletPassphrase, setWalletPassphrase] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const connected = await isConnected();
    if (connected.error || !connected.isConnected) return;
    const [address, walletNetwork] = await Promise.all([getAddress(), getNetwork()]);
    if (address.address) setAccount(address.address);
    if (walletNetwork.networkPassphrase) setWalletPassphrase(walletNetwork.networkPassphrase);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!account) return;
    const watcher = new WatchWalletChanges(1_000);
    watcher.watch((change) => {
      if (change.error) { setError(change.error.message); return; }
      setAccount(change.address || undefined);
      setWalletPassphrase(change.networkPassphrase || undefined);
    });
    return () => watcher.stop();
  }, [account]);

  const connect = useCallback(async () => {
    setConnecting(true); setError(undefined);
    try {
      const connected = await isConnected();
      if (connected.error || !connected.isConnected) throw new Error("Freighter is not installed or available in this browser.");
      const access = await requestAccess();
      if (access.error || !access.address) throw new Error(access.error?.message ?? "Wallet connection was declined.");
      const walletNetwork = await getNetwork();
      setAccount(access.address); setWalletPassphrase(walletNetwork.networkPassphrase);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to connect wallet"); }
    finally { setConnecting(false); }
  }, []);

  const disconnect = useCallback(() => { setAccount(undefined); setWalletPassphrase(undefined); setError(undefined); }, []);
  const wrongNetwork = Boolean(account && walletPassphrase && walletPassphrase !== network.networkPassphrase);
  const { reader, operations } = useMemo(() => makeAdapters(network, account, wrongNetwork), [account, network, wrongNetwork]);
  const state = useMemo(() => ({ account, connecting, error, wrongNetwork, connect, disconnect }), [account, connect, connecting, disconnect, error, wrongNetwork]);
  return <WalletContext.Provider value={state}><DataProvider registry={reader} operations={operations} account={account}>{children}</DataProvider></WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}

function makeAdapters(network: ReturnType<typeof useNetwork>["network"], account?: string, wrongNetwork = false): { reader?: RegistryReader; operations?: RegistryOperations } {
  if (!network.registryContractId) return {};
  const signer = account && !wrongNetwork ? {
    publicKey: account,
    async signTransaction(xdr: string, options: { networkPassphrase: string }) {
      const result = await signTransaction(xdr, { networkPassphrase: options.networkPassphrase, address: account });
      if (result.error || !result.signedTxXdr) throw new Error(result.error?.message ?? "Signature request was cancelled.");
      return result.signedTxXdr;
    },
  } : undefined;
  const client = new KeeperRegistryClient({ contractId: network.registryContractId, rpcUrl: network.rpcUrl, networkPassphrase: network.networkPassphrase, signer });
  const reader: RegistryReader = {
    keeperBalance: (keeper) => client.keeperBalance(keeper), keeperStake: (keeper) => client.keeperStake(keeper), keeperReputation: (keeper) => client.keeperReputation(keeper), pendingUnbond: (keeper) => client.pendingUnbond(keeper), slashHistory: (keeper) => client.slashHistory(keeper), getFeeBps: () => client.getFeeBps(), isPaused: () => client.isPaused(), feesAccrued: () => client.feesAccrued(),
    task: async (taskId) => { const task = await client.getTask(taskId); return { deadline: task.deadline, claimLedger: task.claimLedger, lockLedgers: task.lockLedgers }; },
    admin: () => client.admin(),
    minReward: () => client.minReward(),
    minStake: () => client.minStake(),
    disputeWindow: () => client.disputeWindow(),
    reputationFloor: async () => {
      try {
        return Number(await client.read<number | bigint>("reputation_floor"));
      } catch {
        return 0;
      }
    },
  };
  if (!signer || !account) return { reader };
  let pending: { key: string; xdr: string } | undefined;
  const operations: RegistryOperations = {
    async estimateRegisterTask(input) {
      const args = registrationArgs(input);
      const built = await buildTransaction(client, account, "register_task", args);
      pending = { key: registrationKey(input), xdr: built.xdr };
      return BigInt(TransactionBuilder.fromXDR(built.xdr, network.networkPassphrase).fee);
    },
    async registerTask(input) {
      if (!pending || pending.key !== registrationKey(input)) throw new Error("The registration changed. Estimate the fee again before signing.");
      const result = await signTransaction(pending.xdr, { networkPassphrase: network.networkPassphrase, address: account });
      if (result.error || !result.signedTxXdr) throw new Error(result.error?.message ?? "Signature request was cancelled.");
      await submitSignedTransaction(client, result.signedTxXdr); pending = undefined;
      return BigInt(Math.max(0, (await client.taskCount()) - 1));
    },
    async withdrawRewards(keeper) { return (await client.withdrawRewards({ keeper })).amount; },
    async stake(keeper, amount) { await client.stakeDeposit({ keeper, amount }); },
    async unbond(keeper, amount) { await client.initiateUnbond({ keeper, amount }); },
    withdrawStake: (keeper) => client.withdrawStake({ keeper }),
    async latestLedger() { return (await new rpc.Server(network.rpcUrl).getLatestLedger()).sequence; },
    async increaseReward(owner, taskId, additional) { await client.increaseReward({ owner, taskId, additional }); },
    async extendDeadline(owner, taskId, newDeadline) { await client.extendDeadline({ owner, taskId, newDeadline }); },
    async cancelTask(owner, taskId) { await client.cancelTask({ owner, taskId }); },
  };
  return { reader, operations };
}

function registrationArgs(input: RegisterTaskInput) {
  const calldata = new TextEncoder().encode(JSON.stringify({ target: input.target, function: input.functionName, args: JSON.parse(input.argumentsJson) }));
  return [addressArg(input.owner, "owner"), u32Arg(TaskType.Custom, "taskType"), bytesArg(calldata), i128Arg(input.reward, "reward"), u64Arg(input.deadline, "deadline"), u32Arg(17_280, "ttlLedgers"), u32Arg(120, "lockLedgers"), optionalAddressArg(input.verifier, "verifier"), optionalAddressArg(undefined, "condition")];
}

function registrationKey(input: RegisterTaskInput): string {
  return JSON.stringify({ ...input, reward: input.reward.toString() });
}
