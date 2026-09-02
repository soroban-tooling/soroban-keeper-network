//! Fuzz target for every mutating entry point against a never-initialized
//! registry (backlog issue 0121, following up on issue 0008's typed
//! `NotInitialized` error).
//!
//! Issue 0008 replaced panicking `.expect("not initialized")` calls with
//! `KeeperError::NotInitialized` across every entry point that depends on
//! configured state, and `test.rs` covers this per-function with
//! hand-written cases. This target instead deploys a contract via
//! `env.register` and deliberately never calls `initialize`, then drives
//! EVERY public mutating entry point (in a fuzzer-chosen random order, all
//! against the same never-initialized instance) with fuzzed arguments,
//! asserting each call:
//!   - never panics / never host-traps (`Err(Err(_))`),
//!   - never succeeds (`Ok(Ok(_))` — nothing can succeed pre-`initialize`),
//!   - returns exactly one of that function's documented pre-init error
//!     variants (`NotInitialized`, or a check that runs before the
//!     `NotInitialized`-returning access, such as `TaskNotFound` for any
//!     task-id-keyed function, since no task can exist yet either).
//!
//! ## Adding a new entry point
//!
//! When a new state-mutating function is added to `KeeperRegistry`
//! (`#[contractimpl] impl KeeperRegistry` in `contracts/keeper-registry/src/lib.rs`),
//! add it here too:
//!   1. add a field to `Ctx` for any argument it needs that isn't already there,
//!   2. add a `check_<name>` function that calls `try_<name>` and asserts the
//!      allowed error set with `assert_rejected!`,
//!   3. add that function to the `CHECKS` array and bump `ENTRY_POINT_COUNT`.
//! Forgetting this step means the new function is silently unfuzzed by this
//! target rather than failing loudly, so please don't skip it.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::{
    BatchTaskParams, KeeperError, KeeperRegistry, KeeperRegistryClient, TaskType,
};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};

/// Raw fuzzer input. Kept as fixed-size byte arrays / small integers (rather
/// than the richer types built from them) so `arbitrary`'s derive can decode
/// it deterministically and cheaply.
#[derive(Arbitrary, Debug)]
struct UninitInput {
    order_seed: [u8; 16],
    task_id: u64,
    task_type_discriminator: u8,
    calldata: std::vec::Vec<u8>,
    reward_bytes: [u8; 16],
    deadline_offset: u64,
    ttl_ledgers: u32,
    lock_ledgers: u32,
    additional_bytes: [u8; 16],
    new_deadline_offset: u64,
    proof: std::vec::Vec<u8>,
    fee_bps: u32,
    min_reward_bytes: [u8; 16],
    sweep_amount_bytes: [u8; 16],
    wasm_hash: [u8; 32],
    max_total_reward_bytes: [u8; 16],
    batch_entry_count: u8,
}

fn arbitrary_task_type(discriminator: u8) -> TaskType {
    match discriminator % 6 {
        0 => TaskType::Liquidation,
        1 => TaskType::OraclePricePush,
        2 => TaskType::FundingRateUpdate,
        3 => TaskType::LiquidityRebalance,
        4 => TaskType::TtlExtension,
        _ => TaskType::Custom,
    }
}

/// Every argument any check function might need, built once per fuzz
/// iteration and shared (by reference) across whichever order the 16 checks
/// run in.
struct Ctx<'a> {
    client: &'a KeeperRegistryClient<'a>,
    owner: Address,
    keeper: Address,
    admin: Address,
    new_admin: Address,
    treasury: Address,
    task_type: TaskType,
    calldata: Bytes,
    reward: i128,
    deadline: u64,
    ttl_ledgers: u32,
    lock_ledgers: u32,
    additional: i128,
    new_deadline: u64,
    task_id: u64,
    proof: Bytes,
    fee_bps: u32,
    min_reward: i128,
    sweep_amount: i128,
    wasm_hash: BytesN<32>,
    max_total_reward: i128,
    batch_tasks: Vec<BatchTaskParams>,
}

/// Asserts a `try_*` call's result is a rejection with one of the allowed
/// `KeeperError` variants for a never-initialized registry — never a
/// success, never a client/ABI conversion failure, never an unhandled host
/// trap, and never a variant outside the documented set.
macro_rules! assert_rejected {
    ($label:expr, $result:expr, [$($allowed:ident),+ $(,)?]) => {{
        match $result {
            Ok(Ok(_)) => panic!(
                "{}: succeeded against a never-initialized registry",
                $label
            ),
            Ok(Err(_)) => panic!(
                "{}: call succeeded but the return value failed to convert back \
                 from the host -- client/ABI mismatch",
                $label
            ),
            Err(Ok(e)) => {
                if !matches!(e, $(KeeperError::$allowed)|+) {
                    panic!(
                        "{}: returned unexpected KeeperError variant {:?} against a \
                         never-initialized registry (allowed: {})",
                        $label, e, stringify!($($allowed),+)
                    );
                }
            }
            Err(Err(_)) => panic!(
                "{}: host-errored (unhandled trap) instead of returning a typed \
                 KeeperError against a never-initialized registry",
                $label
            ),
        }
    }};
}

// ── one check function per mutating entry point ────────────────────────────
// Keep this list and `CHECKS` below in sync with
// `contracts/keeper-registry/src/lib.rs`'s `#[contractimpl] impl KeeperRegistry`
// block -- see the module doc comment for what to do when adding a new one.
// `initialize` itself is deliberately excluded: it's the one mutating entry
// point that's SUPPOSED to succeed pre-init.

fn check_register_task(ctx: &Ctx) {
    assert_rejected!(
        "register_task",
        ctx.client.try_register_task(
            &ctx.owner,
            &ctx.task_type,
            &ctx.calldata,
            &ctx.reward,
            &ctx.deadline,
            &ctx.ttl_ledgers,
            &ctx.lock_ledgers,
            &None,
        ),
        [
            InvalidReward,
            DeadlinePassed,
            CalldataTooLarge,
            InvalidTaskParams,
            TtlTooShort,
            NotInitialized,
        ]
    );
}

fn check_batch_register_tasks(ctx: &Ctx) {
    assert_rejected!(
        "batch_register_tasks",
        ctx.client.try_batch_register_tasks(
            &ctx.owner,
            &ctx.batch_tasks,
            &ctx.max_total_reward,
        ),
        [
            EmptyBatch,
            BatchTooLarge,
            InvalidReward,
            CalldataTooLarge,
            InvalidTaskParams,
            TtlTooShort,
            ArithmeticOverflow,
            BatchRewardCeilingExceeded,
            NotInitialized,
        ]
    );
}

fn check_increase_reward(ctx: &Ctx) {
    assert_rejected!(
        "increase_reward",
        ctx.client
            .try_increase_reward(&ctx.owner, &ctx.task_id, &ctx.additional),
        [InvalidReward, TaskNotFound]
    );
}

fn check_extend_deadline(ctx: &Ctx) {
    assert_rejected!(
        "extend_deadline",
        ctx.client
            .try_extend_deadline(&ctx.owner, &ctx.task_id, &ctx.new_deadline),
        [TaskNotFound]
    );
}

fn check_claim_task(ctx: &Ctx) {
    assert_rejected!(
        "claim_task",
        ctx.client.try_claim_task(&ctx.keeper, &ctx.task_id),
        [TaskNotFound]
    );
}

fn check_execute_task(ctx: &Ctx) {
    assert_rejected!(
        "execute_task",
        ctx.client
            .try_execute_task(&ctx.keeper, &ctx.task_id, &ctx.proof),
        [ProofTooLarge, TaskNotFound]
    );
}

fn check_cancel_task(ctx: &Ctx) {
    assert_rejected!(
        "cancel_task",
        ctx.client.try_cancel_task(&ctx.owner, &ctx.task_id),
        [TaskNotFound]
    );
}

fn check_expire_task(ctx: &Ctx) {
    assert_rejected!(
        "expire_task",
        ctx.client.try_expire_task(&ctx.task_id),
        [TaskNotFound]
    );
}

fn check_withdraw_rewards(ctx: &Ctx) {
    assert_rejected!(
        "withdraw_rewards",
        ctx.client.try_withdraw_rewards(&ctx.keeper),
        [NoRewardsAvailable]
    );
}

fn check_pause(ctx: &Ctx) {
    assert_rejected!("pause", ctx.client.try_pause(&ctx.admin), [NotInitialized]);
}

fn check_unpause(ctx: &Ctx) {
    assert_rejected!(
        "unpause",
        ctx.client.try_unpause(&ctx.admin),
        [NotInitialized]
    );
}

fn check_set_fee_bps(ctx: &Ctx) {
    assert_rejected!(
        "set_fee_bps",
        ctx.client.try_set_fee_bps(&ctx.admin, &ctx.fee_bps),
        [NotInitialized]
    );
}

fn check_set_min_reward(ctx: &Ctx) {
    assert_rejected!(
        "set_min_reward",
        ctx.client
            .try_set_min_reward(&ctx.admin, &ctx.min_reward),
        [NotInitialized]
    );
}

fn check_transfer_admin(ctx: &Ctx) {
    assert_rejected!(
        "transfer_admin",
        ctx.client
            .try_transfer_admin(&ctx.admin, &ctx.new_admin),
        [NotInitialized]
    );
}

fn check_upgrade(ctx: &Ctx) {
    assert_rejected!(
        "upgrade",
        ctx.client.try_upgrade(&ctx.admin, &ctx.wasm_hash),
        [NotInitialized]
    );
}

fn check_sweep_fees(ctx: &Ctx) {
    assert_rejected!(
        "sweep_fees",
        ctx.client
            .try_sweep_fees(&ctx.admin, &ctx.treasury, &ctx.sweep_amount),
        [NotInitialized]
    );
}

const ENTRY_POINT_COUNT: usize = 16;

const CHECKS: [fn(&Ctx); ENTRY_POINT_COUNT] = [
    check_register_task,
    check_batch_register_tasks,
    check_increase_reward,
    check_extend_deadline,
    check_claim_task,
    check_execute_task,
    check_cancel_task,
    check_expire_task,
    check_withdraw_rewards,
    check_pause,
    check_unpause,
    check_set_fee_bps,
    check_set_min_reward,
    check_transfer_admin,
    check_upgrade,
    check_sweep_fees,
];

/// Deterministic Fisher-Yates shuffle of `0..ENTRY_POINT_COUNT`, seeded from
/// fuzzer-controlled bytes so libFuzzer's mutation strategy naturally
/// explores different call orders across runs and can shrink toward a
/// minimal failing order.
fn shuffled_order(seed: &[u8; 16]) -> [usize; ENTRY_POINT_COUNT] {
    let mut order = [0usize; ENTRY_POINT_COUNT];
    for (i, slot) in order.iter_mut().enumerate() {
        *slot = i;
    }
    let mut state = u64::from_le_bytes(seed[0..8].try_into().unwrap())
        ^ u64::from_le_bytes(seed[8..16].try_into().unwrap())
        ^ 0x9E3779B97F4A7C15;
    for i in (1..ENTRY_POINT_COUNT).rev() {
        // xorshift64* -- not cryptographic, just needs to spread fuzzer
        // input bytes across a decent range of permutations.
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let j = (state as usize) % (i + 1);
        order.swap(i, j);
    }
    order
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = UninitInput::arbitrary(&mut unstructured) else {
        return;
    };

    let env = Env::default();
    env.mock_all_auths();

    // Deploy WITHOUT ever calling `initialize` -- the entire point of this
    // target.
    let contract_id = env.register(KeeperRegistry, ());
    let client = KeeperRegistryClient::new(&env, &contract_id);

    let reward = i128::from_le_bytes(input.reward_bytes);
    let additional = i128::from_le_bytes(input.additional_bytes);
    let min_reward = i128::from_le_bytes(input.min_reward_bytes);
    let sweep_amount = i128::from_le_bytes(input.sweep_amount_bytes);
    let max_total_reward = i128::from_le_bytes(input.max_total_reward_bytes);
    let deadline = env
        .ledger()
        .timestamp()
        .saturating_add(input.deadline_offset);
    let new_deadline = deadline.saturating_add(input.new_deadline_offset);

    let calldata = Bytes::from_slice(&env, &input.calldata);
    let proof = Bytes::from_slice(&env, &input.proof);
    let wasm_hash = BytesN::from_array(&env, &input.wasm_hash);

    // Batch entries wide enough to cross MAX_BATCH_SIZE (50) sometimes and
    // hit `EmptyBatch` (0 entries) other times.
    let batch_len = (input.batch_entry_count % 60) as u32;
    let mut batch_tasks = Vec::new(&env);
    for _ in 0..batch_len {
        batch_tasks.push_back(BatchTaskParams {
            task_type: arbitrary_task_type(input.task_type_discriminator),
            calldata: calldata.clone(),
            reward,
            deadline,
            ttl_ledgers: input.ttl_ledgers,
            lock_ledgers: input.lock_ledgers,
        });
    }

    let ctx = Ctx {
        client: &client,
        owner: Address::generate(&env),
        keeper: Address::generate(&env),
        admin: Address::generate(&env),
        new_admin: Address::generate(&env),
        treasury: Address::generate(&env),
        task_type: arbitrary_task_type(input.task_type_discriminator),
        calldata,
        reward,
        deadline,
        ttl_ledgers: input.ttl_ledgers,
        lock_ledgers: input.lock_ledgers,
        additional,
        new_deadline,
        task_id: input.task_id,
        proof,
        fee_bps: input.fee_bps,
        min_reward,
        sweep_amount,
        wasm_hash,
        max_total_reward,
        batch_tasks,
    };

    for &idx in shuffled_order(&input.order_seed).iter() {
        CHECKS[idx](&ctx);
    }
});
