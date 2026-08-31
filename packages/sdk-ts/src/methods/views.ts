/**
 * Contract-level read-only views: the registry's own configuration, as opposed
 * to the per-task views.
 *
 * All of these are simulated, never submitted, so they cost nothing and need
 * no signer or funded account. They also mirror the contract's own policy that
 * a view never errors on an unconfigured registry (see the note above the views
 * in `contracts/keeper-registry/src/views.rs`): probing a fresh deployment
 * returns "no admin configured", "not paused", "zero fees", not a failure.
 */

import { SUPPORTED_CONTRACT_VERSIONS } from "../constants.js";
import type { ContractCaller } from "../core/caller.js";

/**
 * The registry's admin address, or `undefined` if `initialize` has never run.
 *
 * The contract returns `Option<Address>`, and an uninitialized registry is a
 * legitimate, answerable state rather than an error -- so this returns
 * `undefined` instead of throwing, and a caller can distinguish "not
 * configured" from "configured as someone else" without a try/catch.
 */
export async function admin(caller: ContractCaller): Promise<string | undefined> {
  return optional(await caller.read<string | null | undefined>("admin"));
}

/**
 * The protocol fee in basis points withheld from each executed task's reward.
 *
 * `u32`, so a plain `number` per the SDK's numeric convention (backlog issue
 * 0165). An unconfigured registry reports the contract's own default.
 */
export async function getFeeBps(caller: ContractCaller): Promise<number> {
  return Number(await caller.read<number | bigint>("get_fee_bps"));
}

/** Whether the admin has paused the registry's state-changing entry points. */
export async function isPaused(caller: ContractCaller): Promise<boolean> {
  return Boolean(await caller.read<boolean>("is_paused"));
}

/**
 * Protocol fees withheld and awaiting `sweep_fees`, in the reward token's own
 * units. `i128`, so `bigint`.
 */
export async function feesAccrued(caller: ContractCaller): Promise<bigint> {
  return BigInt(await caller.read<bigint | number>("fees_accrued"));
}

/**
 * The token contract rewards are escrowed in, or `undefined` on an
 * uninitialized registry -- same `Option` handling as {@link admin}.
 */
export async function rewardTokenAddress(
  caller: ContractCaller,
): Promise<string | undefined> {
  return optional(await caller.read<string | null | undefined>("reward_token_address"));
}

/**
 * The smallest reward a task may be registered with, in the reward token's own
 * units. `0n` when the admin has not set a floor. `i128`, so `bigint`.
 */
export async function minReward(caller: ContractCaller): Promise<bigint> {
  return BigInt(await caller.read<bigint | number>("min_reward"));
}

// -- version and compatibility ------------------------------------------------

/** How the deployed contract's `VERSION` relates to this SDK's supported range. */
export type CompatibilityStatus = "compatible" | "contract-older" | "contract-newer";

export interface ContractCompatibility {
  /** `VERSION` as reported by the deployed contract. */
  contractVersion: number;
  /** The range this SDK release was built and tested against, inclusive. */
  supported: { min: number; max: number };
  status: CompatibilityStatus;
  /**
   * A ready-to-log explanation when `status` is not `"compatible"`, and
   * `undefined` when it is.
   */
  warning?: string;
}

/**
 * Reads the deployed contract's `VERSION` and compares it against the range
 * this SDK release supports, without emitting anything.
 *
 * Use this when you want to decide for yourself -- gate a feature, fail a
 * deployment check, surface a banner. {@link version} is the same read with the
 * warning already routed to the client's log sink.
 */
export async function checkContractCompatibility(
  caller: ContractCaller,
): Promise<ContractCompatibility> {
  const contractVersion = Number(await caller.read<number | bigint>("version"));
  const supported = { ...SUPPORTED_CONTRACT_VERSIONS };

  if (contractVersion < supported.min) {
    return {
      contractVersion,
      supported,
      status: "contract-older",
      warning:
        `The deployed keeper-registry reports VERSION ${contractVersion}, older than the ` +
        `oldest this SDK supports (${supported.min}). Entry points this SDK calls may not ` +
        `exist on that deployment. Pin an older SDK release, or upgrade the contract.`,
    };
  }
  if (contractVersion > supported.max) {
    return {
      contractVersion,
      supported,
      status: "contract-newer",
      warning:
        `The deployed keeper-registry reports VERSION ${contractVersion}, newer than the ` +
        `newest this SDK was built against (${supported.max}). Calls should still work -- ` +
        `contract versions are additive -- but new entry points, fields, and error codes ` +
        `will be missing from this SDK. Upgrade @soroban-keeper-network/sdk.`,
    };
  }
  return { contractVersion, supported, status: "compatible" };
}

/** Clients already warned about a given contract version, to avoid log spam. */
const warned = new WeakMap<ContractCaller, Set<number>>();

export interface VersionOptions {
  /**
   * Emit the compatibility warning through the client's `warn` sink when the
   * deployed version is outside this SDK's supported range. Default `true`.
   *
   * The warning is emitted at most once per client per distinct version, so a
   * keeper bot that polls `version()` does not fill its log with the same line.
   */
  warnOnMismatch?: boolean;
}

/**
 * The deployed contract's logic version, with an SDK compatibility check.
 *
 * A version outside this SDK's supported range warns rather than throws. A
 * newer contract is normally additive, and a client library that refuses to
 * run against it strands every integrator on the day the contract is upgraded,
 * which is a worse failure than calls that quietly do not use the new surface.
 * Callers that want to decide for themselves use
 * {@link checkContractCompatibility}.
 */
export async function version(
  caller: ContractCaller,
  options: VersionOptions = {},
): Promise<number> {
  const compatibility = await checkContractCompatibility(caller);

  if (compatibility.warning && options.warnOnMismatch !== false) {
    let seen = warned.get(caller);
    if (!seen) {
      seen = new Set();
      warned.set(caller, seen);
    }
    if (!seen.has(compatibility.contractVersion)) {
      seen.add(compatibility.contractVersion);
      caller.warn(compatibility.warning);
    }
  }

  return compatibility.contractVersion;
}

/**
 * Soroban's `Option::None` decodes to `null` through `scValToNative`. The SDK
 * surfaces one absent value, `undefined`, so callers are not left checking for
 * two.
 */
function optional(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
// Read-only view methods. Scoped here to just `getTask`, the one this
// epic's assigned issues (React `useTask`/`useTaskEvents` hooks) actually
// need — `taskCount`/`keeperBalance`/`isClaimable` are backlog 0163's
// remaining scope, left for that issue's own implementation.

import { nativeToScVal } from "@stellar/stellar-sdk";

import type { ContractInvoker } from "../core/contractInvoker";
import { type Task, TaskStatus, TaskType } from "../types";

/**
 * Raw shape `scValToNative` produces for the contract's `Task` struct:
 * `soroban_sdk` maps Rust struct field symbols verbatim, so this comes back
 * snake_case (confirmed against `examples/keeper-bot/index.js`'s
 * `fullTask.task_type` access — a real, working call site, not assumed) —
 * `getTask` remaps it to the camelCase {@link Task} shape the rest of this
 * SDK uses. Optional fields absent on-chain (`claimer`, `claim_ledger` for
 * a still-`Pending` task) come back `undefined` from `scValToNative`'s
 * handling of Soroban's `Option<T>`, matching this interface directly.
 */
interface RawTask {
  owner: string;
  task_type: number;
  calldata: Uint8Array;
  reward: bigint;
  deadline: bigint;
  ttl_ledgers: number;
  status: number;
  claimer: string | undefined;
  claim_ledger: number | undefined;
  lock_ledgers: number;
}

function toTask(raw: RawTask): Task {
  return {
    owner: raw.owner,
    taskType: raw.task_type as TaskType,
    calldata: raw.calldata,
    reward: raw.reward,
    // CONVENTIONS.md: `deadline` is a `number` at this SDK's boundary even
    // though the contract stores it as `u64` — a Unix-seconds timestamp is
    // nowhere near `Number.MAX_SAFE_INTEGER`, and `number` is what every
    // `Date`/polling call site in this epic (`useTask`, the wallet-signing
    // example) actually wants.
    deadline: Number(raw.deadline),
    ttlLedgers: raw.ttl_ledgers,
    status: raw.status as TaskStatus,
    claimer: raw.claimer,
    claimLedger: raw.claim_ledger,
    lockLedgers: raw.lock_ledgers,
  };
}

/**
 * Fetches one task by id. Throws (via the caller's decoded-error handling —
 * see `KeeperRegistryClient.getTask`) if the id has no on-chain record.
 *
 * Read-only view methods take a `sourcePublicKey` because Soroban simulation
 * still requires a source account to exist on-chain (see
 * `ContractInvoker.read`'s doc comment) — any funded account works, it need
 * not be a specific caller's identity.
 */
export async function getTask(
  invoker: ContractInvoker,
  taskId: number,
  readOnlySourceAccount: string | undefined,
  sourcePublicKey?: string,
): Promise<Task> {
  const source = sourcePublicKey ?? readOnlySourceAccount;
  if (!source) {
    throw new Error(
      "getTask requires a source account for simulation. Pass one explicitly " +
        "(getTask(taskId, sourcePublicKey)) or configure " +
        "KeeperRegistryClientConfig.readOnlySourceAccount — see CONVENTIONS.md.",
    );
  }
  const raw = await invoker.read<RawTask>(source, "get_task", [nativeToScVal(taskId, { type: "u64" })]);
  return toTask(raw);
}
