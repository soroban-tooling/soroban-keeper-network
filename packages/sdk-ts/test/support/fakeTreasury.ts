/**
 * A tiny in-memory stand-in for the treasury contract's state machine, so the
 * SDK's own tests can exercise a real sequence of calls -- configure
 * recipients, distribute, reweight, withdraw -- against a `TreasuryClient`
 * doing real encoding, signing, and error decoding, with only the ledger
 * behind it faked.
 *
 * Mirrors `test/support/fakeRegistry.ts::FakeRegistry`'s design exactly: this
 * models only the guards `contracts/treasury/src/*.rs` enforces, not a
 * reimplementation of the whole contract, and the Rust test suite remains
 * the authority on contract behaviour.
 */

import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { TreasuryClient, keypairSigner } from "../../src/treasury/client.js";
import type { RpcServerLike } from "../../src/treasury/client.js";
import { TreasuryErrorCode } from "../../src/treasury/errors.js";

export const TREASURY_CONTRACT_ID = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

/** Thrown internally to mark a call the contract would have rejected. */
class ContractRejection extends Error {
  constructor(readonly code: TreasuryErrorCode) {
    super(`HostError: Error(Contract, #${code})`);
  }
}

interface RecipientState {
  sharesBps: number;
  balance: bigint;
  totalReceived: bigint;
}

export class FakeTreasury implements RpcServerLike {
  ledgerSequence = 100_000;

  /** Every contract method called against this treasury, in order. */
  readonly methods: string[] = [];

  private admin: string | undefined;
  private rewardToken: string | undefined;
  private paused = false;
  private readonly recipientOrder: string[] = [];
  private readonly recipients = new Map<string, RecipientState>();
  private totalDistributed = 0n;

  // ── RpcServerLike ─────────────────────────────────────────────────────────

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return { id: "fake", protocolVersion: 22, sequence: this.ledgerSequence };
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  async simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse> {
    const { method, args } = decodeCall(tx);
    this.methods.push(method);

    let retval: unknown;
    try {
      retval = this.dispatch(method, args);
    } catch (error) {
      if (!(error instanceof ContractRejection)) throw error;
      return {
        _parsed: true,
        id: "1",
        latestLedger: 1,
        error: error.message,
        events: [],
      } as unknown as rpc.Api.SimulateTransactionResponse;
    }

    return {
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      result: { retval: toScVal(retval), auth: [] },
    } as unknown as rpc.Api.SimulateTransactionResponse;
  }

  async sendTransaction(tx: { hash: () => Buffer }): Promise<rpc.Api.SendTransactionResponse> {
    return {
      status: "PENDING",
      hash: tx.hash().toString("hex"),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    } as rpc.Api.SendTransactionResponse;
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    // Mutations already happened in `simulateTransaction` (the client always
    // simulates before it submits), so this just replays the same dispatch to
    // report the same return value, matching `FakeRegistry`'s approach.
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 1,
      txHash: hash,
      returnValue: this.lastReturnValue,
    } as unknown as rpc.Api.GetTransactionResponse;
  }

  private lastReturnValue: xdr.ScVal = xdr.ScVal.scvVoid();

  // ── the modelled entry points ─────────────────────────────────────────────

  private dispatch(method: string, args: unknown[]): unknown {
    switch (method) {
      case "initialize":
        this.initialize(args[0] as string, args[1] as string);
        return this.setReturn(undefined);
      case "add_recipient":
        this.addRecipient(args[0] as string, args[1] as string, Number(args[2]));
        return this.setReturn(undefined);
      case "remove_recipient":
        this.removeRecipient(args[0] as string, args[1] as string);
        return this.setReturn(undefined);
      case "update_recipient_shares":
        this.updateRecipientShares(args[0] as string, args[1] as string, Number(args[2]));
        return this.setReturn(undefined);
      case "distribute":
        this.distribute(args[0] as string, BigInt(args[1] as bigint | number));
        return this.setReturn(undefined);
      case "withdraw":
        return this.setReturn(this.withdraw(args[0] as string));
      case "pause":
        this.requireAdmin(args[0] as string);
        this.paused = true;
        return this.setReturn(undefined);
      case "unpause":
        this.requireAdmin(args[0] as string);
        this.paused = false;
        return this.setReturn(undefined);
      case "transfer_admin":
        this.requireAdmin(args[0] as string);
        this.admin = args[1] as string;
        return this.setReturn(undefined);
      case "admin":
        return this.setReturn(this.admin ?? null);
      case "is_paused":
        return this.setReturn(this.paused);
      case "reward_token_address":
        return this.setReturn(this.rewardToken ?? null);
      case "recipients":
        return this.setReturn(
          this.recipientOrder.map((address) => ({
            address,
            shares_bps: this.recipients.get(address)?.sharesBps ?? 0,
          })),
        );
      case "recipient_shares":
        return this.setReturn(this.recipients.get(args[0] as string)?.sharesBps ?? 0);
      case "recipient_balance":
        return this.setReturn(this.recipients.get(args[0] as string)?.balance ?? 0n);
      case "recipient_total_received":
        return this.setReturn(this.recipients.get(args[0] as string)?.totalReceived ?? 0n);
      case "total_distributed":
        return this.setReturn(this.totalDistributed);
      case "max_recipients":
        return this.setReturn(50);
      case "version":
        return this.setReturn(1);
      default:
        throw new Error(`FakeTreasury does not model ${method}`);
    }
  }

  private setReturn(value: unknown): unknown {
    this.lastReturnValue = toScVal(value);
    return value;
  }

  private requireAdmin(caller: string): void {
    if (this.admin === undefined) throw new ContractRejection(TreasuryErrorCode.NotInitialized);
    if (caller !== this.admin) throw new ContractRejection(TreasuryErrorCode.Unauthorized);
  }

  private initialize(admin: string, rewardToken: string): void {
    if (this.admin !== undefined) throw new ContractRejection(TreasuryErrorCode.AlreadyInitialized);
    this.admin = admin;
    this.rewardToken = rewardToken;
    this.paused = false;
  }

  private addRecipient(admin: string, recipient: string, sharesBps: number): void {
    this.requireAdmin(admin);
    if (sharesBps <= 0 || sharesBps > 10_000) {
      throw new ContractRejection(TreasuryErrorCode.InvalidShares);
    }
    if (this.recipientOrder.includes(recipient)) {
      throw new ContractRejection(TreasuryErrorCode.RecipientAlreadyExists);
    }
    if (this.recipientOrder.length >= 50) {
      throw new ContractRejection(TreasuryErrorCode.TooManyRecipients);
    }
    this.recipientOrder.push(recipient);
    this.recipients.set(recipient, { sharesBps, balance: 0n, totalReceived: 0n });
  }

  private removeRecipient(admin: string, recipient: string): void {
    this.requireAdmin(admin);
    const idx = this.recipientOrder.indexOf(recipient);
    if (idx === -1) throw new ContractRejection(TreasuryErrorCode.RecipientNotFound);
    this.recipientOrder.splice(idx, 1);
    const state = this.recipients.get(recipient);
    if (state) state.sharesBps = 0;
  }

  private updateRecipientShares(admin: string, recipient: string, newSharesBps: number): void {
    this.requireAdmin(admin);
    if (newSharesBps <= 0 || newSharesBps > 10_000) {
      throw new ContractRejection(TreasuryErrorCode.InvalidShares);
    }
    if (!this.recipientOrder.includes(recipient)) {
      throw new ContractRejection(TreasuryErrorCode.RecipientNotFound);
    }
    const state = this.recipients.get(recipient);
    if (state) state.sharesBps = newSharesBps;
  }

  private distribute(_caller: string, amount: bigint): void {
    if (this.paused) throw new ContractRejection(TreasuryErrorCode.ContractPaused);
    if (amount <= 0n) throw new ContractRejection(TreasuryErrorCode.InvalidAmount);

    const totalShares = this.recipientOrder.reduce(
      (sum, address) => sum + BigInt(this.recipients.get(address)?.sharesBps ?? 0),
      0n,
    );
    if (this.recipientOrder.length === 0 || totalShares === 0n) {
      throw new ContractRejection(TreasuryErrorCode.NoRecipients);
    }

    for (const address of this.recipientOrder) {
      const state = this.recipients.get(address);
      if (!state || state.sharesBps === 0) continue;
      const shareAmount = (amount * BigInt(state.sharesBps)) / totalShares;
      if (shareAmount === 0n) continue;
      state.balance += shareAmount;
      state.totalReceived += shareAmount;
      this.totalDistributed += shareAmount;
    }
  }

  private withdraw(recipient: string): bigint {
    const state = this.recipients.get(recipient);
    const balance = state?.balance ?? 0n;
    if (balance <= 0n) throw new ContractRejection(TreasuryErrorCode.NoRewardsAvailable);
    if (state) state.balance = 0n;
    return balance;
  }
}

export interface TreasuryBackedClient {
  client: TreasuryClient;
  address: string;
}

/**
 * A client whose contract calls are answered by `treasury`, signing as a
 * fresh random account unless `keypair` is supplied.
 */
export function clientFor(
  treasury: FakeTreasury,
  keypair = Keypair.random(),
): TreasuryBackedClient {
  const client = new TreasuryClient({
    contractId: TREASURY_CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer: keypairSigner(keypair),
    server: treasury,
    pollIntervalMs: 1,
  });
  return { client, address: keypair.publicKey() };
}

function toScVal(value: unknown): xdr.ScVal {
  if (value === undefined || value === null) return xdr.ScVal.scvVoid();
  if (value instanceof xdr.ScVal) return value;
  return nativeToScVal(value);
}

/** Pulls the entry point and arguments back out of a built transaction. */
function decodeCall(tx: unknown): { method: string; args: unknown[] } {
  const operation = (tx as { operations: { func: xdr.HostFunction }[] }).operations[0];
  const invocation = (operation as { func: xdr.HostFunction }).func.invokeContract();
  return {
    method: invocation.functionName().toString(),
    args: invocation.args().map((arg) => scValToNative(arg)),
  };
}
