//! Typed event decoders for Keeper Registry contract events.

use soroban_sdk::xdr::ScVal;
use soroban_sdk::{Address, Bytes, Env, Symbol, TryFromVal, Val};

#[derive(Debug, Clone, PartialEq)]
pub struct TaskRegisteredEvent {
    pub task_id: u64,
    pub owner: Address,
    pub reward: i128,
    pub deadline: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskClaimedEvent {
    pub task_id: u64,
    pub keeper: Address,
    pub ledger_sequence: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskExecutedEvent {
    pub task_id: u64,
    pub keeper: Address,
    pub net_reward: i128,
    pub proof: Bytes,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskExpiredEvent {
    pub task_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskCancelledEvent {
    pub task_id: u64,
    pub owner: Address,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RewardsWithdrawnEvent {
    pub keeper: Address,
    pub amount: i128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PausedEvent {
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeesSweptEvent {
    pub recipient: Address,
    pub amount: i128,
    pub remaining: i128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub reward_token: Address,
    pub fee_bps: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KeeperEvent {
    TaskRegistered(TaskRegisteredEvent),
    TaskClaimed(TaskClaimedEvent),
    TaskExecuted(TaskExecutedEvent),
    TaskExpired(TaskExpiredEvent),
    TaskCancelled(TaskCancelledEvent),
    RewardsWithdrawn(RewardsWithdrawnEvent),
    Paused(PausedEvent),
    FeesSwept(FeesSweptEvent),
    Initialized(InitializedEvent),
}

#[derive(Debug, thiserror::Error)]
pub enum EventDecodeError {
    #[error("Unknown event topic: ({0:?}, {1:?})")]
    UnknownTopic(Symbol, Symbol),
    #[error("Malformed event payload")]
    MalformedPayload,
}

/// Decode one registry contract event returned by Soroban RPC `getEvents`.
///
/// The first two topics identify the event. The payload is decoded using the
/// same Soroban tuple representation emitted by the contract. Unknown topics
/// and malformed values are errors so callers never silently lose an event.
pub fn decode_event(
    env: &Env,
    topics: &[ScVal],
    value: &ScVal,
) -> Result<KeeperEvent, EventDecodeError> {
    if topics.len() < 2 {
        return Err(EventDecodeError::MalformedPayload);
    }

    let first: Symbol = decode(env, &topics[0])?;
    let second: Symbol = decode(env, &topics[1])?;
    let pair = (
        first.to_string().to_string(),
        second.to_string().to_string(),
    );

    match (pair.0.as_str(), pair.1.as_str()) {
        ("reg", "task") => {
            let (task_id, owner, reward, deadline) = decode(env, value)?;
            Ok(KeeperEvent::TaskRegistered(TaskRegisteredEvent {
                task_id,
                owner,
                reward,
                deadline,
            }))
        }
        ("claim", "task") => {
            let (task_id, keeper, ledger_sequence) = decode(env, value)?;
            Ok(KeeperEvent::TaskClaimed(TaskClaimedEvent {
                task_id,
                keeper,
                ledger_sequence,
            }))
        }
        ("exec", "task") => {
            let (task_id, keeper, net_reward, proof) = decode(env, value)?;
            Ok(KeeperEvent::TaskExecuted(TaskExecutedEvent {
                task_id,
                keeper,
                net_reward,
                proof,
            }))
        }
        ("exp", "task") => {
            let (task_id,) = decode(env, value)?;
            Ok(KeeperEvent::TaskExpired(TaskExpiredEvent { task_id }))
        }
        ("cancel", "task") => {
            let (task_id, owner) = decode(env, value)?;
            Ok(KeeperEvent::TaskCancelled(TaskCancelledEvent {
                task_id,
                owner,
            }))
        }
        ("wdraw", "reward") => {
            let (keeper, amount) = decode(env, value)?;
            Ok(KeeperEvent::RewardsWithdrawn(RewardsWithdrawnEvent {
                keeper,
                amount,
            }))
        }
        ("paused", "admin") => {
            let (paused,) = decode(env, value)?;
            Ok(KeeperEvent::Paused(PausedEvent { paused }))
        }
        ("sweep", "admin") => {
            let (recipient, amount, remaining) = decode(env, value)?;
            Ok(KeeperEvent::FeesSwept(FeesSweptEvent {
                recipient,
                amount,
                remaining,
            }))
        }
        ("init", "admin") => {
            let (admin, reward_token, fee_bps) = decode(env, value)?;
            Ok(KeeperEvent::Initialized(InitializedEvent {
                admin,
                reward_token,
                fee_bps,
            }))
        }
        _ => Err(EventDecodeError::UnknownTopic(first, second)),
    }
}

fn decode<T>(env: &Env, value: &ScVal) -> Result<T, EventDecodeError>
where
    T: TryFromVal<Env, Val>,
{
    let value = Val::try_from_val(env, value).map_err(|_| EventDecodeError::MalformedPayload)?;
    T::try_from_val(env, &value).map_err(|_| EventDecodeError::MalformedPayload)
}
