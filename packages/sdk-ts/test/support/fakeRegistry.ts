/**
 * A tiny in-memory stand-in for the registry's task state machine, so tests
 * for the lifecycle methods can exercise real preconditions -- "a Pending
 * task", "a Claimed task whose lock has lapsed" -- instead of asserting that
 * a hard-coded error maps to a hard-coded outcome.
 *
 * It is an {@link RpcServerLike}, the same seam {@link FakeRpc} implements, so
 * a test gets a real `KeeperRegistryClient` doing real encoding, signing, and
 * error decoding; only the ledger behind it is fake. Where `FakeRpc` answers
 * each entry point with a canned result, this one answers from state, which is
 * what makes a sequence of calls -- claim, lapse, re-claim -- testable at all.
 *
 * Scope, deliberately narrow: it models only the guards the methods under test
 * claim to distinguish, taken from `contracts/keeper-registry/src/task.rs`. It
 * knows nothing about escrow, fees, auth, pausing, or storage TTL. A fake that
 * reimplemented the contract would only ever prove itself right, so the
 * authority on contract behaviour stays the Rust test suite, with the SDK's
 * own end-to-end coverage tracked as issue #249. Each lifecycle method added
 * to the SDK extends `dispatch` with the one call it needs, and no more.
 */

import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { KeeperRegistryClient, keypairSigner } from "../../src/client.js";
import type { RpcServerLike } from "../../src/client.js";
import { KeeperErrorCode } from "../../src/errors.js";
import { TaskStatus } from "../../src/types.js";
import { CONTRACT_ID } from "./client.js";

export interface FakeTask {
  owner: string;
  status: TaskStatus;
  claimer?: string;
  /** Ledger sequence at claim time, mirroring the contract's `claim_ledger`. */
  claimLedger?: number;
  lockLedgers: number;
  /** Unix timestamp (seconds), mirroring the contract's `deadline`. */
  deadline: bigint;
}

export interface SeedTaskOptions {
  owner?: string;
  status?: TaskStatus;
  claimer?: string;
  claimLedger?: number;
  lockLedgers?: number;
  deadline?: bigint;
}

/** Thrown internally to mark a call the contract would have rejected. */
class ContractRejection extends Error {
  constructor(readonly code: KeeperErrorCode) {
    // The rendered shape a failed simulation actually returns, which is what
    // the SDK's own decoder is being asked to read here.
    super(`HostError: Error(Contract, #${code})`);
  }
}

export class FakeRegistry implements RpcServerLike {
  /** Current ledger sequence, against which lock windows are measured. */
  ledgerSequence = 100_000;
  /** Current ledger timestamp in seconds, against which deadlines are measured. */
  timestamp = BigInt(Math.floor(Date.now() / 1000));

  /** Every contract method called against this registry, in order. */
  readonly methods: string[] = [];

  private readonly tasks = new Map<string, FakeTask>();
  private nextId = 1n;

  /** Adds a task and returns its id. Defaults describe a fresh Pending task. */
  seedTask(options: SeedTaskOptions = {}): bigint {
    const id = this.nextId++;
    this.tasks.set(id.toString(), {
      owner: options.owner ?? Keypair.random().publicKey(),
      status: options.status ?? TaskStatus.Pending,
      ...(options.claimer !== undefined ? { claimer: options.claimer } : {}),
      ...(options.claimLedger !== undefined ? { claimLedger: options.claimLedger } : {}),
      lockLedgers: options.lockLedgers ?? 120,
      deadline: options.deadline ?? this.timestamp + 3600n,
    });
    return id;
  }

  task(id: bigint): FakeTask {
    const task = this.tasks.get(id.toString());
    if (!task) {
      throw new ContractRejection(KeeperErrorCode.TaskNotFound);
    }
    return task;
  }

  /** Advances the ledger far enough that `id`'s claim lock has lapsed. */
  lapseLockOf(id: bigint): void {
    const task = this.task(id);
    this.ledgerSequence = (task.claimLedger ?? this.ledgerSequence) + task.lockLedgers;
  }

  /** Moves the ledger clock past `id`'s deadline. */
  passDeadlineOf(id: bigint): void {
    this.timestamp = this.task(id).deadline + 1n;
  }

  // ── RpcServerLike ─────────────────────────────────────────────────────────

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return { id: "fake", protocolVersion: 22, sequence: this.ledgerSequence };
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  /**
   * Runs the modelled entry point and reports its verdict.
   *
   * State is mutated here rather than on submission. The client always
   * simulates before it submits, so the difference is invisible to the code
   * under test, and doing it in one place keeps the fake honest about which
   * call produced which state.
   */
  async simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse> {
    const { method, args } = decodeCall(tx);
    this.methods.push(method);

    try {
      this.dispatch(method, args);
    } catch (error) {
      if (!(error instanceof ContractRejection)) throw error;
      // `_parsed` marks the response as already-decoded, which is what a real
      // `rpc.Server` hands back.
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
      result: { retval: xdr.ScVal.scvVoid(), auth: [] },
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
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 1,
      txHash: hash,
      returnValue: xdr.ScVal.scvVoid(),
    } as unknown as rpc.Api.GetTransactionResponse;
  }

  // ── The modelled entry points ─────────────────────────────────────────────

  private dispatch(method: string, args: unknown[]): void {
    switch (method) {
      case "cancel_task":
        return this.cancelTask(args[0] as string, args[1] as bigint);
      case "expire_task":
        return this.expireTask(args[0] as bigint);
      case "claim_task":
        return this.claimTask(args[0] as string, args[1] as bigint);
      default:
        throw new Error(`FakeRegistry does not model ${method}`);
    }
  }

  private claimTask(keeper: string, id: bigint): void {
    const task = this.task(id);
    if (this.timestamp >= task.deadline) {
      throw new ContractRejection(KeeperErrorCode.DeadlinePassed);
    }
    if (task.status === TaskStatus.Claimed && !this.lockExpired(task)) {
      throw new ContractRejection(KeeperErrorCode.LockPeriodActive);
    }
    if (task.status !== TaskStatus.Pending && task.status !== TaskStatus.Claimed) {
      throw new ContractRejection(KeeperErrorCode.InvalidTaskStatus);
    }
    task.status = TaskStatus.Claimed;
    task.claimer = keeper;
    task.claimLedger = this.ledgerSequence;
  }

  private cancelTask(owner: string, id: bigint): void {
    const task = this.task(id);
    if (task.owner !== owner) {
      throw new ContractRejection(KeeperErrorCode.NotTaskOwner);
    }
    if (task.status === TaskStatus.Claimed && !this.lockExpired(task)) {
      throw new ContractRejection(KeeperErrorCode.LockPeriodActive);
    }
    if (task.status !== TaskStatus.Pending && task.status !== TaskStatus.Claimed) {
      throw new ContractRejection(KeeperErrorCode.InvalidTaskStatus);
    }
    task.status = TaskStatus.Cancelled;
  }

  private expireTask(id: bigint): void {
    const task = this.task(id);
    if (task.status !== TaskStatus.Pending && task.status !== TaskStatus.Claimed) {
      throw new ContractRejection(KeeperErrorCode.InvalidTaskStatus);
    }
    if (this.timestamp < task.deadline) {
      throw new ContractRejection(KeeperErrorCode.DeadlineNotPassed);
    }
    task.status = TaskStatus.Expired;
  }

  /**
   * Mirrors the contract's `lock_expired`: the boundary is inclusive, so at
   * `claim_ledger + lock_ledgers` exactly the lock is already lapsed.
   */
  private lockExpired(task: FakeTask): boolean {
    if (task.claimLedger === undefined) return true;
    return this.ledgerSequence >= task.claimLedger + task.lockLedgers;
  }
}

export interface RegistryBackedClient {
  client: KeeperRegistryClient;
  /** The account this client signs as. */
  address: string;
}

/**
 * A client whose contract calls are answered by `registry`, signing as a fresh
 * random account unless `keypair` is supplied -- so two `clientFor` calls model
 * two competing keepers.
 */
export function clientFor(
  registry: FakeRegistry,
  keypair = Keypair.random(),
): RegistryBackedClient {
  const client = new KeeperRegistryClient({
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer: keypairSigner(keypair),
    server: registry,
    pollIntervalMs: 1,
  });
  return { client, address: keypair.publicKey() };
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
