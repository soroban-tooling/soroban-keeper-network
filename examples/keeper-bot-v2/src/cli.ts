/**
 * CLI inspection commands for keeper-bot-v2 operators.
 *
 * Provides read-only visibility into keeper status, reputation, and governance
 * proposals. Note: voting decisions are strictly left to the operator and are
 * never executed automatically by the bot.
 */

export interface ProposalSummary {
  id: bigint | number | string;
  proposer?: string;
  action?: unknown;
  eta?: bigint | number;
  status: string | number;
  hasVoted: boolean;
  vote?: unknown;
}

export interface GovernanceClientLike {
  getOpenProposals?: (operatorAddress?: string) => Promise<unknown[]>;
  listOpenProposals?: (operatorAddress?: string) => Promise<unknown[]>;
  listProposals?: () => Promise<unknown[]>;
  getProposals?: () => Promise<unknown[]>;
  proposals?: (() => Promise<unknown[]>) | unknown[] | Map<unknown, unknown>;
  proposalCount?: () => Promise<number | bigint>;
  getProposalCount?: () => Promise<number | bigint>;
  getProposal?: (id: number | bigint | string) => Promise<unknown>;
  hasVoted?: (id: number | bigint | string, address: string) => Promise<boolean> | boolean;
  has_voted?: (id: number | bigint | string, address: string) => Promise<boolean> | boolean;
  getVote?: (id: number | bigint | string, address: string) => Promise<unknown>;
  get_vote?: (id: number | bigint | string, address: string) => Promise<unknown>;
  keeperReputation?: (keeperAddress: string) => Promise<number>;
  governance?: GovernanceClientLike;
  [key: string]: unknown;
}

/**
 * Determines whether a proposal is open (active/pending voting).
 */
export function isOpenProposal(status: string | number | undefined): boolean {
  if (status === undefined || status === null) return true;
  if (typeof status === "number") {
    // 0: Pending, 1: Active in Soroban governance ProposalStatus enum
    return status === 1 || status === 0;
  }
  const s = String(status).toLowerCase();
  return s === "active" || s === "open" || s === "pending";
}

export class Cli {
  /**
   * Inspects a keeper's reputation and checks proximity to the eligibility floor.
   */
  public async inspectKeeper(
    client: GovernanceClientLike,
    keeperAddress: string,
    minEligibilityFloor?: number,
  ): Promise<void> {
    if (typeof client.keeperReputation !== "function") {
      throw new Error("Client does not support keeperReputation view.");
    }
    const reputation = await client.keeperReputation(keeperAddress);
    console.log(`Keeper reputation: ${reputation}`);

    if (minEligibilityFloor !== undefined && reputation <= minEligibilityFloor + 10) {
      console.warn(
        `Warning: Reputation (${reputation}) is near or below the eligibility floor (${minEligibilityFloor}).`,
      );
    }
  }

  /**
   * Lists open governance proposals and whether the operator's configured address has voted.
   *
   * This is read-only visibility; the bot does not vote automatically on the operator's
   * behalf, since a voting decision should not be delegated to an automated keeper
   * process without the operator's explicit, per-proposal action.
   */
  public async listOpenProposals(
    client: GovernanceClientLike,
    operatorAddress?: string,
  ): Promise<ProposalSummary[]> {
    const govClient = client?.governance ?? client;
    let rawProposals: unknown[] = [];
    let alreadyFiltered = false;

    if (typeof govClient.getOpenProposals === "function") {
      rawProposals = await govClient.getOpenProposals(operatorAddress);
      alreadyFiltered = true;
    } else if (
      typeof govClient.listOpenProposals === "function" &&
      govClient !== this
    ) {
      rawProposals = await govClient.listOpenProposals(operatorAddress);
      alreadyFiltered = true;
    } else if (typeof govClient.listProposals === "function") {
      rawProposals = await govClient.listProposals();
    } else if (typeof govClient.getProposals === "function") {
      rawProposals = await govClient.getProposals();
    } else if (typeof govClient.proposals === "function") {
      rawProposals = await govClient.proposals();
    } else if (Array.isArray(govClient.proposals)) {
      rawProposals = govClient.proposals;
    } else if (govClient.proposals instanceof Map) {
      rawProposals = Array.from(govClient.proposals.values());
    } else if (
      typeof govClient.proposalCount === "function" ||
      typeof govClient.getProposalCount === "function"
    ) {
      const countFn = govClient.proposalCount ?? govClient.getProposalCount;
      const count = Number(await countFn.call(govClient));
      for (let i = 1; i <= count; i++) {
        try {
          if (typeof govClient.getProposal === "function") {
            const p = await govClient.getProposal(i);
            if (p) rawProposals.push(p);
          }
        } catch {
          // ignore missing proposal lookups
        }
      }
    } else if (typeof govClient.getProposal === "function") {
      for (let i = 1; i <= 100; i++) {
        try {
          const p = await govClient.getProposal(i);
          if (p) rawProposals.push(p);
          else break;
        } catch {
          break;
        }
      }
    }

    const openProposals = alreadyFiltered
      ? rawProposals
      : rawProposals.filter((p) => {
          const rec = p as Record<string, unknown> | undefined;
          return isOpenProposal(rec?.status as string | number | undefined);
        });

    const summaries: ProposalSummary[] = [];

    for (const raw of openProposals) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const id = (p.id ?? p.proposalId ?? p.proposal_id ?? "unknown") as
        | bigint
        | number
        | string;
      let hasVoted = false;
      let vote: unknown = undefined;

      if (operatorAddress) {
        if (typeof p.hasVoted === "boolean") {
          hasVoted = p.hasVoted;
        } else if (typeof govClient.hasVoted === "function") {
          hasVoted = Boolean(await govClient.hasVoted(id, operatorAddress));
        } else if (typeof govClient.has_voted === "function") {
          hasVoted = Boolean(await govClient.has_voted(id, operatorAddress));
        } else if (typeof govClient.getVote === "function") {
          try {
            vote = await govClient.getVote(id, operatorAddress);
            hasVoted = vote !== undefined && vote !== null;
          } catch {
            hasVoted = false;
          }
        } else if (typeof govClient.get_vote === "function") {
          try {
            vote = await govClient.get_vote(id, operatorAddress);
            hasVoted = vote !== undefined && vote !== null;
          } catch {
            hasVoted = false;
          }
        } else if (p.votes instanceof Map) {
          hasVoted = p.votes.has(operatorAddress);
          vote = p.votes.get(operatorAddress);
        } else if (p.votes && typeof p.votes === "object") {
          const vMap = p.votes as Record<string, unknown>;
          hasVoted = operatorAddress in vMap;
          vote = vMap[operatorAddress];
        } else if (Array.isArray(p.voters)) {
          hasVoted = p.voters.includes(operatorAddress);
        }
      }

      summaries.push({
        id,
        proposer: p.proposer as string | undefined,
        action: p.action,
        eta: p.eta as bigint | number | undefined,
        status: (p.status ?? "unknown") as string | number,
        hasVoted,
        vote,
      });
    }

    console.log(`=== Open Governance Proposals (${summaries.length}) ===`);
    if (summaries.length === 0) {
      console.log("No open proposals found.");
    } else {
      for (const s of summaries) {
        const actionStr = s.action
          ? typeof s.action === "object"
            ? JSON.stringify(s.action)
            : String(s.action)
          : "N/A";
        const votedStr = operatorAddress
          ? s.hasVoted
            ? "Yes"
            : "No"
          : "Unknown (no operator address provided)";
        console.log(`Proposal #${s.id}:`);
        if (s.proposer) console.log(`  Proposer: ${s.proposer}`);
        console.log(`  Status: ${s.status}`);
        console.log(`  Action: ${actionStr}`);
        if (s.eta !== undefined) console.log(`  ETA: ${s.eta}`);
        console.log(`  Operator Voted: ${votedStr}`);
      }
    }

    return summaries;
  }

  /**
   * Inspection command alias for listOpenProposals.
   */
  public async inspectProposals(
    client: GovernanceClientLike,
    operatorAddress?: string,
  ): Promise<ProposalSummary[]> {
    return this.listOpenProposals(client, operatorAddress);
  }
}
