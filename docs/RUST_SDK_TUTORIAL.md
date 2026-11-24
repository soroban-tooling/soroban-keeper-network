# Tutorial: use the Rust SDK from a service

You will build a small Rust service that talks to a deployed `keeper-registry`:
it sets up a client, reads tasks, submits a claim, and handles failures
correctly, which mostly means telling **transient** errors (try again) from
**permanent** ones (never try again) and using the SDK's `RetryPolicy` for the
first kind.

The crate is [`soroban-keeper-sdk`](../rust-sdk). It targets native services
and keeper bots written in Rust. For a browser or Node.js app use the
[TypeScript SDK](TS_SDK_TUTORIAL.md).

## Before you start: what the crate does and does not include

Read this once; it shapes the code below.

| Concern | What the crate gives you | What you supply |
|---|---|---|
| Typed calls (`get_task`, `claim_task`, `register_task`, ...) | `KeeperRegistryClient` | Nothing |
| The network | The `RpcTransport` trait | **An implementation** over your Soroban RPC node. The crate bundles no HTTP client. |
| Signing | The `TransactionSigner` trait | **A real signer.** The bundled `KeypairSigner` is a placeholder for local tests: its `sign_payload` returns the payload bytes unchanged, not an ed25519 signature. |
| Retries | `RetryPolicy` and `RpcCallError` | A choice of policy |

Sections 3 and 4 show a transport and a signer you can build on. Treat both as
your own code to test against testnet before trusting them with funds.

> The sample code in sections 2 to 7 was compiled and its tests run against the
> current crate API (stable Rust 1.98; the dependency tree needs Rust 1.88 or newer). The transport in section
> 3 is a skeleton and is the one piece that cannot run until you fill it in.

## 1. Create the project

The crate is not published to crates.io yet, so depend on a checkout of this
repository:

```bash
git clone https://github.com/soroban-tooling/soroban-keeper-network.git
cargo new keeper-service
cd keeper-service
```

```toml
# Cargo.toml
[package]
name = "keeper-service"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-keeper-sdk = { path = "../soroban-keeper-network/rust-sdk" }
# The contract crate supplies `KeeperError`, which the SDK does not re-export.
keeper-registry = { path = "../soroban-keeper-network/contracts/keeper-registry" }
soroban-sdk = "22.0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
ed25519-dalek = "2"
stellar-strkey = "0.0.9"
```

You need a deployed registry's contract id (see [Deploying and running](DEPLOYING.md))
and a funded testnet account for the signing key.

## 2. Wrap the client

Everything above the transport is generic over `T: RpcTransport`, so the same
service code runs against your real transport in production and a scripted
test double in unit tests.

```rust
// src/service.rs
use keeper_registry::KeeperError;
use soroban_keeper_sdk::{
    KeeperRegistryClient, RegistryClientError, RpcTransport, Task, TaskStatus, TransportError,
};
use soroban_sdk::Address;

/// What happened when we tried to claim a task.
#[derive(Debug)]
pub enum ClaimOutcome {
    /// The claim transaction landed.
    Claimed,
    /// Permanent, expected in a competitive network: another keeper holds the
    /// task, it already finished, or its deadline passed. Do not retry.
    NotClaimable(KeeperError),
    /// Permanent, but unexpected: the contract refused for a reason such as a
    /// paused registry or an unmet stake. Log it and alert; retrying the
    /// same call cannot succeed until something changes.
    Rejected(KeeperError),
    /// Transient: the network failed and the client's retry policy is
    /// exhausted. If this came from the *submit* step, the claim may still
    /// have landed. See section 6.
    Unavailable(TransportError),
}

pub struct KeeperService<T: RpcTransport> {
    client: KeeperRegistryClient<T>,
}

impl<T: RpcTransport> KeeperService<T> {
    pub fn new(client: KeeperRegistryClient<T>) -> Self {
        Self { client }
    }

    /// Fetches one task. A task that does not exist is `Ok(None)`, not an
    /// error, because that is an ordinary answer when scanning ids.
    pub async fn task(&self, id: u64) -> Result<Option<Task>, RegistryClientError> {
        match self.client.get_task(id).await {
            Ok(task) => Ok(Some(task)),
            Err(err) if matches!(err.root(), RegistryClientError::Contract(KeeperError::TaskNotFound)) => {
                Ok(None)
            }
            Err(err) => Err(err),
        }
    }

    /// Ids of every task still `Pending`. Task ids run from 1 to `task_count`.
    pub async fn pending_task_ids(&self) -> Result<Vec<u64>, RegistryClientError> {
        let count: u64 = self.client.read("task_count", vec![]).await?;
        let mut pending = Vec::new();
        for id in 1..=count {
            if let Some(task) = self.task(id).await? {
                if task.status == TaskStatus::Pending {
                    pending.push(id);
                }
            }
        }
        Ok(pending)
    }

    /// Submits a claim and sorts the result into something the caller can act on.
    pub async fn claim(&self, task_id: u64) -> Result<ClaimOutcome, RegistryClientError> {
        match self.client.claim_task(task_id).await {
            Ok(()) => Ok(ClaimOutcome::Claimed),
            Err(err) => match err.root() {
                RegistryClientError::Contract(code) => Ok(match code {
                    KeeperError::LockPeriodActive
                    | KeeperError::InvalidTaskStatus
                    | KeeperError::DeadlinePassed
                    | KeeperError::TaskNotFound => ClaimOutcome::NotClaimable(*code),
                    other => ClaimOutcome::Rejected(*other),
                }),
                RegistryClientError::Transport(transport) => Ok(ClaimOutcome::Unavailable(transport.clone())),
                // NoSigner, Signing, Decode, UnknownContractError: a bug or a
                // misconfiguration. Surface it to the caller unchanged.
                _ => Err(err),
            },
        }
    }

    /// Whether the registry is paused. A paused registry rejects every claim.
    pub async fn is_paused(&self) -> Result<bool, RegistryClientError> {
        self.client.is_paused().await
    }
}
```

What this code relies on:

- `get_task`, `is_paused`, `get_fee_bps` are read-only: they **simulate** the
  call and decode the result. Nothing is signed or submitted.
- `read(function, args)` is the generic form of a read. Use it for any
  contract view the crate has no typed method for, passing arguments as
  `ScVal`s. Here it calls `task_count`.
- `claim_task`, `register_task`, `execute_task` and `withdraw_rewards` are
  writes. They simulate, ask the signer to sign the assembled transaction,
  submit it, and decode the result. The configured signer's address is the
  `keeper` (or `owner`) argument automatically.
- Every error arrives wrapped in a `RegistryClientError::InCall`, carrying the
  method name and the debug form of the non-secret arguments, so a log line
  says which call failed. `err.root()` strips the wrapper to the variant you
  match on, and `err.context()` gives you the call.

## 3. Implement the transport

`RpcTransport` is the seam to your Soroban RPC node. It has two required
methods and one optional one:

- `simulate(&InvocationRequest)` returns a `SimulationOutcome`: the decoded
  return value plus the assembled transaction bytes a write must sign. For a
  read the bytes can be empty.
- `submit(&SignedTransaction)` sends the signed transaction and returns the
  contract's result.
- `sleep(Duration)` is the backoff pause between retried simulations. The
  default **blocks the thread**; override it with your runtime's timer.

Failures use `RpcCallError<u32>`: `Transport(..)` when the call never ran the
contract, and `Contract(code)` when the contract ran and returned a
`#[contracterror]` code (the client decodes it into `KeeperError`).

```rust
// src/transport.rs
use std::time::Duration;

use soroban_keeper_sdk::{
    InvocationRequest, RpcCallError, RpcTransport, SignedTransaction, SimulationOutcome,
    TransportError,
};
use soroban_sdk::xdr::ScVal;

/// Skeleton transport for a Soroban RPC node.
///
/// Fill in `simulate` and `submit` with your HTTP client of choice. The
/// mapping rules in the comments are the part that matters for retries.
pub struct SorobanRpcTransport {
    pub rpc_url: String,
}

impl SorobanRpcTransport {
    /// Classify a failure from your HTTP client. Getting this right is what
    /// makes the retry policy safe: only report `Transport` for failures where
    /// the contract did not run.
    pub fn classify_http_failure(timed_out: bool, status: Option<u16>) -> TransportError {
        match (timed_out, status) {
            (true, _) => TransportError::Timeout,
            (_, Some(502 | 503 | 504)) => TransportError::SimulationUnavailable,
            (_, Some(code)) => TransportError::Other(format!("HTTP {code}")),
            (_, None) => TransportError::ConnectionReset,
        }
    }
}

impl RpcTransport for SorobanRpcTransport {
    async fn simulate(
        &self,
        request: &InvocationRequest,
    ) -> Result<SimulationOutcome, RpcCallError<u32>> {
        // 1. Build an unsigned transaction invoking `request.function` on
        //    `request.contract_id` with `request.args`, for
        //    `request.network_passphrase`.
        // 2. POST a `simulateTransaction` JSON-RPC call to `self.rpc_url`.
        //    Map network failures with `classify_http_failure`.
        // 3. If the simulation reports a contract error, return
        //    `Err(RpcCallError::Contract(code))` with the numeric code.
        // 4. Otherwise return the decoded return value, and the assembled
        //    transaction (footprint, resource fee, auth entries) as the bytes
        //    your signer will sign. For a read, empty bytes are fine.
        let _ = request;
        Err(RpcCallError::Transport(TransportError::Other(
            "simulate is not implemented yet".into(),
        )))
    }

    async fn submit(&self, signed: &SignedTransaction) -> Result<ScVal, RpcCallError<u32>> {
        // 1. Attach `signed.signature` to the transaction and send it with
        //    `sendTransaction`.
        // 2. Poll `getTransaction` until it leaves `NOT_FOUND`.
        // 3. On a contract failure return `Err(RpcCallError::Contract(code))`;
        //    on success return the result `ScVal`.
        let _ = signed;
        Err(RpcCallError::Transport(TransportError::Other(
            "submit is not implemented yet".into(),
        )))
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}
```

## 4. Implement a real signer

`TransactionSigner` is two methods: the account's `address()` and
`sign_payload(&[u8])`, which signs exactly the bytes your transport placed in
`SimulationOutcome::transaction`. Stellar signatures are Ed25519 over the
SHA-256 hash of the network-id-prefixed signature payload, so have your
transport hand over that 32-byte hash and sign it unchanged here. Confirm this
against a testnet submission before relying on it.

```rust
// src/signer.rs
use ed25519_dalek::{Signer, SigningKey};
use soroban_keeper_sdk::{SignerError, TransactionSigner};
use soroban_sdk::{Address, Bytes, Env};

pub struct SecretKeySigner {
    env: Env,
    key: SigningKey,
    address: Address,
}

impl SecretKeySigner {
    /// Builds a signer from an `S...` secret seed, such as one read from your
    /// secret store. The seed is not retained in a printable form.
    pub fn from_secret(env: &Env, secret: &str) -> Result<Self, SignerError> {
        let seed = stellar_strkey::ed25519::PrivateKey::from_string(secret)
            .map_err(|_| SignerError::InvalidConfig)?;
        let key = SigningKey::from_bytes(&seed.0);
        let public = stellar_strkey::ed25519::PublicKey(key.verifying_key().to_bytes());
        let address = Address::from_str(env, &public.to_string());
        Ok(Self { env: env.clone(), key, address })
    }
}

impl TransactionSigner for SecretKeySigner {
    fn address(&self) -> Address {
        self.address.clone()
    }

    fn sign_payload(&self, payload: &[u8]) -> Result<Bytes, SignerError> {
        let signature = self.key.sign(payload);
        Ok(Bytes::from_slice(&self.env, &signature.to_bytes()))
    }
}
```

For production keys, prefer a KMS or HSM behind the same two methods. Wrap any
key material your own types hold in the crate's `Redacted<T>` so a derived
`Debug` can never print it.

## 5. Put it together

```rust
// src/main.rs
mod service;
mod signer;
mod transport;

use soroban_keeper_sdk::{KeeperRegistryClient, Network, RetryPolicy};
use soroban_sdk::Env;
use std::time::Duration;

use service::{ClaimOutcome, KeeperService};
use signer::SecretKeySigner;
use transport::SorobanRpcTransport;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let contract_id = std::env::var("REGISTRY_CONTRACT_ID")?;
    let secret = std::env::var("KEEPER_SECRET_KEY")?;

    let network = Network::Testnet;
    let env = Env::default();

    let client = KeeperRegistryClient::new(
        contract_id,
        network.rpc_url(),
        network.network_passphrase(),
        SorobanRpcTransport { rpc_url: network.rpc_url() },
    )
    .with_signer(SecretKeySigner::from_secret(&env, &secret)?)
    .with_retry_policy(RetryPolicy {
        max_attempts: 5,
        base_delay: Duration::from_millis(250),
        ..RetryPolicy::default()
    });

    let service = KeeperService::new(client);

    for id in service.pending_task_ids().await? {
        match service.claim(id).await? {
            ClaimOutcome::Claimed => println!("claimed task {id}"),
            ClaimOutcome::NotClaimable(why) => println!("skipping task {id}: {why:?}"),
            ClaimOutcome::Rejected(why) => eprintln!("task {id} rejected: {why:?}"),
            ClaimOutcome::Unavailable(why) => eprintln!("task {id} unavailable: {why:?}"),
        }
    }
    Ok(())
}
```

`Network` carries the RPC URL and passphrase for `Testnet`, `Futurenet` and
`Mainnet`, plus a `Custom` variant for your own node. Read the secret from your
platform's secret store; never hard-code it or write it to logs.

## 6. Transient versus permanent errors

The SDK sorts every RPC failure into one of two classes with `default_classify`.

| Class | Arrives as | Meaning | What to do |
|---|---|---|---|
| **Transient** | `RpcCallError::Transport(..)`, surfacing as `RegistryClientError::Transport` | The call never ran the contract: timeout, dropped connection, simulation endpoint down. The same request can succeed later. | Retry with backoff. The client already does this for simulation; see below. |
| **Permanent** | `RpcCallError::Contract(code)`, surfacing as `RegistryClientError::Contract(KeeperError)` (or `UnknownContractError(code)`) | The contract ran and rejected the call. It is deterministic. | **Never retry the same call.** Act on the specific `KeeperError`. |

Three other `RegistryClientError` variants are permanent from your point of
view and are not network errors at all: `NoSigner` (you forgot `with_signer`),
`Signing` (the signer failed) and `Decode` (the response was the wrong shape).

Where retries happen, exactly:

- **Simulation is retried** by the client, up to `RetryPolicy::max_attempts`
  attempts in total (default 4), sleeping `base_delay * 2^attempt` plus random
  jitter between them (defaults: 200 ms base, 0 to 200 ms jitter). It stops
  immediately on a permanent error. `RetryPolicy::no_retry()` is a single
  attempt.
- **Submission is never retried.** If `submit` times out you cannot know
  whether the transaction landed. Resubmitting blindly could double-spend a
  sequence number or repeat a claim. After an `Unavailable` result from a
  write, read the task back and decide from its state:

```rust
// src/service.rs (additional method, inside `impl<T: RpcTransport> KeeperService<T>`)
/// After an `Unavailable` claim, did the claim land anyway? `keeper` is the
/// account that attempted it.
pub async fn claim_landed(&self, task_id: u64, keeper: &Address) -> Result<bool, RegistryClientError> {
    Ok(match self.task(task_id).await? {
        Some(task) => task.status == TaskStatus::Claimed && task.claimer.as_ref() == Some(keeper),
        None => false,
    })
}
```

Wrapping your own operation in the same policy, for example a health probe or
a call outside the client, uses `RetryPolicy::run`. It takes your operation, a
classifier, and a sleep function, and never retries a `Permanent` result:

```rust
// src/retry_example.rs
use std::time::Duration;

use soroban_keeper_sdk::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};

/// Treat HTTP 429 as transient and any other HTTP error as permanent, instead
/// of `default_classify`'s "every transport error is transient".
pub fn classify(err: &RpcCallError<u32>) -> ErrorClass {
    match err {
        RpcCallError::Transport(TransportError::Other(message)) if message.starts_with("HTTP 4") => {
            if message == "HTTP 429" { ErrorClass::Transient } else { ErrorClass::Permanent }
        }
        other => default_classify(other),
    }
}

pub async fn probe(policy: &RetryPolicy) -> Result<&'static str, RpcCallError<u32>> {
    policy
        .run(
            || Box::pin(async { Ok("healthy") }),
            classify,
            tokio::time::sleep,
        )
        .await
}

pub fn quick_policy() -> RetryPolicy {
    RetryPolicy { max_attempts: 3, base_delay: Duration::from_millis(100), ..RetryPolicy::default() }
}
```

`default_classify` treats **every** `Transport` error as transient, including
`TransportError::Other(..)`. If your transport can report a failure that will
never succeed (a malformed request, an auth error), either map it to a
non-`Transport` outcome in your transport or use a custom classifier as above,
so the client does not burn its attempts on it.

## 7. Test it without a network

Because the service is generic over `RpcTransport`, a scripted transport lets
you test the error handling deterministically, with no node:

```rust
// src/service_tests.rs
use std::sync::Mutex;

use soroban_keeper_sdk::{
    InvocationRequest, KeeperRegistryClient, RegistryClientError, RetryPolicy, RpcCallError,
    RpcTransport, SignedTransaction, SimulationOutcome, TransportError,
};
use soroban_sdk::xdr::ScVal;
use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::service::{ClaimOutcome, KeeperService};

/// Replays queued simulation results, then queued submit results.
struct Scripted {
    simulations: Mutex<Vec<Result<ScVal, RpcCallError<u32>>>>,
    submissions: Mutex<Vec<Result<ScVal, RpcCallError<u32>>>>,
    simulate_calls: Mutex<u32>,
}

impl Scripted {
    fn new(
        simulations: Vec<Result<ScVal, RpcCallError<u32>>>,
        submissions: Vec<Result<ScVal, RpcCallError<u32>>>,
    ) -> Self {
        Self {
            simulations: Mutex::new(simulations),
            submissions: Mutex::new(submissions),
            simulate_calls: Mutex::new(0),
        }
    }
}

impl RpcTransport for Scripted {
    async fn simulate(
        &self,
        _request: &InvocationRequest,
    ) -> Result<SimulationOutcome, RpcCallError<u32>> {
        *self.simulate_calls.lock().unwrap() += 1;
        let next = self.simulations.lock().unwrap().remove(0);
        next.map(|return_value| SimulationOutcome { return_value, transaction: vec![1, 2, 3] })
    }

    async fn submit(&self, _signed: &SignedTransaction) -> Result<ScVal, RpcCallError<u32>> {
        self.submissions.lock().unwrap().remove(0)
    }

    async fn sleep(&self, _duration: std::time::Duration) {}
}

fn service(transport: Scripted) -> KeeperService<Scripted> {
    let env = Env::default();
    let signer = soroban_keeper_sdk::KeypairSigner::new(Address::generate(&env));
    let client = KeeperRegistryClient::new("CTEST", "http://localhost", "Test", transport)
        .with_signer(signer)
        .with_retry_policy(RetryPolicy { max_attempts: 3, ..RetryPolicy::no_retry() });
    KeeperService::new(client)
}

const LOCK_PERIOD_ACTIVE: u32 = 9;

#[tokio::test]
async fn a_transient_simulation_failure_is_retried_then_succeeds() {
    let transport = Scripted::new(
        vec![Err(RpcCallError::Transport(TransportError::Timeout)), Ok(ScVal::Bool(false))],
        vec![],
    );
    let svc = service(transport);
    assert!(!svc.is_paused().await.unwrap());
}

#[tokio::test]
async fn exhausting_the_policy_surfaces_the_transport_error() {
    let timeout = || Err(RpcCallError::Transport(TransportError::Timeout));
    let svc = service(Scripted::new(vec![timeout(), timeout(), timeout()], vec![]));
    let err = svc.is_paused().await.unwrap_err();
    assert!(matches!(err.root(), RegistryClientError::Transport(TransportError::Timeout)));
}

#[tokio::test]
async fn a_contract_rejection_is_permanent_and_not_retried() {
    // Only one simulation is queued: a retry would panic on the empty queue.
    let svc = service(Scripted::new(vec![Err(RpcCallError::Contract(LOCK_PERIOD_ACTIVE))], vec![]));
    let outcome = svc.claim(7).await.unwrap();
    assert!(matches!(outcome, ClaimOutcome::NotClaimable(_)));
}

#[tokio::test]
async fn a_lost_submission_is_never_resubmitted() {
    let svc = service(Scripted::new(
        vec![Ok(ScVal::Void)],
        vec![Err(RpcCallError::Transport(TransportError::Timeout))],
    ));
    let outcome = svc.claim(7).await.unwrap();
    assert!(matches!(outcome, ClaimOutcome::Unavailable(TransportError::Timeout)));
}
```

Add `mod service_tests;` under `#[cfg(test)]` in `main.rs` and run `cargo test`.
The four tests pin down the rules from section 6: transient simulation errors
are retried, the policy is bounded, contract rejections are never retried, and
a submission that times out is reported, not repeated.

## Where to go next

- [Rust SDK README](../rust-sdk/README.md) and the module docs
  (`cargo doc --open -p soroban-keeper-sdk`).
- [`rust-sdk/tests/registry_client_tests.rs`](../rust-sdk/tests/registry_client_tests.rs):
  the same client run against the real contract in Soroban's local test
  environment through an in-process transport.
- [Batch operations](BATCH_OPERATIONS.md) for registering many tasks in one call.
- [Operating keeper-bot-v2](OPERATING_KEEPER_BOT_V2.md) for the production
  concerns (signing pools, fee ceilings, withdrawals) a keeper service shares
  with the reference bot.
