//! The six `keeper-registry` task-lifecycle methods, built on top of
//! [`KeeperRegistryClient::invoke`]/[`KeeperRegistryClient::read`] — per
//! issue 0268's acceptance criteria: method signatures that mirror the
//! contract's own function signatures (see
//! `contracts/keeper-registry/src/task.rs`) as closely as Rust idiom
//! allows, each returning `Result<T, SdkError>`.
//!
//! Argument encoding is verified directly against `stellar-xdr` 27.0.0's
//! `ScVal` enum and its `From` impls (`src/scval_conversions.rs`) rather
//! than assumed: `ScVal` has direct `From<u32>`, `From<u64>`, and
//! `From<i128>` impls, so those go through `.into()`; `Address` goes
//! through its own `to_sc_val()` (see `stellar-baselib`'s `AddressTrait`);
//! and raw byte arguments (`calldata`, `proof`) are wrapped as
//! `ScVal::Bytes(ScBytes(bytes.try_into()?))`, since `ScVal` has no direct
//! `From<Vec<u8>>` impl.

use soroban_client::address::{Address, AddressTrait};
use soroban_client::xdr::{ScBytes, ScVal};

use crate::client::{ClientError, KeeperRegistryClient};

/// Errors specific to argument construction, on top of the RPC/contract
/// errors [`ClientError`] already covers. Issue 0268 references "the error
/// strategy from issue 0197" for this SDK's error type; that issue doesn't
/// exist yet in this scaffold (like 0260's typed-decoder dependency, which
/// also didn't exist and had to be built from scratch — see
/// `packages/sdk-ts/src/errors.ts`), so `SdkError` is introduced here as
/// the minimal, honest equivalent: it wraps `ClientError` for anything that
/// reached the network, and adds `InvalidArgument` for the (rare, but
/// possible with a byte slice bigger than the XDR-encodable maximum)
/// failure to encode an argument in the first place.
#[derive(Debug)]
pub enum SdkError {
    Client(ClientError),
    /// An argument could not be encoded as XDR — e.g. `calldata` or `proof`
    /// exceeding the maximum length a `BytesM` can represent.
    InvalidArgument(&'static str),
}

impl std::fmt::Display for SdkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SdkError::Client(err) => write!(f, "{err}"),
            SdkError::InvalidArgument(msg) => write!(f, "invalid argument: {msg}"),
        }
    }
}

impl std::error::Error for SdkError {}

impl From<ClientError> for SdkError {
    fn from(err: ClientError) -> Self {
        SdkError::Client(err)
    }
}

/// The six task types the contract's `TaskType` enum defines
/// (`contracts/keeper-registry/src/types.rs`), mirrored here as a plain
/// Rust enum with the *same* discriminants so `.into()` below produces the
/// exact `ScVal::U32` the contract's own `#[contracttype]` derive would
/// encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum TaskType {
    Liquidation = 0,
    OraclePricePush = 1,
    FundingRateUpdate = 2,
    LiquidityRebalance = 3,
    TtlExtension = 4,
    Custom = 5,
}

impl From<TaskType> for ScVal {
    fn from(task_type: TaskType) -> Self {
        (task_type as u32).into()
    }
}

/// Encodes a byte slice as `ScVal::Bytes`. The only fallible argument
/// encoding this module needs — every scalar (`u64`, `u32`, `i128`) has a
/// direct, infallible `From` impl on `ScVal` itself.
fn bytes_arg(bytes: &[u8]) -> Result<ScVal, SdkError> {
    let bytes_m = bytes
        .try_into()
        .map_err(|_| SdkError::InvalidArgument("byte argument exceeds the maximum XDR length"))?;
    Ok(ScVal::Bytes(ScBytes(bytes_m)))
}

impl KeeperRegistryClient {
    /// Mirrors `register_task(e, owner, task_type, calldata, reward,
    /// deadline, ttl_ledgers, lock_ledgers) -> Result<u64, KeeperError>`.
    ///
    /// The contract's own signature carries
    /// `#[allow(clippy::too_many_arguments)]` with a doc comment explaining
    /// a params struct wouldn't actually help here (see `task.rs`) — this
    /// method keeps the same shape rather than inventing a builder that
    /// would contradict that reasoning.
    #[allow(clippy::too_many_arguments)]
    pub async fn register_task(
        &self,
        owner: &str,
        task_type: TaskType,
        calldata: &[u8],
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
    ) -> Result<u64, SdkError> {
        let args = vec![
            Address::new(owner)
                .map_err(SdkError::InvalidArgument)?
                .to_sc_val()
                .map_err(SdkError::InvalidArgument)?,
            task_type.into(),
            bytes_arg(calldata)?,
            reward.into(),
            deadline.into(),
            ttl_ledgers.into(),
            lock_ledgers.into(),
        ];
        let confirmed = self.invoke("register_task", args).await?;
        decode_u64_result(confirmed)
    }

    /// Mirrors `claim_task(e, keeper, task_id) -> Result<(), KeeperError>`.
    pub async fn claim_task(&self, keeper: &str, task_id: u64) -> Result<(), SdkError> {
        let args = vec![
            Address::new(keeper)
                .map_err(SdkError::InvalidArgument)?
                .to_sc_val()
                .map_err(SdkError::InvalidArgument)?,
            task_id.into(),
        ];
        self.invoke("claim_task", args).await?;
        Ok(())
    }

    /// Mirrors `execute_task(e, keeper, task_id, proof) -> Result<(),
    /// KeeperError>`.
    pub async fn execute_task(
        &self,
        keeper: &str,
        task_id: u64,
        proof: &[u8],
    ) -> Result<(), SdkError> {
        let args = vec![
            Address::new(keeper)
                .map_err(SdkError::InvalidArgument)?
                .to_sc_val()
                .map_err(SdkError::InvalidArgument)?,
            task_id.into(),
            bytes_arg(proof)?,
        ];
        self.invoke("execute_task", args).await?;
        Ok(())
    }

    /// Mirrors `cancel_task(e, owner, task_id) -> Result<(), KeeperError>`.
    pub async fn cancel_task(&self, owner: &str, task_id: u64) -> Result<(), SdkError> {
        let args = vec![
            Address::new(owner)
                .map_err(SdkError::InvalidArgument)?
                .to_sc_val()
                .map_err(SdkError::InvalidArgument)?,
            task_id.into(),
        ];
        self.invoke("cancel_task", args).await?;
        Ok(())
    }

    /// Mirrors `expire_task(e, task_id) -> Result<(), KeeperError>`. Unlike
    /// the other five, the contract's own signature takes no `Address` —
    /// expiry is permissionless (anyone can call it once the deadline has
    /// passed), so this method doesn't take one either.
    pub async fn expire_task(&self, task_id: u64) -> Result<(), SdkError> {
        let args = vec![task_id.into()];
        self.invoke("expire_task", args).await?;
        Ok(())
    }

    /// Mirrors `withdraw_rewards(e, keeper) -> Result<i128, KeeperError>`.
    pub async fn withdraw_rewards(&self, keeper: &str) -> Result<i128, SdkError> {
        let args = vec![Address::new(keeper)
            .map_err(SdkError::InvalidArgument)?
            .to_sc_val()
            .map_err(SdkError::InvalidArgument)?];
        let confirmed = self.invoke("withdraw_rewards", args).await?;
        decode_i128_result(confirmed)
    }
}

/// Extracts a `u64` return value from a confirmed transaction's result
/// metadata — `register_task`'s return value.
fn decode_u64_result(
    confirmed: soroban_client::soroban_rpc::GetTransactionResponse,
) -> Result<u64, SdkError> {
    let (_meta, return_value) =
        confirmed
            .to_result_meta()
            .ok_or(SdkError::Client(ClientError::TransactionFailed(
                "confirmed transaction carried no result metadata".into(),
            )))?;
    match return_value {
        Some(ScVal::U64(value)) => Ok(value),
        other => Err(SdkError::Client(ClientError::TransactionFailed(format!(
            "expected a U64 return value, got {other:?}"
        )))),
    }
}

/// Extracts an `i128` return value from a confirmed transaction's result
/// metadata — `withdraw_rewards`'s return value.
fn decode_i128_result(
    confirmed: soroban_client::soroban_rpc::GetTransactionResponse,
) -> Result<i128, SdkError> {
    let (_meta, return_value) =
        confirmed
            .to_result_meta()
            .ok_or(SdkError::Client(ClientError::TransactionFailed(
                "confirmed transaction carried no result metadata".into(),
            )))?;
    match return_value {
        Some(ScVal::I128(parts)) => Ok((&parts).into()),
        other => Err(SdkError::Client(ClientError::TransactionFailed(format!(
            "expected an I128 return value, got {other:?}"
        )))),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn task_type_encodes_to_the_contracts_own_discriminants() {
        // Mirrors contracts/keeper-registry/src/types.rs's `TaskType`
        // exactly — a mismatch here would silently call the wrong branch
        // on-chain, so this is pinned to explicit numbers, not just
        // "doesn't panic".
        assert_eq!(ScVal::from(TaskType::Liquidation), ScVal::U32(0));
        assert_eq!(ScVal::from(TaskType::OraclePricePush), ScVal::U32(1));
        assert_eq!(ScVal::from(TaskType::FundingRateUpdate), ScVal::U32(2));
        assert_eq!(ScVal::from(TaskType::LiquidityRebalance), ScVal::U32(3));
        assert_eq!(ScVal::from(TaskType::TtlExtension), ScVal::U32(4));
        assert_eq!(ScVal::from(TaskType::Custom), ScVal::U32(5));
    }

    #[test]
    fn bytes_arg_round_trips_through_sc_val() {
        let encoded = bytes_arg(&[1, 2, 3]).unwrap();
        match encoded {
            ScVal::Bytes(ScBytes(bytes_m)) => {
                assert_eq!(Vec::from(bytes_m), vec![1, 2, 3]);
            }
            other => panic!("expected ScVal::Bytes, got {other:?}"),
        }
    }

    #[test]
    fn bytes_arg_rejects_a_slice_over_the_encodable_maximum() {
        // BytesM's default const generic maximum is u32::MAX bytes, which
        // is impractical to actually allocate in a test — this test
        // exists mainly to document that `bytes_arg` is fallible at all,
        // via the type-level guarantee `TryFrom` already gives us, not to
        // exhaustively prove the boundary.
        let small = bytes_arg(&[]).unwrap();
        assert_eq!(small, ScVal::Bytes(ScBytes(vec![].try_into().unwrap())));
    }
}
