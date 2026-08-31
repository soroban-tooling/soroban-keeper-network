//! Decoding a raw RPC event into a typed [`EventPayload`].
//!
//! Every arm mirrors the corresponding `emit_*` in the contract's `events.rs`:
//! same topic pair, same fields, same order. When the contract adds an event,
//! this is the one place that needs a new arm -- backfill and steady-state
//! ingestion both route through here.

use anyhow::{anyhow, Result};

use crate::events::{EventPayload, EventType};
use crate::rpc::{RawEvent, RawValue};

/// Decode one raw event.
///
/// Returns `Ok(None)` for a topic pair the contract does not emit, so an
/// unrecognised event is skipped rather than aborting a whole batch. A
/// recognised event with a malformed payload *is* an error: that means the
/// contract's shape changed underneath the indexer, and silently dropping it
/// would leave a gap nothing reports.
pub fn parse_event(raw: &RawEvent) -> Result<Option<EventPayload>> {
    let (Some(verb), Some(noun)) = (raw.topics.first(), raw.topics.get(1)) else {
        return Ok(None);
    };

    let Some(event_type) = EventType::from_topics(verb, noun) else {
        return Ok(None);
    };

    let v = &raw.values;
    let payload = match event_type {
        EventType::TaskRegistered => EventPayload::TaskRegistered {
            task_id: u64_at(v, 0, event_type)?,
            owner: address_at(v, 1, event_type)?,
            reward: i128_at(v, 2, event_type)?.into(),
            deadline: u64_at(v, 3, event_type)?,
        },
        EventType::TaskClaimed => EventPayload::TaskClaimed {
            task_id: u64_at(v, 0, event_type)?,
            keeper: address_at(v, 1, event_type)?,
            claim_ledger: u32_at(v, 2, event_type)?,
        },
        EventType::TaskExecuted => EventPayload::TaskExecuted {
            task_id: u64_at(v, 0, event_type)?,
            keeper: address_at(v, 1, event_type)?,
            net_reward: i128_at(v, 2, event_type)?.into(),
            proof: bytes_at(v, 3, event_type)?,
        },
        EventType::TaskExpired => EventPayload::TaskExpired {
            task_id: u64_at(v, 0, event_type)?,
        },
        EventType::TaskCancelled => EventPayload::TaskCancelled {
            task_id: u64_at(v, 0, event_type)?,
            owner: address_at(v, 1, event_type)?,
        },
        EventType::RewardIncreased => EventPayload::RewardIncreased {
            task_id: u64_at(v, 0, event_type)?,
            new_reward: i128_at(v, 1, event_type)?.into(),
        },
        EventType::DeadlineExtended => EventPayload::DeadlineExtended {
            task_id: u64_at(v, 0, event_type)?,
            new_deadline: u64_at(v, 1, event_type)?,
        },
        EventType::RewardsWithdrawn => EventPayload::RewardsWithdrawn {
            keeper: address_at(v, 0, event_type)?,
            amount: i128_at(v, 1, event_type)?.into(),
        },
        EventType::Paused => EventPayload::Paused {
            paused: bool_at(v, 0, event_type)?,
        },
        EventType::FeeUpdated => EventPayload::FeeUpdated {
            old_bps: u32_at(v, 0, event_type)?,
            new_bps: u32_at(v, 1, event_type)?,
        },
        EventType::AdminTransferred => EventPayload::AdminTransferred {
            old_admin: address_at(v, 0, event_type)?,
            new_admin: address_at(v, 1, event_type)?,
        },
        EventType::MinRewardUpdated => EventPayload::MinRewardUpdated {
            old_min: i128_at(v, 0, event_type)?.into(),
            new_min: i128_at(v, 1, event_type)?.into(),
        },
        EventType::FeesSwept => EventPayload::FeesSwept {
            treasury: address_at(v, 0, event_type)?,
            amount: i128_at(v, 1, event_type)?.into(),
            remaining: i128_at(v, 2, event_type)?.into(),
        },
        EventType::Initialized => EventPayload::Initialized {
            admin: address_at(v, 0, event_type)?,
            reward_token: address_at(v, 1, event_type)?,
            fee_bps: u32_at(v, 2, event_type)?,
        },
        EventType::Upgraded => EventPayload::Upgraded {
            admin: address_at(v, 0, event_type)?,
            new_wasm_hash: bytes_at(v, 1, event_type)?,
        },
    };

    Ok(Some(payload))
}

fn at(values: &[RawValue], index: usize, event: EventType) -> Result<&RawValue> {
    values.get(index).ok_or_else(|| {
        anyhow!(
            "{} payload has {} fields, expected at least {}",
            event.as_str(),
            values.len(),
            index + 1
        )
    })
}

fn type_error(event: EventType, index: usize, expected: &str, got: &RawValue) -> anyhow::Error {
    anyhow!(
        "{} field {index} should be {expected}, got {got:?}",
        event.as_str()
    )
}

fn u64_at(values: &[RawValue], index: usize, event: EventType) -> Result<u64> {
    match at(values, index, event)? {
        RawValue::U64(v) => Ok(*v),
        other => Err(type_error(event, index, "u64", other)),
    }
}

fn u32_at(values: &[RawValue], index: usize, event: EventType) -> Result<u32> {
    match at(values, index, event)? {
        RawValue::U32(v) => Ok(*v),
        other => Err(type_error(event, index, "u32", other)),
    }
}

fn i128_at(values: &[RawValue], index: usize, event: EventType) -> Result<i128> {
    match at(values, index, event)? {
        RawValue::I128(v) => Ok(*v),
        other => Err(type_error(event, index, "i128", other)),
    }
}

fn bool_at(values: &[RawValue], index: usize, event: EventType) -> Result<bool> {
    match at(values, index, event)? {
        RawValue::Bool(v) => Ok(*v),
        other => Err(type_error(event, index, "bool", other)),
    }
}

fn address_at(values: &[RawValue], index: usize, event: EventType) -> Result<String> {
    match at(values, index, event)? {
        RawValue::Address(v) => Ok(v.clone()),
        other => Err(type_error(event, index, "address", other)),
    }
}

fn bytes_at(values: &[RawValue], index: usize, event: EventType) -> Result<String> {
    match at(values, index, event)? {
        RawValue::Bytes(v) => Ok(v.clone()),
        other => Err(type_error(event, index, "bytes", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::I128;

    fn raw(topics: [&str; 2], values: Vec<RawValue>) -> RawEvent {
        RawEvent {
            ledger: 1,
            ledger_close_time: 10,
            tx_hash: "tx".into(),
            event_index: 0,
            topics: topics.iter().map(|t| (*t).to_string()).collect(),
            values,
        }
    }

    #[test]
    fn every_contract_event_round_trips_through_its_topic_pair() {
        // One raw event per emit_* in the contract, with the payload fields in
        // the order the contract publishes them.
        let cases: Vec<(RawEvent, EventType)> = vec![
            (
                raw(
                    ["reg", "task"],
                    vec![
                        RawValue::U64(1),
                        RawValue::Address("GOWNER".into()),
                        RawValue::I128(500),
                        RawValue::U64(900),
                    ],
                ),
                EventType::TaskRegistered,
            ),
            (
                raw(
                    ["claim", "task"],
                    vec![
                        RawValue::U64(1),
                        RawValue::Address("GKEEPER".into()),
                        RawValue::U32(77),
                    ],
                ),
                EventType::TaskClaimed,
            ),
            (
                raw(
                    ["exec", "task"],
                    vec![
                        RawValue::U64(1),
                        RawValue::Address("GKEEPER".into()),
                        RawValue::I128(490),
                        RawValue::Bytes("deadbeef".into()),
                    ],
                ),
                EventType::TaskExecuted,
            ),
            (
                raw(["exp", "task"], vec![RawValue::U64(1)]),
                EventType::TaskExpired,
            ),
            (
                raw(
                    ["cancel", "task"],
                    vec![RawValue::U64(1), RawValue::Address("GOWNER".into())],
                ),
                EventType::TaskCancelled,
            ),
            (
                raw(
                    ["topup", "task"],
                    vec![RawValue::U64(1), RawValue::I128(600)],
                ),
                EventType::RewardIncreased,
            ),
            (
                raw(
                    ["extend", "task"],
                    vec![RawValue::U64(1), RawValue::U64(1_800)],
                ),
                EventType::DeadlineExtended,
            ),
            (
                raw(
                    ["wdraw", "reward"],
                    vec![RawValue::Address("GKEEPER".into()), RawValue::I128(200)],
                ),
                EventType::RewardsWithdrawn,
            ),
            (
                raw(["paused", "admin"], vec![RawValue::Bool(true)]),
                EventType::Paused,
            ),
            (
                raw(
                    ["fee", "admin"],
                    vec![RawValue::U32(100), RawValue::U32(250)],
                ),
                EventType::FeeUpdated,
            ),
            (
                raw(
                    ["admin", "xfer"],
                    vec![
                        RawValue::Address("GOLD".into()),
                        RawValue::Address("GNEW".into()),
                    ],
                ),
                EventType::AdminTransferred,
            ),
            (
                raw(
                    ["minrwd", "admin"],
                    vec![RawValue::I128(0), RawValue::I128(50)],
                ),
                EventType::MinRewardUpdated,
            ),
            (
                raw(
                    ["sweep", "admin"],
                    vec![
                        RawValue::Address("GTREASURY".into()),
                        RawValue::I128(70),
                        RawValue::I128(5),
                    ],
                ),
                EventType::FeesSwept,
            ),
            (
                raw(
                    ["init", "admin"],
                    vec![
                        RawValue::Address("GADMIN".into()),
                        RawValue::Address("GTOKEN".into()),
                        RawValue::U32(100),
                    ],
                ),
                EventType::Initialized,
            ),
            (
                raw(
                    ["upgrade", "admin"],
                    vec![
                        RawValue::Address("GADMIN".into()),
                        RawValue::Bytes("00ff".into()),
                    ],
                ),
                EventType::Upgraded,
            ),
        ];

        assert_eq!(cases.len(), 15, "all fifteen contract events are covered");

        for (event, expected) in cases {
            let parsed = parse_event(&event)
                .expect("parses")
                .expect("topic pair is recognised");
            assert_eq!(parsed.event_type(), expected);
        }
    }

    #[test]
    fn task_registered_fields_land_in_contract_order() {
        let parsed = parse_event(&raw(
            ["reg", "task"],
            vec![
                RawValue::U64(7),
                RawValue::Address("GOWNER".into()),
                RawValue::I128(1_234),
                RawValue::U64(9_999),
            ],
        ))
        .expect("parses")
        .expect("recognised");

        assert_eq!(
            parsed,
            EventPayload::TaskRegistered {
                task_id: 7,
                owner: "GOWNER".into(),
                reward: I128(1_234),
                deadline: 9_999,
            }
        );
    }

    #[test]
    fn an_unknown_topic_pair_is_skipped() {
        let parsed = parse_event(&raw(["mystery", "event"], vec![])).expect("no error");
        assert!(parsed.is_none());
    }

    #[test]
    fn a_truncated_payload_is_an_error_not_a_silent_drop() {
        // A recognised event missing fields means the contract's shape moved;
        // dropping it quietly would leave an unreported gap in the history.
        let err = parse_event(&raw(["reg", "task"], vec![RawValue::U64(1)]))
            .expect_err("truncated payload is rejected");
        assert!(err.to_string().contains("task_registered"));
    }

    #[test]
    fn a_mistyped_field_is_reported_with_its_position() {
        let err = parse_event(&raw(
            ["reg", "task"],
            vec![
                RawValue::U64(1),
                RawValue::Address("GOWNER".into()),
                // reward should be i128
                RawValue::U64(500),
                RawValue::U64(900),
            ],
        ))
        .expect_err("mistyped field is rejected");
        assert!(err.to_string().contains("field 2"));
    }

    #[test]
    fn an_event_with_a_single_topic_is_skipped() {
        let mut event = raw(["reg", "task"], vec![]);
        event.topics = vec!["reg".into()];
        assert!(parse_event(&event).expect("no error").is_none());
    }
}
