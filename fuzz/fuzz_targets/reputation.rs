//! Fuzz target for the keeper reputation update and decay arithmetic
//! (backlog issue 0331, following the same reasoning as staking's issue 0306).
//!
//! Two layers are fuzzed from the same input:
//!
//! 1. **Update sequences through the deployed contract.** A fuzzer-chosen
//!    sequence of successful executions, expired-lock takeovers (a missed
//!    claim for the original claimer), ledger advances, and seeded starting
//!    records is driven through `claim_task` / `execute_task`. After every
//!    step, each keeper's stored record is compared against an independent
//!    model, and `effective_reputation` is compared against the decay
//!    function applied to the stored record. A final view-only jump of up to
//!    `MAX_FINAL_JUMP_LEDGERS` then checks decay through the contract itself
//!    across many half-lives.
//! 2. **The decay function across its full input range.** `effective_record`
//!    is called directly with an arbitrary record (any `score_bps`, any
//!    `last_updated_ledger`) and two arbitrary `u32` ledgers, including
//!    ledgers before the last update, which the contract can never observe
//!    but the function must still handle without panicking.
//!
//! Reputation is non-negative by construction (`score_bps` is a `u32`), so
//! "nonsensical" here means: a score above 10,000 bps from a real update, a
//! decayed score above the stored score, a score that increases as more
//! ledgers elapse, or a decayed value that is not the documented
//! `floor(score_bps / 2^halvings)`.
//!
//! ## Seeded records
//!
//! Extreme counts (near `u64::MAX`) are unreachable through real
//! transactions, so the `Seed` step writes a starting record directly into
//! the registry's storage under the same key layout `ReputationKey::Keeper`
//! serializes to (`[Symbol("Keeper"), keeper]`). The seed is immediately
//! read back through `keeper_reputation` and asserted equal, so a future
//! change to that key layout fails this target loudly rather than silently
//! seeding an unrelated entry.
//!
//! ## Why contract-level elapsed ledgers are capped
//!
//! The test `Env` panics when a call touches an archived entry, and keeper
//! balances and the registry instance are only bumped to 100,000 ledgers.
//! Update sequences therefore stay within `MAX_SEQUENCE_ELAPSED_LEDGERS` in
//! total. The wide range is covered by the final jump (the registry instance
//! is extended first, and reputation entries live for 6,300,000 ledgers) and
//! by layer 2, which has no storage at all.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::{
    effective_record, ReputationRecord, TaskType, REPUTATION_DECAY_HALF_LIFE_LEDGERS,
};
use keeper_registry_fuzz::support::RegistryHarness;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, Symbol,
};

/// Keeps each run's contract work bounded.
const MAX_STEPS: usize = 32;
/// Total ledgers an update sequence may advance, kept under the 100,000
/// ledger bump applied to keeper balances and the registry instance.
const MAX_SEQUENCE_ELAPSED_LEDGERS: u32 = 90_000;
/// Largest single `Advance` step.
const MAX_ADVANCE_LEDGERS: u32 = 20_000;
/// Final view-only jump; stays under the 6,300,000 ledger reputation TTL.
const MAX_FINAL_JUMP_LEDGERS: u32 = 6_000_000;
/// Reputation TTL used by the contract, reused when seeding a record.
const REPUTATION_TTL_LEDGERS: u32 = 6_300_000;
const MIN_LOCK_LEDGERS: u32 = 12;
const MAX_LOCK_LEDGERS: u32 = 17_280;
const TASK_TTL_LEDGERS: u32 = 200_000;
const MAX_SCORE_BPS: u32 = 10_000;
const KEEPER_COUNT: usize = 3;

#[derive(Arbitrary, Debug)]
enum Step {
    /// Claim then execute a fresh task: one success for `keeper`.
    Execute { keeper: u8 },
    /// `first` claims, the lock expires exactly at its boundary, and `second`
    /// takes over: one missed claim for `first` (even when `first == second`,
    /// matching `claim_task`). Optionally `second` then executes.
    Takeover {
        first: u8,
        second: u8,
        lock_extra: u16,
        then_execute: bool,
    },
    /// Advance the ledger sequence without any reputation update.
    Advance { ledgers: u32 },
    /// Overwrite a keeper's record with arbitrary (possibly extreme) counts.
    Seed {
        keeper: u8,
        successes: u64,
        missed_claims: u64,
    },
}

#[derive(Arbitrary, Debug)]
struct DecayInput {
    successes: u64,
    missed_claims: u64,
    score_bps: u32,
    last_updated_ledger: u32,
    ledger_a: u32,
    ledger_b: u32,
}

#[derive(Arbitrary, Debug)]
struct ReputationInput {
    decay: DecayInput,
    final_jump: u32,
    /// Last so `arbitrary` fills it from all remaining bytes, giving the
    /// fuzzer long update sequences rather than mostly empty ones.
    steps: Vec<Step>,
}

/// Independent model of the stored record. It only asserts the exact score
/// when `successes + missed_claims` does not overflow `u64`; past that point
/// the contract saturates the action count, which is unreachable through real
/// transactions, so only the bounds are asserted there.
#[derive(Clone, Copy, Debug, Default)]
struct Model {
    successes: u64,
    missed_claims: u64,
    last_updated_ledger: u32,
    touched: bool,
}

impl Model {
    fn apply(&mut self, success: bool, ledger: u32) {
        if success {
            self.successes = self.successes.saturating_add(1);
        } else {
            self.missed_claims = self.missed_claims.saturating_add(1);
        }
        self.last_updated_ledger = ledger;
        self.touched = true;
    }
}

/// Documented score formula, or `None` where the contract saturates.
fn exact_score(successes: u64, missed_claims: u64) -> Option<u32> {
    let actions = successes.checked_add(missed_claims)?;
    if actions == 0 {
        return Some(0);
    }
    Some(((successes as u128 * 10_000) / actions as u128) as u32)
}

/// Documented decay: `floor(score_bps / 2^halvings)`, written as a division
/// rather than the contract's shift so the two formulations check each other.
fn expected_decayed_score(score_bps: u32, last_updated_ledger: u32, current_ledger: u32) -> u32 {
    let elapsed = current_ledger.saturating_sub(last_updated_ledger);
    let halvings = elapsed / REPUTATION_DECAY_HALF_LIFE_LEDGERS;
    if halvings >= 64 {
        0
    } else {
        (score_bps as u128 / (1u128 << halvings)) as u32
    }
}

fn assert_record_matches_model(record: &ReputationRecord, model: &Model) {
    if !model.touched {
        assert_eq!(
            *record,
            ReputationRecord::zero(),
            "a keeper with no tracked actions must have a zero record"
        );
        return;
    }
    assert_eq!(record.successes, model.successes, "success count drifted");
    assert_eq!(
        record.missed_claims, model.missed_claims,
        "missed-claim count drifted"
    );
    assert_eq!(
        record.last_updated_ledger, model.last_updated_ledger,
        "last_updated_ledger must be the ledger of the last update"
    );
    assert!(
        record.score_bps <= MAX_SCORE_BPS,
        "stored score {} exceeds 10,000 bps for {:?}",
        record.score_bps,
        model
    );
    if record.successes == 0 {
        assert_eq!(record.score_bps, 0, "no successes must mean a zero score");
    }
    if let Some(expected) = exact_score(model.successes, model.missed_claims) {
        assert_eq!(
            record.score_bps, expected,
            "score does not match the documented formula"
        );
    }
}

/// Checks the read-time view against the stored record at the current ledger.
fn assert_effective_view(
    env: &Env,
    client: &keeper_registry::KeeperRegistryClient,
    keeper: &Address,
) {
    let stored = client.keeper_reputation(keeper);
    let effective = client.effective_reputation(keeper);
    let now = env.ledger().sequence();
    assert_eq!(
        effective,
        effective_record(stored.clone(), now),
        "effective_reputation must equal the decay function applied to the stored record"
    );
    assert_eq!(
        effective.successes, stored.successes,
        "decay must not touch counts"
    );
    assert_eq!(
        effective.missed_claims, stored.missed_claims,
        "decay must not touch counts"
    );
    assert_eq!(
        effective.last_updated_ledger, stored.last_updated_ledger,
        "decay must not touch last_updated_ledger"
    );
    assert!(
        effective.score_bps <= stored.score_bps,
        "decay increased the score"
    );
    assert_eq!(
        effective.score_bps,
        expected_decayed_score(stored.score_bps, stored.last_updated_ledger, now),
        "effective score is not floor(score_bps / 2^halvings)"
    );
}

fn register_task(harness: &RegistryHarness, lock_ledgers: u32) -> u64 {
    harness.client().register_task(
        &harness.user,
        &TaskType::Liquidation,
        &Bytes::new(&harness.env),
        &1i128,
        &(harness.env.ledger().timestamp() + 1_000),
        &TASK_TTL_LEDGERS,
        &lock_ledgers,
        &None,
    )
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger()
        .with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(ledgers));
}

/// Writes `record` under `ReputationKey::Keeper(keeper)`'s serialized layout.
fn seed_record(harness: &RegistryHarness, keeper: &Address, record: &ReputationRecord) {
    let env = &harness.env;
    let key = (Symbol::new(env, "Keeper"), keeper.clone());
    env.as_contract(&harness.contract_id, || {
        env.storage().persistent().set(&key, record);
        env.storage()
            .persistent()
            .extend_ttl(&key, REPUTATION_TTL_LEDGERS, REPUTATION_TTL_LEDGERS);
    });
}

/// Layer 1: update sequences and a final wide jump through the contract.
fn fuzz_update_sequences(steps: &[Step], final_jump: u32) {
    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();
    let keepers: [Address; KEEPER_COUNT] = [
        harness.keeper.clone(),
        Address::generate(env),
        Address::generate(env),
    ];
    let mut models = [Model::default(); KEEPER_COUNT];
    let mut elapsed = 0u32;
    let pick = |i: u8| i as usize % KEEPER_COUNT;

    for step in steps.iter().take(MAX_STEPS) {
        match *step {
            Step::Execute { keeper } => {
                let k = pick(keeper);
                let task_id = register_task(&harness, MIN_LOCK_LEDGERS);
                client.claim_task(&keepers[k], &task_id);
                client.execute_task(&keepers[k], &task_id, &Bytes::new(env));
                models[k].apply(true, env.ledger().sequence());
            }
            Step::Takeover {
                first,
                second,
                lock_extra,
                then_execute,
            } => {
                let span = MAX_LOCK_LEDGERS - MIN_LOCK_LEDGERS + 1;
                let lock = MIN_LOCK_LEDGERS + lock_extra as u32 % span;
                if elapsed + lock > MAX_SEQUENCE_ELAPSED_LEDGERS {
                    continue;
                }
                let (a, b) = (pick(first), pick(second));
                let task_id = register_task(&harness, lock);
                client.claim_task(&keepers[a], &task_id);
                // Exactly at the inclusive lock boundary.
                advance(env, lock);
                elapsed += lock;
                client.claim_task(&keepers[b], &task_id);
                models[a].apply(false, env.ledger().sequence());
                if then_execute {
                    client.execute_task(&keepers[b], &task_id, &Bytes::new(env));
                    models[b].apply(true, env.ledger().sequence());
                }
            }
            Step::Advance { ledgers } => {
                let ledgers = (ledgers % (MAX_ADVANCE_LEDGERS + 1))
                    .min(MAX_SEQUENCE_ELAPSED_LEDGERS - elapsed);
                advance(env, ledgers);
                elapsed += ledgers;
            }
            Step::Seed {
                keeper,
                successes,
                missed_claims,
            } => {
                let k = pick(keeper);
                let actions = successes.saturating_add(missed_claims);
                let record = ReputationRecord {
                    successes,
                    missed_claims,
                    score_bps: if actions == 0 {
                        0
                    } else {
                        ((successes as u128 * 10_000) / actions as u128) as u32
                    },
                    last_updated_ledger: env.ledger().sequence(),
                };
                seed_record(&harness, &keepers[k], &record);
                assert_eq!(
                    client.keeper_reputation(&keepers[k]),
                    record,
                    "seeded record did not round-trip; ReputationKey layout changed"
                );
                models[k] = Model {
                    successes,
                    missed_claims,
                    last_updated_ledger: record.last_updated_ledger,
                    touched: true,
                };
            }
        }

        for (keeper, model) in keepers.iter().zip(models.iter()) {
            assert_record_matches_model(&client.keeper_reputation(keeper), model);
            assert_effective_view(env, &client, keeper);
        }
    }

    // Final wide jump. Keep the registry instance alive for the view calls;
    // reputation entries already live for REPUTATION_TTL_LEDGERS.
    let jump = final_jump % (MAX_FINAL_JUMP_LEDGERS + 1);
    env.as_contract(&harness.contract_id, || {
        env.storage()
            .instance()
            .extend_ttl(REPUTATION_TTL_LEDGERS, REPUTATION_TTL_LEDGERS);
    });
    let before: [ReputationRecord; KEEPER_COUNT] =
        core::array::from_fn(|i| client.effective_reputation(&keepers[i]));
    advance(env, jump);
    for (i, keeper) in keepers.iter().enumerate() {
        assert_record_matches_model(&client.keeper_reputation(keeper), &models[i]);
        assert_effective_view(env, &client, keeper);
        assert!(
            client.effective_reputation(keeper).score_bps <= before[i].score_bps,
            "effective score increased across a {jump}-ledger jump"
        );
    }
}

/// Layer 2: the pure decay function across its full `u32` input range.
fn fuzz_decay_function(input: &DecayInput) {
    let record = ReputationRecord {
        successes: input.successes,
        missed_claims: input.missed_claims,
        score_bps: input.score_bps,
        last_updated_ledger: input.last_updated_ledger,
    };
    let (earlier, later) = if input.ledger_a <= input.ledger_b {
        (input.ledger_a, input.ledger_b)
    } else {
        (input.ledger_b, input.ledger_a)
    };

    let at_earlier = effective_record(record.clone(), earlier);
    let at_later = effective_record(record.clone(), later);

    for (decayed, ledger) in [(&at_earlier, earlier), (&at_later, later)] {
        assert_eq!(
            decayed.successes, record.successes,
            "decay must not touch counts"
        );
        assert_eq!(
            decayed.missed_claims, record.missed_claims,
            "decay must not touch counts"
        );
        assert_eq!(
            decayed.last_updated_ledger, record.last_updated_ledger,
            "decay must not touch last_updated_ledger"
        );
        assert!(
            decayed.score_bps <= record.score_bps,
            "decay increased the score"
        );
        assert_eq!(
            decayed.score_bps,
            expected_decayed_score(record.score_bps, record.last_updated_ledger, ledger),
            "decayed score is not floor(score_bps / 2^halvings) at ledger {ledger}"
        );
        if ledger <= record.last_updated_ledger {
            assert_eq!(
                decayed.score_bps, record.score_bps,
                "a ledger at or before the last update must not decay the score"
            );
        }
    }

    assert!(
        at_later.score_bps <= at_earlier.score_bps,
        "decay is not monotonic: {} at ledger {earlier}, {} at ledger {later}",
        at_earlier.score_bps,
        at_later.score_bps
    );

    // The score is a step function: constant within one half-life interval.
    let interval = |ledger: u32| {
        ledger.saturating_sub(record.last_updated_ledger) / REPUTATION_DECAY_HALF_LIFE_LEDGERS
    };
    if interval(earlier) == interval(later) {
        assert_eq!(
            at_earlier.score_bps, at_later.score_bps,
            "score changed within a single half-life interval"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = ReputationInput::arbitrary(&mut unstructured) else {
        return;
    };

    fuzz_decay_function(&input.decay);
    fuzz_update_sequences(&input.steps, input.final_jump);
});
