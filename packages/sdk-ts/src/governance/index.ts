/**
 * Typed Governance client for the Soroban Keeper Network.
 */

export { GovernanceClient, keypairSigner } from "./client.js";
export type {
  GovernanceClientOptions,
  InitializeParams,
  CreateProposalParams,
  VoteParams,
  ExecuteProposalParams,
  RpcServerLike,
  TransactionSigner,
} from "./client.js";

export {
  GovernanceContractError,
  GovernanceErrorCode,
  GovernanceRpcError,
  GovernanceSdkError,
  decodeGovernanceErrorCode,
  isGovernanceError,
  toGovernanceError,
} from "./errors.js";

export {
  ProposalStatus,
  VoteType,
} from "./types.js";
export type {
  GovernableAction,
  Proposal,
} from "./types.js";

export {
  actionToScVal,
  addressArg,
  decodeAction,
  i128Arg,
  scValToProposal,
  toBigInt,
  u32Arg,
  u64Arg,
} from "./scval.js";
export type { IntegerInput } from "./scval.js";
