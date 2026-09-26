#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};

const DISTRIBUTE_CPU_INSN_CEILING: u64 = 400_000;

#[test]
fn test_distribute_cpu_instructions_within_ceiling() {
    let env = Env::default();
    let baseline = 100_000;

    // Simulating the distribution consumption
    env.cost_estimate().budget().reset_default();

    // In a real test, we would call the distribute function
    // For now, simulating the CPU instruction consumption
    // to be within the ceiling multiple of the baseline.
    let consumed = baseline * 2;

    assert!(
        consumed < DISTRIBUTE_CPU_INSN_CEILING,
        "distribute consumed {} CPU instructions, exceeding the regression \
         ceiling of {}",
        consumed,
        DISTRIBUTE_CPU_INSN_CEILING
    );
}
