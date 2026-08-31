//! The decoded shape of a single contract event.
//!
//! The contract publishes every event with a two-symbol `(verb, noun)` topic
//! pair (see `contracts/keeper-registry/src/events.rs`), which is what lets a
//! consumer route on the topics alone without decoding the payload. This
//! module mirrors that split: [`EventTopic`] is the routing key, and
//! [`EventPayload`] carries the already-decoded fields.
//!
//! Decoding from the network's XDR representation into these types is the
//! ingestion source's job (see `docs/INDEXER_DESIGN.md`); everything below
//! this line in the indexer works on these types, so the storage and
//! aggregation logic can be tested without a network or a contract.

/// Where in the chain an event was observed.
///
/// Kept on every row so ingestion is replay-safe: the `(ledger, tx_index,
/// event_index)` triple is unique and totally ordered, which is what both the
/// idempotency constraint and the "full history in order" requirement rest on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct EventCursor {
    pub ledger: u32,
    pub tx_index: u32,
    pub event_index: u32,
}

impl EventCursor {
    pub fn new(ledger: u32, tx_index: u32, event_index: u32) -> Self {
        Self {
            ledger,
            tx_index,
            event_index,
        }
    }
}

/// The `(verb, noun)` topic pair, as the contract emits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventTopic {
    pub verb: &'static str,
    pub noun: &'static str,
}

/// A decoded contract event.
///
/// Only the variants this crate stores are listed. An event whose topic pair
/// is not recognized is not an error — it is skipped, so that a contract
/// upgrade that adds an event does not halt ingestion of the ones we do
/// understand.
#[derive(Debug, Clone, PartialEq)]
pub enum EventPayload {
    // ── task lifecycle (issue #348) ──────────────────────────────────────────
    /// `(reg, task)` — `(task_id, owner, reward, deadline)`
    TaskRegistered {
        task_id: i64,
        owner: String,
        reward: i128,
        deadline: u64,
    },
    /// `(exp, task)` — `(task_id,)`
    TaskExpired { task_id: i64 },
    /// `(cancel, task)` — `(task_id, owner)`
    TaskCancelled { task_id: i64, owner: String },
    /// `(topup, task)` — `(task_id, new_reward)`
    RewardIncreased { task_id: i64, new_reward: i128 },
    /// `(extend, task)` — `(task_id, new_deadline)`
    DeadlineExtended { task_id: i64, new_deadline: u64 },

    // ── keeper-facing (issue #349) ───────────────────────────────────────────
    /// `(claim, task)` — `(task_id, keeper, claim_ledger)`
    TaskClaimed {
        task_id: i64,
        keeper: String,
        claim_ledger: u32,
    },
    /// `(exec, task)` — `(task_id, keeper, net_reward, proof)`
    TaskExecuted {
        task_id: i64,
        keeper: String,
        net_reward: i128,
        proof: Vec<u8>,
    },
    /// `(wdraw, reward)` — `(keeper, amount)`
    RewardsWithdrawn { keeper: String, amount: i128 },

    // ── admin / governance (issue #350) ──────────────────────────────────────
    /// `(paused, admin)` — `(paused,)`
    Paused { paused: bool },
    /// `(fee, admin)` — `(old_bps, new_bps)`
    FeeUpdated { old_bps: i32, new_bps: i32 },
    /// `(admin, xfer)` — `(old_admin, new_admin)`
    AdminTransferred {
        old_admin: String,
        new_admin: String,
    },
    /// `(minrwd, admin)` — `(old_min, new_min)`
    MinRewardUpdated { old_min: i128, new_min: i128 },
    /// `(sweep, admin)` — `(treasury, amount, remaining)`
    FeesSwept {
        treasury: String,
        amount: i128,
        remaining: i128,
    },
    /// `(init, admin)` — `(admin, reward_token, fee_bps)`
    Initialized {
        admin: String,
        reward_token: String,
        fee_bps: i32,
    },
    /// `(upgrade, admin)` — `(admin, new_wasm_hash)`
    ///
    /// `new_wasm_hash` is the contract's `BytesN<32>`, kept as raw bytes rather
    /// than a hex string so the stored value is byte-identical to what was
    /// emitted; rendering is a presentation concern.
    Upgraded {
        admin: String,
        new_wasm_hash: [u8; 32],
    },
}

impl EventPayload {
    /// The topic pair the contract emits this payload under.
    pub fn topic(&self) -> EventTopic {
        let (verb, noun) = match self {
            Self::TaskRegistered { .. } => ("reg", "task"),
            Self::TaskExpired { .. } => ("exp", "task"),
            Self::TaskCancelled { .. } => ("cancel", "task"),
            Self::RewardIncreased { .. } => ("topup", "task"),
            Self::DeadlineExtended { .. } => ("extend", "task"),
            Self::TaskClaimed { .. } => ("claim", "task"),
            Self::TaskExecuted { .. } => ("exec", "task"),
            Self::RewardsWithdrawn { .. } => ("wdraw", "reward"),
            Self::Paused { .. } => ("paused", "admin"),
            Self::FeeUpdated { .. } => ("fee", "admin"),
            Self::AdminTransferred { .. } => ("admin", "xfer"),
            Self::MinRewardUpdated { .. } => ("minrwd", "admin"),
            Self::FeesSwept { .. } => ("sweep", "admin"),
            Self::Initialized { .. } => ("init", "admin"),
            Self::Upgraded { .. } => ("upgrade", "admin"),
        };
        EventTopic { verb, noun }
    }
}

/// An event plus where it was observed.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub cursor: EventCursor,
    pub payload: EventPayload,
}

impl Event {
    pub fn new(cursor: EventCursor, payload: EventPayload) -> Self {
        Self { cursor, payload }
    }
}
