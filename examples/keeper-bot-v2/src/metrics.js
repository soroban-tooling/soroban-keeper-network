"use strict";

/**
 * Operational metrics collector for Keeper Bot v2.
 * Tracks per-round and cumulative counters, with fine-grained breakdown
 * for skip reasons (lost races, spend ceiling backstop, unprofitability, etc.).
 */
class MetricsCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.cumulative = {
      roundsTotal: 0,
      tasksEvaluated: 0,
      tasksClaimed: 0,
      tasksExecuted: 0,
      totalSpendStroops: 0n,
      spendCeilingHits: 0,
      lostClaimRaces: 0,
      skipsByReason: {},
      errors: 0,
    };
    this.currentRound = this._initRound();
  }

  _initRound() {
    return {
      tasksEvaluated: 0,
      tasksClaimed: 0,
      tasksExecuted: 0,
      roundSpendStroops: 0n,
      spendCeilingReached: false,
      skipsByReason: {},
      errors: [],
    };
  }

  startRound() {
    this.cumulative.roundsTotal++;
    this.currentRound = this._initRound();
  }

  recordEvaluated(count = 1) {
    this.currentRound.tasksEvaluated += count;
    this.cumulative.tasksEvaluated += count;
  }

  recordClaimed(_taskId) {
    this.currentRound.tasksClaimed++;
    this.cumulative.tasksClaimed++;
  }

  recordExecuted(_taskId) {
    this.currentRound.tasksExecuted++;
    this.cumulative.tasksExecuted++;
  }

  recordSpend(stroops) {
    const amount = BigInt(stroops);
    this.currentRound.roundSpendStroops += amount;
    this.cumulative.totalSpendStroops += amount;
  }

  recordCeilingHit() {
    this.currentRound.spendCeilingReached = true;
    this.cumulative.spendCeilingHits++;
  }

  recordSkip(reason, _taskId = null) {
    const normalized = String(reason);
    this.currentRound.skipsByReason[normalized] =
      (this.currentRound.skipsByReason[normalized] || 0) + 1;
    this.cumulative.skipsByReason[normalized] =
      (this.cumulative.skipsByReason[normalized] || 0) + 1;

    if (normalized === "lost_claim_race") {
      this.cumulative.lostClaimRaces++;
    }
  }

  recordError(err) {
    this.currentRound.errors.push(err);
    this.cumulative.errors++;
  }

  getSnapshot() {
    return {
      round: {
        ...this.currentRound,
        roundSpendStroops: this.currentRound.roundSpendStroops.toString(),
      },
      cumulative: {
        ...this.cumulative,
        totalSpendStroops: this.cumulative.totalSpendStroops.toString(),
      },
    };
  }
}

const defaultMetrics = new MetricsCollector();

module.exports = {
  MetricsCollector,
  metrics: defaultMetrics,
};
