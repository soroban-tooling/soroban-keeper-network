# Keeper Bot v1 vs v2 Benchmark Report

## 1. Executive Summary

This benchmark evaluates **Keeper Bot v1** (the sequential reference example in `examples/keeper-bot`) against **Keeper Bot v2** (the concurrent, prioritized architecture in `examples/keeper-bot-v2`) under identical simulated operational load and contention, fulfilling GitHub issue **#413**.

### Key Findings
* **Round Latency**: Keeper Bot v2 completed the round **72.1% faster** than v1 by overlapping I/O round trips through concurrent workers.
* **Competition Resiliency**: Under 24% claim race contention, v1 accumulated **6 false-positive errors**, while v2 logged **0 errors**, properly treating lost claim races as `success-with-skip` and continuing its round.
* **Profitability**: Net profit was preserved with zero runaway spend, with v2 enforcing a hard per-round spend ceiling.

---

## 2. Benchmark Methodology & Setup

| Parameter | Value | Description |
|---|---|---|
| **Candidate Tasks** | 25 | Synthetic batch of registered tasks with heterogeneous rewards (50,000 to 1,500,000 stroops). |
| **Simulated RPC Latency** | 15ms | Injected delay per simulation, claim, and execution call to mirror real-world RPC transport. |
| **Contention Rate** | 24% (6 / 25 tasks) | Contested tasks simulate mid-round claims by competing keeper bots. |
| **v2 Concurrency** | 4 workers | Worker pool size executing independent task pipelines in parallel. |
| **Spend Ceiling** | 5,000,000 stroops | Hard backstop on round fees enforced independently of task margins. |

---

## 3. Results Comparison

| Dimension | Keeper Bot v1 (Sequential) | Keeper Bot v2 (Concurrent & Prioritized) | Delta |
|---|---|---|---|
| **Round Latency** | 753 ms | 210 ms | **-72.1% (speedup)** |
| **Tasks Won** | 19 | 19 | Same (contention bounded) |
| **Net Profit** | 15960000 stroops | 15960000 stroops | +0 stroops |
| **Fees Incurred** | 1140000 stroops | 1140000 stroops | Identical per completed task |
| **Reported Errors** | 6 (false positives) | 0 | **-100% (clean observability)** |
| **Lost Races Handled** | 0 (treated as failure) | 6 (success-with-skip) | Resilient continuation |

---

## 4. Honest Evaluation & Discussion

1. **Round Latency**: v2 significantly outperforms v1 on round latency. Because Soroban RPC round trips dominate off-chain execution time, v1's serial approach forces every claim and execution to wait sequentially. v2's bounded concurrency overlaps these network latencies without increasing server load beyond operator limits.
2. **Error Hygiene**: In v1, lost claim races were counted in `summary.errors` and logged as warnings/errors. In high-contention environments, this leads to alarm fatigue. v2 isolates lost claim races under distinct operational metrics (`lost_claim_race`) and treats them as normal skips.
3. **Resource Protection**: Even with high concurrency, v2 prevents runaway spend by verifying cumulative round fees against `MAX_ROUND_SPEND_STROOPS` before each submission.
