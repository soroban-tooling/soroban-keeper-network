/**
 * A stand-in Soroban RPC server.
 *
 * The client takes its RPC server as an injected dependency precisely so the
 * SDK's own behaviour -- argument encoding, local pre-checks, error typing,
 * return decoding -- can be tested without a network. What is deliberately not
 * faked is the encoding itself: arguments go through the real `nativeToScVal`
 * and results come back through the real `scValToNative`, so a test that
 * asserts on a decoded argument is asserting on the bytes that would have gone
 * on-chain.
 */

import {
  Account,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { RpcServerLike } from "../../src/client.js";

/** One recorded contract call: the entry point and its decoded arguments. */
export interface RecordedCall {
  method: string;
  args: unknown[];
  /** Raw ScVal arguments, for tests that care about the wire type. */
  rawArgs: xdr.ScVal[];
}

export interface FakeRpcOptions {
  /** Return value per entry point. A function receives the decoded arguments. */
  results?: Record<string, unknown | ((args: unknown[]) => unknown)>;
  /** Entry points that fail at simulation, with the RPC's rendered message. */
  simulationErrors?: Record<string, string>;
  /**
   * Entry points whose transaction is submitted but fails on-chain, given as
   * the contract error code carried in the diagnostic events.
   */
  onChainFailures?: Record<string, number>;
  /** Statuses returned by `getTransaction`, in order, before the final one. */
  pendingPolls?: number;
}

export class FakeRpc implements RpcServerLike {
  readonly calls: RecordedCall[] = [];
  readonly submitted: string[] = [];
  private polls = 0;

  constructor(private readonly options: FakeRpcOptions = {}) {}

  /** The single call made, asserting that exactly one was made. */
  get onlyCall(): RecordedCall {
    if (this.calls.length !== 1) {
      throw new Error(`expected exactly one contract call, saw ${this.calls.length}`);
    }
    return this.calls[0] as RecordedCall;
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  async simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse> {
    const call = record(tx);
    this.calls.push(call);

    const error = this.options.simulationErrors?.[call.method];
    if (error !== undefined) {
      // `_parsed` marks the response as already-decoded, which is what a real
      // `rpc.Server` hands back; without it the SDK would re-parse it as a raw
      // JSON-RPC payload.
      return { _parsed: true, id: "1", latestLedger: 1, error, events: [] } as unknown as
        rpc.Api.SimulateTransactionResponse;
    }

    return {
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      result: { retval: toScVal(this.resultFor(call)), auth: [] },
    } as unknown as rpc.Api.SimulateTransactionResponse;
  }

  async sendTransaction(tx: {
    hash: () => Buffer;
  }): Promise<rpc.Api.SendTransactionResponse> {
    this.submitted.push(tx.hash().toString("hex"));
    return {
      status: "PENDING",
      hash: tx.hash().toString("hex"),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    } as rpc.Api.SendTransactionResponse;
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    if (this.polls < (this.options.pendingPolls ?? 0)) {
      this.polls += 1;
      return {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1,
        latestLedgerCloseTime: 1,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
        txHash: hash,
      } as rpc.Api.GetTransactionResponse;
    }

    const call = this.calls[this.calls.length - 1] as RecordedCall;
    const failure = this.options.onChainFailures?.[call.method];
    if (failure !== undefined) {
      return {
        status: rpc.Api.GetTransactionStatus.FAILED,
        latestLedger: 1,
        txHash: hash,
        diagnosticEventsXdr: [contractErrorEvent(failure)],
      } as unknown as rpc.Api.GetTransactionResponse;
    }

    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 1,
      txHash: hash,
      returnValue: toScVal(this.resultFor(call)),
    } as unknown as rpc.Api.GetTransactionResponse;
  }

  private resultFor(call: RecordedCall): unknown {
    const configured = this.options.results?.[call.method];
    return typeof configured === "function"
      ? (configured as (args: unknown[]) => unknown)(call.args)
      : configured;
  }
}

/** Pulls the entry point and arguments back out of a built transaction. */
function record(tx: unknown): RecordedCall {
  const operation = (tx as { operations: { func: xdr.HostFunction }[] }).operations[0];
  const invocation = (operation as { func: xdr.HostFunction }).func.invokeContract();
  const rawArgs = invocation.args();
  return {
    method: invocation.functionName().toString(),
    args: rawArgs.map((arg) => scValToNative(arg)),
    rawArgs,
  };
}

function toScVal(value: unknown): xdr.ScVal {
  if (value === undefined) return xdr.ScVal.scvVoid();
  if (value === null) return xdr.ScVal.scvVoid();
  if (value instanceof xdr.ScVal) return value;
  return nativeToScVal(value);
}

/**
 * A diagnostic event carrying `Error(Contract, #code)` -- the shape a
 * transaction that fails on-chain actually returns, as opposed to the rendered
 * string a failed simulation returns.
 */
function contractErrorEvent(code: number): xdr.DiagnosticEvent {
  // js-xdr generates union constructors dynamically, so their declared types
  // take no arguments; the runtime shape is `new Union(switchValue, arm)`.
  const ContractEventBody = xdr.ContractEventBody as unknown as new (
    switchValue: number,
    value: xdr.ContractEventV0,
  ) => xdr.ContractEventBody;
  const ExtensionPoint = xdr.ExtensionPoint as unknown as new (
    switchValue: number,
  ) => xdr.ExtensionPoint;

  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
}
