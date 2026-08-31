//! The fifteen registry events, as the indexer models them.
//!
//! Every variant here mirrors one `emit_*` in
//! `contracts/keeper-registry/src/events.rs` exactly: the same topic pair and
//! the same payload fields, in the same order. Nothing is added that the
//! contract does not emit -- `TaskClaimed` carries no reward, for instance,
//! because the contract's event does not carry one either. A consumer that
//! needs the reward joins against the `TaskRegistered` row.
//!
//! This type is the single definition shared by ingestion, the REST feed and
//! the WebSocket feed, so a client that can parse one can parse all three.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The discriminant of an [`EventPayload`], usable as a filter without
/// decoding the payload -- the off-chain equivalent of the contract's
/// `(verb, noun)` topic pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    TaskRegistered,
    TaskClaimed,
    TaskExecuted,
    TaskExpired,
    TaskCancelled,
    RewardIncreased,
    DeadlineExtended,
    RewardsWithdrawn,
    Paused,
    FeeUpdated,
    AdminTransferred,
    MinRewardUpdated,
    FeesSwept,
    Initialized,
    Upgraded,
}

impl EventType {
    /// The contract's `(verb, noun)` topic pair for this event.
    ///
    /// Ingestion matches on this to decide which variant to parse, so the
    /// mapping lives next to the variants rather than in the poller.
    pub const fn topics(self) -> (&'static str, &'static str) {
        match self {
            Self::TaskRegistered => ("reg", "task"),
            Self::TaskClaimed => ("claim", "task"),
            Self::TaskExecuted => ("exec", "task"),
            Self::TaskExpired => ("exp", "task"),
            Self::TaskCancelled => ("cancel", "task"),
            Self::RewardIncreased => ("topup", "task"),
            Self::DeadlineExtended => ("extend", "task"),
            Self::RewardsWithdrawn => ("wdraw", "reward"),
            Self::Paused => ("paused", "admin"),
            Self::FeeUpdated => ("fee", "admin"),
            Self::AdminTransferred => ("admin", "xfer"),
            Self::MinRewardUpdated => ("minrwd", "admin"),
            Self::FeesSwept => ("sweep", "admin"),
            Self::Initialized => ("init", "admin"),
            Self::Upgraded => ("upgrade", "admin"),
        }
    }

    /// Resolve a `(verb, noun)` topic pair back to its event type.
    ///
    /// Returns `None` for a topic pair the contract does not emit, so an
    /// unrecognised event is skipped rather than mis-parsed as a known one.
    pub fn from_topics(verb: &str, noun: &str) -> Option<Self> {
        const ALL: [EventType; 15] = [
            EventType::TaskRegistered,
            EventType::TaskClaimed,
            EventType::TaskExecuted,
            EventType::TaskExpired,
            EventType::TaskCancelled,
            EventType::RewardIncreased,
            EventType::DeadlineExtended,
            EventType::RewardsWithdrawn,
            EventType::Paused,
            EventType::FeeUpdated,
            EventType::AdminTransferred,
            EventType::MinRewardUpdated,
            EventType::FeesSwept,
            EventType::Initialized,
            EventType::Upgraded,
        ];
        ALL.into_iter().find(|e| e.topics() == (verb, noun))
    }

    /// The wire name used in the `event_type` column and in API filters.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TaskRegistered => "task_registered",
            Self::TaskClaimed => "task_claimed",
            Self::TaskExecuted => "task_executed",
            Self::TaskExpired => "task_expired",
            Self::TaskCancelled => "task_cancelled",
            Self::RewardIncreased => "reward_increased",
            Self::DeadlineExtended => "deadline_extended",
            Self::RewardsWithdrawn => "rewards_withdrawn",
            Self::Paused => "paused",
            Self::FeeUpdated => "fee_updated",
            Self::AdminTransferred => "admin_transferred",
            Self::MinRewardUpdated => "min_reward_updated",
            Self::FeesSwept => "fees_swept",
            Self::Initialized => "initialized",
            Self::Upgraded => "upgraded",
        }
    }

    /// Parse the wire name produced by [`Self::as_str`].
    pub fn parse(s: &str) -> Option<Self> {
        const ALL: [EventType; 15] = [
            EventType::TaskRegistered,
            EventType::TaskClaimed,
            EventType::TaskExecuted,
            EventType::TaskExpired,
            EventType::TaskCancelled,
            EventType::RewardIncreased,
            EventType::DeadlineExtended,
            EventType::RewardsWithdrawn,
            EventType::Paused,
            EventType::FeeUpdated,
            EventType::AdminTransferred,
            EventType::MinRewardUpdated,
            EventType::FeesSwept,
            EventType::Initialized,
            EventType::Upgraded,
        ];
        ALL.into_iter().find(|e| e.as_str() == s)
    }
}

/// The decoded payload of one event.
///
/// Field names and order match the contract's `publish` tuple for each event.
/// `i128` values are serialised as strings: a reward in stroops can exceed
/// `Number.MAX_SAFE_INTEGER`, and a browser dashboard reading JSON would
/// silently lose precision on a bare number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventPayload {
    TaskRegistered {
        task_id: u64,
        owner: String,
        #[schema(value_type = String)]
        reward: I128,
        deadline: u64,
    },
    TaskClaimed {
        task_id: u64,
        keeper: String,
        /// Ledger sequence at claim time, as the contract reports it.
        claim_ledger: u32,
    },
    TaskExecuted {
        task_id: u64,
        keeper: String,
        #[schema(value_type = String)]
        net_reward: I128,
        /// Hex-encoded execution proof bytes.
        proof: String,
    },
    TaskExpired {
        task_id: u64,
    },
    TaskCancelled {
        task_id: u64,
        owner: String,
    },
    RewardIncreased {
        task_id: u64,
        #[schema(value_type = String)]
        new_reward: I128,
    },
    DeadlineExtended {
        task_id: u64,
        new_deadline: u64,
    },
    RewardsWithdrawn {
        keeper: String,
        #[schema(value_type = String)]
        amount: I128,
    },
    Paused {
        paused: bool,
    },
    FeeUpdated {
        old_bps: u32,
        new_bps: u32,
    },
    AdminTransferred {
        old_admin: String,
        new_admin: String,
    },
    MinRewardUpdated {
        #[schema(value_type = String)]
        old_min: I128,
        #[schema(value_type = String)]
        new_min: I128,
    },
    FeesSwept {
        treasury: String,
        #[schema(value_type = String)]
        amount: I128,
        #[schema(value_type = String)]
        remaining: I128,
    },
    Initialized {
        admin: String,
        reward_token: String,
        fee_bps: u32,
    },
    Upgraded {
        admin: String,
        /// Hex-encoded 32-byte wasm hash.
        new_wasm_hash: String,
    },
}

impl EventPayload {
    /// The type discriminant for this payload.
    pub const fn event_type(&self) -> EventType {
        match self {
            Self::TaskRegistered { .. } => EventType::TaskRegistered,
            Self::TaskClaimed { .. } => EventType::TaskClaimed,
            Self::TaskExecuted { .. } => EventType::TaskExecuted,
            Self::TaskExpired { .. } => EventType::TaskExpired,
            Self::TaskCancelled { .. } => EventType::TaskCancelled,
            Self::RewardIncreased { .. } => EventType::RewardIncreased,
            Self::DeadlineExtended { .. } => EventType::DeadlineExtended,
            Self::RewardsWithdrawn { .. } => EventType::RewardsWithdrawn,
            Self::Paused { .. } => EventType::Paused,
            Self::FeeUpdated { .. } => EventType::FeeUpdated,
            Self::AdminTransferred { .. } => EventType::AdminTransferred,
            Self::MinRewardUpdated { .. } => EventType::MinRewardUpdated,
            Self::FeesSwept { .. } => EventType::FeesSwept,
            Self::Initialized { .. } => EventType::Initialized,
            Self::Upgraded { .. } => EventType::Upgraded,
        }
    }

    /// The task this event concerns, if any.
    pub const fn task_id(&self) -> Option<u64> {
        match self {
            Self::TaskRegistered { task_id, .. }
            | Self::TaskClaimed { task_id, .. }
            | Self::TaskExecuted { task_id, .. }
            | Self::TaskExpired { task_id }
            | Self::TaskCancelled { task_id, .. }
            | Self::RewardIncreased { task_id, .. }
            | Self::DeadlineExtended { task_id, .. } => Some(*task_id),
            _ => None,
        }
    }

    /// The owner address this event concerns, if any.
    pub fn owner(&self) -> Option<&str> {
        match self {
            Self::TaskRegistered { owner, .. } | Self::TaskCancelled { owner, .. } => Some(owner),
            _ => None,
        }
    }

    /// The keeper address this event concerns, if any.
    pub fn keeper(&self) -> Option<&str> {
        match self {
            Self::TaskClaimed { keeper, .. }
            | Self::TaskExecuted { keeper, .. }
            | Self::RewardsWithdrawn { keeper, .. } => Some(keeper),
            _ => None,
        }
    }
}

/// An `i128` that serialises as a decimal string.
///
/// Rewards are token stroops and routinely exceed 2^53, so a JSON number would
/// lose precision in any browser consumer. SQLite has no 128-bit integer type
/// either, so the same string form is what gets stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct I128(pub i128);

impl From<i128> for I128 {
    fn from(v: i128) -> Self {
        Self(v)
    }
}

impl From<I128> for i128 {
    fn from(v: I128) -> Self {
        v.0
    }
}

impl std::fmt::Display for I128 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for I128 {
    type Err = std::num::ParseIntError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<i128>().map(Self)
    }
}

impl Serialize for I128 {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for I128 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<i128>()
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

/// One ingested event, with the ledger context needed to order and page it.
///
/// This is the exact shape the REST event feed and the WebSocket feed both
/// emit -- issue 0226 requires a client to need only one parser for both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct IndexedEvent {
    /// Monotonic ingestion sequence, and the cursor used for pagination.
    ///
    /// Assigned by the database on insert, so it is stable: a later ingestion
    /// never renumbers an existing row, which is what an offset would do.
    pub cursor: i64,
    /// Ledger this event was emitted in.
    pub ledger: u32,
    /// Close time of that ledger, as a Unix timestamp in seconds.
    pub ledger_close_time: i64,
    /// Transaction hash, hex-encoded.
    pub tx_hash: String,
    /// Index of this event within its transaction.
    pub event_index: u32,
    pub event_type: EventType,
    pub payload: EventPayload,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_pairs_round_trip() {
        for name in [
            "task_registered",
            "task_claimed",
            "task_executed",
            "task_expired",
            "task_cancelled",
            "reward_increased",
            "deadline_extended",
            "rewards_withdrawn",
            "paused",
            "fee_updated",
            "admin_transferred",
            "min_reward_updated",
            "fees_swept",
            "initialized",
            "upgraded",
        ] {
            let ty = EventType::parse(name).expect("known event name");
            let (verb, noun) = ty.topics();
            assert_eq!(EventType::from_topics(verb, noun), Some(ty));
            assert_eq!(ty.as_str(), name);
        }
    }

    #[test]
    fn unknown_topics_are_not_guessed() {
        assert_eq!(EventType::from_topics("nope", "task"), None);
        assert_eq!(EventType::parse("not_an_event"), None);
    }

    #[test]
    fn large_rewards_survive_json_as_strings() {
        // Above 2^53: a JSON number would lose precision in a browser.
        let payload = EventPayload::TaskExecuted {
            task_id: 1,
            keeper: "GKEEPER".into(),
            net_reward: I128(170_141_183_460_469_231_731_687_303_715_884_105_727),
            proof: "abcd".into(),
        };
        let json = serde_json::to_string(&payload).expect("serialises");
        assert!(json.contains("\"170141183460469231731687303715884105727\""));
        let back: EventPayload = serde_json::from_str(&json).expect("round-trips");
        assert_eq!(back, payload);
    }

    #[test]
    fn address_accessors_match_the_contract_payloads() {
        let registered = EventPayload::TaskRegistered {
            task_id: 7,
            owner: "GOWNER".into(),
            reward: I128(100),
            deadline: 900,
        };
        assert_eq!(registered.owner(), Some("GOWNER"));
        assert_eq!(registered.keeper(), None);
        assert_eq!(registered.task_id(), Some(7));

        let withdrawn = EventPayload::RewardsWithdrawn {
            keeper: "GKEEPER".into(),
            amount: I128(50),
        };
        assert_eq!(withdrawn.keeper(), Some("GKEEPER"));
        assert_eq!(withdrawn.task_id(), None);
    }
}
