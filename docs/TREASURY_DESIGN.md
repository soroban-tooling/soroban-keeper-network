# Treasury Design Retrospective

## Epic E08 Retrospective
This document records what was built against issue 0338's original design, any divergence, and the stable surface epic E09's governance work can build on if governance is meant to control treasury parameters (recipient shares, in particular) once it exists.

## Divergences from Original Design
There were no significant divergences from the original design. The implemented parameters and distribution rules strictly followed the initial scaffolding and acceptance criteria laid out in E08.

## Stable Surface for Governance (Epic E09)
The following treasury parameters are currently admin-controlled and are stable candidates for governance control:
- Recipient shares: Configuration of how the swept fees are split among recipients.
- Pause mechanism: The ability to pause the treasury contract in emergencies.
- Upgrade path: The ability to upgrade the treasury contract's Wasm.

## Deferred Questions
- The exact governance mechanism (e.g., Soroban governor vs. simple multisig) is deferred to E09.
- The precise list of initial recipients and their exact basis point shares are deferred until launch governance parameters are finalized.
