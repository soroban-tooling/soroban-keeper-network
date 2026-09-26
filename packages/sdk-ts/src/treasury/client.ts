/**
 * `TreasuryClient` -- a typed client for the treasury contract
 * (`contracts/treasury`), following the same conventions
 * `KeeperRegistryClient` (`../client.ts`) established for the registry, as a
 * separate client type since the treasury is a distinct deployed contract
 * (see `contracts/treasury/src/lib.rs`'s own doc comment).
 *
 * The plumbing below (simulate/build/sign/submit, dual-auth signing,
 * confirmation polling) intentionally mirrors `KeeperRegistryClient`'s
 * implementation line-for-line rather than importing it: the two are
 * separate contracts with separate ABIs and separate error enums, and this
 * client raises only `Treasury*` errors, never `Keeper*` ones.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { AuthEntrySigner } from "../core/auth.js";
import { signAuthEntries } from "../core/auth.js";
import type { TransactionSigner } from "../core/caller.js";
import { keypairSigner } from "../client.js";
import { TreasuryContractError, TreasuryErrorCode, TreasurySdkError, toTreasuryError } from "./errors.js";
import type { IntegerInput } from "./scval.js";
import { addressArg, bytesN32Arg, i128Arg, toBigInt, u32Arg } from "./scval.js";
import type { Recipient } from "./types.js";

export { keypairSigner };
export type { TransactionSigner };

/** The subset of `rpc.Server` this client uses. Same shape as `RpcServerLike` in `../client.ts`. */
export type RpcServerLike = Pick<
  rpc.Server,
  | "getAccount"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getLatestLedger"
  | "getEvents"
>;

export interface TreasuryClientOptions {
  /** `C...` address of the deployed treasury contract. */
  contractId: string;
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl?: string | undefined;
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Default signer for state-changing calls; a per-call `signer` overrides it. */
  signer?: TransactionSigner | undefined;
  /** Base fee in stroops for built transactions. Defaults to `BASE_FEE`. */
  fee?: string | undefined;
  /** Transaction validity window in seconds. Defaults to 30. */
  timeoutSeconds?: number | undefined;
  /** How long to wait for a submitted transaction to leave `PENDING`. */
  confirmationTimeoutMs?: number | undefined;
  /** Delay between confirmation polls. */
  pollIntervalMs?: number | undefined;
  /** Pre-built RPC server. Supplying one skips constructing one from `rpcUrl`. */
  server?: RpcServerLike | undefined;
  /** Sink for non-fatal warnings. Defaults to `console.warn`. */
  warn?: ((message: string) => void) | undefined;
}

/** Arguments shared by every state-changing wrapper method. */
export interface SignedCallOptions {
  /** Signer for this call, overriding the client's default. */
  signer?: TransactionSigner;
}

export interface AddRecipientParams extends SignedCallOptions {
  admin: string;
  recipient: string;
  sharesBps: number;
}

export interface RemoveRecipientParams extends SignedCallOptions {
  admin: string;
  recipient: string;
}

export interface UpdateRecipientSharesParams extends SignedCallOptions {
  admin: string;
  recipient: string;
  newSharesBps: number;
}

export interface DistributeParams extends SignedCallOptions {
  /** Address funding this distribution. Must authorize and hold `amount`. */
  caller: string;
  /** Amount to distribute, in the reward token's own units. `i128`. */
  amount: IntegerInput;
}

export interface WithdrawParams extends SignedCallOptions {
  recipient: string;
}

export interface AdminCallParams extends SignedCallOptions {
  admin: string;
}

export interface UpgradeParams extends SignedCallOptions {
  admin: string;
  newWasmHash: Uint8Array;
}

export interface InitializeParams extends SignedCallOptions {
  admin: string;
  rewardToken: string;
}

export interface TransferAdminParams extends SignedCallOptions {
  currentAdmin: string;
  newAdmin: string;
  /**
   * Auth-entry signers covering both addresses. Required: the contract calls
   * `require_auth` on both the outgoing and incoming admin (see
   * `contracts/treasury/src/admin.rs::transfer_admin`), so the envelope
   * signature (which satisfies only the source account) is not enough.
   */
  authSigners: readonly AuthEntrySigner[];
}

const READ_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const AUTH_ENTRY_VALIDITY_LEDGERS = 720;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TreasuryClient {
  readonly contractId: string;
  readonly networkPassphrase: string;

  private readonly contract: Contract;
  private readonly server: RpcServerLike;
  private readonly defaultSigner: TransactionSigner | undefined;
  private readonly fee: string;
  private readonly timeoutSeconds: number;
  private readonly confirmationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly warnSink: (message: string) => void;

  constructor(options: TreasuryClientOptions) {
    if (!StrKey.isValidContract(options.contractId)) {
      throw new TreasurySdkError(
        `Invalid contract id ${JSON.stringify(options.contractId)}: expected a C... Soroban contract address.`,
      );
    }
    if (!options.networkPassphrase) {
      throw new TreasurySdkError("networkPassphrase is required.");
    }
    if (!options.server && !options.rpcUrl) {
      throw new TreasurySdkError("rpcUrl is required unless a server is supplied.");
    }

    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
    this.contract = new Contract(options.contractId);
    this.server = options.server ?? new rpc.Server(options.rpcUrl as string);
    this.defaultSigner = options.signer;
    this.fee = options.fee ?? BASE_FEE;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.warnSink = options.warn ?? ((message: string) => console.warn(message));
  }

  // ── views ──────────────────────────────────────────────────────────────────

  async admin(): Promise<string | undefined> {
    return optional(await this.read<string | null | undefined>("admin"));
  }

  async isPaused(): Promise<boolean> {
    return Boolean(await this.read<boolean>("is_paused"));
  }

  async rewardTokenAddress(): Promise<string | undefined> {
    return optional(await this.read<string | null | undefined>("reward_token_address"));
  }

  /** Every currently-registered recipient with its shares, in registration order. */
  async recipients(): Promise<Recipient[]> {
    const raw = await this.read<{ address: string; shares_bps: number | bigint }[]>("recipients");
    return raw.map((r) => ({ address: r.address, sharesBps: Number(r.shares_bps) }));
  }

  /** A recipient's current share, in basis points (0 if not registered). */
  async recipientShares(recipient: string): Promise<number> {
    return Number(
      await this.read<number | bigint>("recipient_shares", [addressArg(recipient, "recipient")]),
    );
  }

  /** A recipient's withdrawable balance, in the reward token's own units. `i128`, so `bigint`. */
  async recipientBalance(recipient: string): Promise<bigint> {
    return BigInt(
      await this.read<bigint | number>("recipient_balance", [addressArg(recipient, "recipient")]),
    );
  }

  /** A recipient's lifetime total ever credited by `distribute`, including amounts already withdrawn. */
  async recipientTotalReceived(recipient: string): Promise<bigint> {
    return BigInt(
      await this.read<bigint | number>("recipient_total_received", [
        addressArg(recipient, "recipient"),
      ]),
    );
  }

  /** Lifetime total ever distributed to any recipient. */
  async totalDistributed(): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("total_distributed"));
  }

  /** Maximum number of recipients `distribute` will iterate. */
  async maxRecipients(): Promise<number> {
    return Number(await this.read<number | bigint>("max_recipients"));
  }

  /** The deployed contract's logic version. */
  async version(): Promise<number> {
    return Number(await this.read<number | bigint>("version"));
  }

  // ── state-changing entry points ──────────────────────────────────────────────

  async initialize(params: InitializeParams): Promise<void> {
    const { admin, rewardToken, signer } = params;
    await this.invoke<void>({
      method: "initialize",
      source: admin,
      args: [addressArg(admin, "admin"), addressArg(rewardToken, "rewardToken")],
      ...(signer ? { signer } : {}),
    });
  }

  async addRecipient(params: AddRecipientParams): Promise<void> {
    const { admin, recipient, sharesBps, signer } = params;
    await this.invoke<void>({
      method: "add_recipient",
      source: admin,
      args: [
        addressArg(admin, "admin"),
        addressArg(recipient, "recipient"),
        u32Arg(sharesBps, "sharesBps"),
      ],
      ...(signer ? { signer } : {}),
    });
  }

  async removeRecipient(params: RemoveRecipientParams): Promise<void> {
    const { admin, recipient, signer } = params;
    await this.invoke<void>({
      method: "remove_recipient",
      source: admin,
      args: [addressArg(admin, "admin"), addressArg(recipient, "recipient")],
      ...(signer ? { signer } : {}),
    });
  }

  async updateRecipientShares(params: UpdateRecipientSharesParams): Promise<void> {
    const { admin, recipient, newSharesBps, signer } = params;
    await this.invoke<void>({
      method: "update_recipient_shares",
      source: admin,
      args: [
        addressArg(admin, "admin"),
        addressArg(recipient, "recipient"),
        u32Arg(newSharesBps, "newSharesBps"),
      ],
      ...(signer ? { signer } : {}),
    });
  }

  /**
   * Funds a distribution: pulls `amount` from `caller` and splits it
   * pro-rata across every registered recipient's share.
   */
  async distribute(params: DistributeParams): Promise<void> {
    const { caller, signer } = params;
    const amount = toBigInt(params.amount, "amount");
    await this.invoke<void>({
      method: "distribute",
      source: caller,
      args: [addressArg(caller, "caller"), i128Arg(amount, "amount")],
      ...(signer ? { signer } : {}),
    });
  }

  /**
   * Withdraws the recipient's full accrued balance and returns the amount
   * moved. `i128`, so `bigint`.
   */
  async withdraw(params: WithdrawParams): Promise<bigint> {
    const { recipient, signer } = params;
    const withdrawn = await this.invoke<bigint>({
      method: "withdraw",
      source: recipient,
      args: [addressArg(recipient, "recipient")],
      ...(signer ? { signer } : {}),
    });
    if (typeof withdrawn !== "bigint") {
      throw new TypeError(
        `withdraw returned ${String(withdrawn)} instead of an i128 amount; the deployed contract may not be a treasury.`,
      );
    }
    return withdrawn;
  }

  /**
   * {@link withdraw}, with the empty-balance case folded into the return
   * value: resolves to `0n` instead of rejecting when there is nothing to
   * withdraw.
   */
  async tryWithdraw(params: WithdrawParams): Promise<bigint> {
    try {
      return await this.withdraw(params);
    } catch (error) {
      if (error instanceof TreasuryContractError && error.code === TreasuryErrorCode.NoRewardsAvailable) {
        return 0n;
      }
      throw error;
    }
  }

  async pause(params: AdminCallParams): Promise<void> {
    const { admin, signer } = params;
    await this.invoke<void>({
      method: "pause",
      source: admin,
      args: [addressArg(admin, "admin")],
      ...(signer ? { signer } : {}),
    });
  }

  async unpause(params: AdminCallParams): Promise<void> {
    const { admin, signer } = params;
    await this.invoke<void>({
      method: "unpause",
      source: admin,
      args: [addressArg(admin, "admin")],
      ...(signer ? { signer } : {}),
    });
  }

  /**
   * Hands the admin role to `newAdmin`. Both parties sign: the contract will
   * not transfer the role to an address that has not itself authorized
   * taking it.
   */
  async transferAdmin(params: TransferAdminParams): Promise<void> {
    const { currentAdmin, newAdmin, authSigners, signer } = params;
    await this.invokeMultiAuth<void>({
      method: "transfer_admin",
      source: currentAdmin,
      args: [addressArg(currentAdmin, "currentAdmin"), addressArg(newAdmin, "newAdmin")],
      authSigners,
      ...(signer ? { signer } : {}),
    });
  }

  async upgrade(params: UpgradeParams): Promise<void> {
    const { admin, newWasmHash, signer } = params;
    await this.invoke<void>({
      method: "upgrade",
      source: admin,
      args: [addressArg(admin, "admin"), bytesN32Arg(newWasmHash, "newWasmHash")],
      ...(signer ? { signer } : {}),
    });
  }

  // ── shared plumbing (mirrors KeeperRegistryClient's, see file doc comment) ──

  async read<T>(method: string, args: xdr.ScVal[] = []): Promise<T> {
    const context = `${method} simulation failed`;
    const account = new Account(READ_SOURCE_ACCOUNT, "0");
    const tx = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(tx);
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toTreasuryError(simulation.error, context);
    }
    const result = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result;
    return result ? (scValToNative(result.retval) as T) : (undefined as T);
  }

  async invoke<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
  }): Promise<T> {
    const { method, args = [], source } = params;
    const context = `${method} failed`;
    const signer = this.resolveSigner(method, source, params.signer);

    const account = await this.loadAccount(source, context);
    const built = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(built);
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toTreasuryError(simulation.error, context);
    }

    const prepared = rpc.assembleTransaction(built, simulation).build();
    const signedXdr = await signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(signed as never);
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }
    if (sent.status !== "PENDING") {
      throw toTreasuryError(sent.errorResult ?? `submission returned ${sent.status}`, context);
    }

    return this.confirm<T>(sent.hash, context);
  }

  /**
   * Like {@link invoke}, but additionally signs the Soroban auth entries that
   * require an address other than the source account. Only `transfer_admin`
   * needs this today.
   */
  async invokeMultiAuth<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
    authSigners: readonly AuthEntrySigner[];
  }): Promise<T> {
    const { method, args = [], source, authSigners } = params;
    const context = `${method} failed`;
    const signer = this.resolveSigner(method, source, params.signer);

    const account = await this.loadAccount(source, context);
    const startingSequence = account.sequenceNumber();
    const built = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(built);
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toTreasuryError(simulation.error, context);
    }

    const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
    const entries = success.result?.auth ?? [];

    let validUntilLedgerSeq: number;
    try {
      validUntilLedgerSeq =
        (await this.server.getLatestLedger()).sequence + AUTH_ENTRY_VALIDITY_LEDGERS;
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }

    const signedAuth = await signAuthEntries(
      entries,
      authSigners,
      validUntilLedgerSeq,
      this.networkPassphrase,
      method,
    );

    const rebuilt = new TransactionBuilder(new Account(source, startingSequence), {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: (built.operations[0] as Operation.InvokeHostFunction).func,
          auth: signedAuth,
        }),
      )
      .setTimeout(this.timeoutSeconds)
      .build();

    const prepared = rpc.assembleTransaction(rebuilt, simulation).build();
    const signedXdr = await signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(signed as never);
    } catch (cause) {
      throw toTreasuryError(cause, context);
    }
    if (sent.status !== "PENDING") {
      throw toTreasuryError(sent.errorResult ?? `submission returned ${sent.status}`, context);
    }

    return this.confirm<T>(sent.hash, context);
  }

  /** Non-fatal diagnostics sink. */
  warn(message: string): void {
    this.warnSink(message);
  }

  private resolveSigner(
    method: string,
    source: string,
    override: TransactionSigner | undefined,
  ): TransactionSigner {
    const signer = override ?? this.defaultSigner;
    if (!signer) {
      throw new TreasurySdkError(
        `${method} is a state-changing call and needs a signer: pass one to the client constructor or to this call.`,
      );
    }
    if (signer.publicKey !== source) {
      throw new TreasurySdkError(
        `${method} must be authorized by ${source}, but the available signer is ${signer.publicKey}.`,
      );
    }
    return signer;
  }

  private async loadAccount(source: string, context: string): Promise<Account> {
    if (!StrKey.isValidEd25519PublicKey(source)) {
      throw new TreasurySdkError(
        `Invalid account address ${JSON.stringify(source)}: expected a G... Stellar address.`,
      );
    }
    try {
      return await this.server.getAccount(source);
    } catch (cause) {
      throw toTreasuryError(cause, `${context} (could not load source account ${source})`);
    }
  }

  private buildTransaction(account: Account, method: string, args: xdr.ScVal[]) {
    return new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();
  }

  private async confirm<T>(hash: string, context: string): Promise<T> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    for (;;) {
      let result: rpc.Api.GetTransactionResponse;
      try {
        result = await this.server.getTransaction(hash);
      } catch (cause) {
        throw toTreasuryError(cause, context);
      }

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result.returnValue ? (scValToNative(result.returnValue) as T) : (undefined as T);
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw toTreasuryError(result, context);
      }
      if (Date.now() >= deadline) {
        throw new TreasurySdkError(
          `${context}: transaction ${hash} was still ${result.status} after ${this.confirmationTimeoutMs}ms. It may still succeed; re-check with getTransaction("${hash}").`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** The underlying RPC server. */
  getServer(): RpcServerLike {
    return this.server;
  }
}

function optional(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}
