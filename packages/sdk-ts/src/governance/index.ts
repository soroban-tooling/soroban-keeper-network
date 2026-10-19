/**
 * `@soroban-keeper-network/sdk/governance` -- a typed client for the governance
 * contract (`contracts/governance`).
 */

export {
  GovernanceClient,
  keypairSigner,
  type CancelProposalParams,
  type CreateProposalParams,
  type EvaluateProposalParams,
  type ExecuteProposalParams,
  type GovernanceClientOptions,
  type InitializeParams,
  type QueueProposalParams,
  type RpcServerLike,
  type SignedCallOptions,
  type TransactionSigner,
  type VoteParams,
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

export type { IntegerInput } from "./scval.js";
export {
  VoteChoice,
  type GovernableAction,
  type GovernanceClientConfig,
  type Proposal,
  type ProposalStatus,
  type VoteRecord,
} from "./types.js";
