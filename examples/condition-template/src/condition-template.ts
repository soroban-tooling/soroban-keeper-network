export interface ConditionState {
  threshold: bigint;
  currentValue: bigint;
}

export class ConditionTemplateClient {
  private conditions = new Map<string, ConditionState>();

  setTaskThreshold(taskId: bigint, threshold: bigint): void {
    const existing = this.conditions.get(taskId.toString()) || {
      threshold: 0n,
      currentValue: 0n,
    };
    existing.threshold = threshold;
    this.conditions.set(taskId.toString(), existing);
  }

  updateMetricValue(taskId: bigint, value: bigint): void {
    const existing = this.conditions.get(taskId.toString()) || {
      threshold: 0n,
      currentValue: 0n,
    };
    existing.currentValue = value;
    this.conditions.set(taskId.toString(), existing);
  }

  /**
   * Implements ITaskCondition::is_met(env, task_id) -> bool
   * Called on-chain by Keeper Registry's `claim_task`.
   */
  isMet(taskId: bigint): boolean {
    const state = this.conditions.get(taskId.toString());
    if (!state) {
      return false;
    }
    return state.currentValue >= state.threshold;
  }
}
