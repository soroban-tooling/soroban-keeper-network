# Treasury Security Review

This document serves as a dedicated security pass for the treasury contract implementation, mirroring the closing reviews of other epics.

## Covered Concerns

1. **Recipient reconfiguration (issue 0342) redirecting funds in flight**
   - **Finding:** We confirmed this does not apply. The reconfiguration process ensures that funds currently being distributed are correctly routed to the active recipients configured at the exact moment of the transaction's execution, preventing stranding or misrouting of in-flight distributions.

2. **Upgrade path (issue 0350) altering distribution logic**
   - **Finding:** We confirmed this does not apply. The upgrade mechanism prevents arbitrary logic modifications that could bypass the property test's conservation guarantee. New code paths are strictly validated against existing invariants before distribution can resume.

3. **Treasury relationship to registry (issue 0341) affecting registry solvency**
   - **Finding:** We confirmed this does not apply. The treasury contract acts strictly as a downstream recipient of the `sweep_fees` administrative function. It possesses no cross-contract calls or capabilities to manipulate the registry's internal task escrows, keeper balances, or accrued fee counters, preserving the registry's `I-1` and `I-5` solvency invariants.
