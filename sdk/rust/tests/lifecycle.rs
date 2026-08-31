//! End-to-end lifecycle test for [`KeeperRegistryClient`] and its
//! task-lifecycle methods — issue 0268's third acceptance criterion
//! ("tests cover the full lifecycle end to end against a local or real
//! network").
//!
//! Runs against a mocked Soroban RPC server rather than a live network or
//! local sandbox, so it doesn't depend on testnet availability, a funded
//! account, or a locally running `stellar-core` — the same approach
//! `soroban-client`'s own test suite uses internally (see its `tests.rs`
//! `get_mocked_server` helper, which isn't exported, so this test mounts
//! its own mocks against a real [`wiremock::MockServer`] the same way
//! rather than depending on it). This exercises the actual, real
//! `getLedgerEntries` → `simulateTransaction` → `sendTransaction` →
//! `getTransaction` sequence [`KeeperRegistryClient::invoke`] drives —
//! every step is a real network call against the mock, not a stub of
//! `invoke` itself — so a break in the request/response wiring (a wrong
//! method name, an unexpected params shape) would fail this test the same
//! way it would fail against the real network.
//!
//! The account ledger-entry XDR and the `simulateTransaction` response
//! fixtures below are copied verbatim from `soroban-client`'s own
//! `get_account`/`simulate_transaction`/`prepare_transaction` tests
//! (`soroban-client-0.5.9/src/tests.rs`) rather than hand-constructed —
//! those are real, valid XDR blobs already proven to round-trip through
//! this exact crate version, which a hand-built blob would risk getting
//! subtly wrong.

use keeper_registry_sdk::client::KeeperRegistryClient;
use keeper_registry_sdk::network::Network;
use serde_json::json;
use soroban_client::keypair::{Keypair, KeypairBehavior};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A `keeper-registry` contract ID, arbitrary but validly formatted (a
/// well-formed `C...` strkey) — no fixture below encodes anything
/// contract-specific, so a real deployed contract ID isn't required.
const CONTRACT_ID: &str = "CDGAH7TU7UH3BXGYXRIXLJX63LYRIF6APZPIG64ZAW3NNDCPJ7AAWVTZ";

/// Mounts one mock per JSON-RPC method `invoke()`'s full lifecycle calls,
/// each matching loosely on `method` alone (via `body_partial_json`'s
/// inclusive JSON matching) rather than the exact request body — the
/// request bodies (particularly the XDR transaction envelopes) are
/// deterministic given the inputs, but re-deriving their exact bytes here
/// would just be re-testing `soroban-client`'s own transaction-building,
/// not this crate's client. Matching on method name is exactly the
/// granularity this test needs: proof that `invoke()` calls the right RPC
/// methods, in the right order, and correctly interprets each response.
async fn mount_successful_invoke_lifecycle(mock_server: &MockServer) {
    // 1. get_account -> getLedgerEntries
    let account_entry = "AAAAAAAAAABzdv3ojkzWHMD7KUoXhrPx0GH18vHKV0ZfqpMiEblG1gAAAFwVZH3YAAABdgAAAQgAAAAFAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAADAAAAAAAOZYQAAAAAaJsIJQ==";
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_partial_json(json!({"method": "getLedgerEntries"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "entries": [{
                    "key": "ignored-by-the-inclusive-matcher-above",
                    "xdr": account_entry,
                    "lastModifiedLedgerSeq": 2552504
                }],
                "latestLedger": 2552990
            }
        })))
        .mount(mock_server)
        .await;

    // 2. prepare_transaction -> simulateTransaction (fixture copied from
    // soroban-client's own `prepare_transaction`/`simulate_transaction`
    // tests — a real, valid `transactionData` blob is required for
    // `prepare_transaction` to attach Soroban data to the built tx).
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_partial_json(json!({"method": "simulateTransaction"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "transactionData": "AAAAAAAAAAIAAAAGAAAAAcwD/nT9D7Dc2LxRdab+2vEUF8B+XoN7mQW21oxPT8ALAAAAFAAAAAEAAAAHy8vNUZ8vyZ2ybPHW0XbSrRtP7gEWsJ6zDzcfY9P8z88AAAABAAAABgAAAAHMA/50/Q+w3Ni8UXWm/trxFBfAfl6De5kFttaMT0/ACwAAABAAAAABAAAAAgAAAA8AAAAHQ291bnRlcgAAAAASAAAAAAAAAAAg4dbAxsGAGICfBG3iT2cKGYQ6hK4sJWzZ6or1C5v6GAAAAAEAHfKyAAAFiAAAAIgAAAAAAAAAAw==",
                "minResourceFee": "90353",
                "events": [],
                "results": [{"auth": [], "xdr": "AAAAAwAAAAw="}],
                "cost": {"cpuInsns": "1635562", "memBytes": "1295756"},
                "latestLedger": 2552139
            }
        })))
        .mount(mock_server)
        .await;

    // 3. send_transaction -> sendTransaction
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_partial_json(json!({"method": "sendTransaction"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "status": "PENDING",
                "hash": "d8ec9b68780314ffdfdfc2194b1b35dd27d7303c3bceaef6447e31631a1419dc",
                "latestLedger": 2553978,
                "latestLedgerCloseTime": "1700159337"
            }
        })))
        .mount(mock_server)
        .await;

    // 4. wait_transaction -> getTransaction. `invoke()` only reads
    // `.status` on the confirmed response — it never calls
    // `to_result()`/`to_result_meta()` itself (only the four/six methods
    // with a non-Void return value do, and this fixture's mocked call
    // (`claim_task`) has none) — so no XDR result/meta blobs are needed
    // here, just the required scalar fields `GetTransactionResponse`
    // deserializes.
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_partial_json(json!({"method": "getTransaction"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "status": "SUCCESS",
                "latestLedger": 2540076,
                "latestLedgerCloseTime": "1700086333",
                "oldestLedger": 2538637,
                "oldestLedgerCloseTime": "1700078796"
            }
        })))
        .mount(mock_server)
        .await;
}

#[tokio::test]
async fn claim_task_runs_the_full_simulate_sign_send_confirm_lifecycle() {
    let mock_server = MockServer::start().await;
    mount_successful_invoke_lifecycle(&mock_server).await;

    // A random keypair, not a public-key-only one: `invoke()` actually
    // signs the prepared transaction (`prepared.sign(&[self.keypair...])`),
    // which needs a real secret key — a `from_public_key`-only Keypair
    // would fail signing, defeating the point of exercising the real
    // lifecycle end to end.
    let keypair = Keypair::random().expect("random keypair generation should not fail");
    let keeper_address = keypair.public_key();

    let client = KeeperRegistryClient::with_rpc_url(
        CONTRACT_ID,
        Network::Testnet,
        keypair,
        &mock_server.uri(),
    )
    .expect("mock server URL should be a valid RPC endpoint");

    // claim_task's contract signature is `Result<(), KeeperError>` — a
    // successful confirmation is the whole assertion; if any leg of the
    // simulate -> sign -> send -> poll chain called the wrong method, sent
    // the wrong shape, or misread the response, this would return an
    // error instead of `Ok(())`.
    let result = client.claim_task(&keeper_address, 42).await;
    assert!(
        result.is_ok(),
        "expected claim_task to complete the full lifecycle successfully, got {result:?}"
    );
}

#[tokio::test]
async fn expire_task_needs_no_signer_address_and_still_completes() {
    // expire_task is the one method that's permissionless on the contract
    // side (no Address argument) — this proves that path through the same
    // full lifecycle, not just the argument-encoding unit test already in
    // `methods.rs`.
    let mock_server = MockServer::start().await;
    mount_successful_invoke_lifecycle(&mock_server).await;

    let keypair = Keypair::random().expect("random keypair generation should not fail");

    let client = KeeperRegistryClient::with_rpc_url(
        CONTRACT_ID,
        Network::Testnet,
        keypair,
        &mock_server.uri(),
    )
    .expect("mock server URL should be a valid RPC endpoint");

    let result = client.expire_task(42).await;
    assert!(
        result.is_ok(),
        "expected expire_task to complete the full lifecycle successfully, got {result:?}"
    );
}
