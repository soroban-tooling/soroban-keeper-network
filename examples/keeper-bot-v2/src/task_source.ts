import type { ConditionNotMetEvent } from "@soroban-keeper-network/sdk";

export interface ClaimabilityClient {
  isClaimable(taskId: bigint): Promise<boolean>;
}

export interface TaskCandidate {
  taskId: bigint;
}

export interface ConditionAwareTaskSourceOptions {
  conditionBackoffMs: number;
  now?: () => number;
}

/**
 * Pre-filters candidates with the registry's condition-aware `is_claimable`
 * view and schedules rejected tasks for a targeted later check.
 */
export class ConditionAwareTaskSource {
  private readonly deferredUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly registry: ClaimabilityClient,
    private readonly options: ConditionAwareTaskSourceOptions,
  ) {
    if (!Number.isSafeInteger(options.conditionBackoffMs) || options.conditionBackoffMs <= 0) {
      throw new Error("conditionBackoffMs must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  /** Records the on-chain rejection signal without permanently excluding the task. */
  observeConditionNotMet(event: ConditionNotMetEvent): void {
    this.defer(BigInt(event.taskId));
  }

  /** Returns candidates that are currently claimable and therefore safe to submit. */
  async claimableCandidates<T extends TaskCandidate>(candidates: readonly T[]): Promise<T[]> {
    const now = this.now();
    const claimable: T[] = [];
    for (const candidate of candidates) {
      const key = candidate.taskId.toString();
      const retryAt = this.deferredUntil.get(key);
      if (retryAt !== undefined && retryAt > now) {
        continue;
      }

      if (retryAt !== undefined) {
        this.deferredUntil.delete(key);
      }

      if (!(await this.registry.isClaimable(candidate.taskId))) {
        this.defer(candidate.taskId, now);
        continue;
      }

      this.deferredUntil.delete(key);
      claimable.push(candidate);
    }

    return claimable;
  }

  nextCheckAt(taskId: bigint): number | undefined {
    return this.deferredUntil.get(taskId.toString());
  }

  private defer(taskId: bigint, now = this.now()): void {
    this.deferredUntil.set(taskId.toString(), now + this.options.conditionBackoffMs);
  }
}
