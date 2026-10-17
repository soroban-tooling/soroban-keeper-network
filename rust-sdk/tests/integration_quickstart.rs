//! Opt-in end-to-end test against a local Stellar Quickstart network.

use soroban_keeper_sdk::{
    InvocationRequest, KeeperRegistryClient, KeypairSigner, RpcCallError, RpcTransport,
    SignedTransaction, SimulationOutcome, TaskType, TransportError,
};
use soroban_sdk::xdr::{Int128Parts, ScVal};
use soroban_sdk::{Address, Bytes, Env, String as SorobanString, TryFromVal, Val};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const PASSPHRASE: &str = "Standalone Network ; February 2017";
const REWARD: i128 = 1_000_000;
const FEE_BPS: i128 = 100;

struct Quickstart {
    rpc_url: String,
    config_dir: PathBuf,
    registry_id: String,
    token_id: String,
    owner: String,
    keeper: String,
}

impl Quickstart {
    fn provision(rpc_url: String) -> Self {
        let config_dir =
            std::env::temp_dir().join(format!("skn-rust-sdk-quickstart-{}", std::process::id()));
        std::fs::create_dir_all(&config_dir).expect("create Stellar CLI config directory");

        for (name, seed) in [("admin", "1101"), ("owner", "1102"), ("keeper", "1103")] {
            run(
                &config_dir,
                ["keys", "generate", name, "--seed", seed, "--overwrite"],
            );
            run_network(&config_dir, &rpc_url, ["keys", "fund", name]);
        }

        let admin = address(&config_dir, "admin");
        let owner = address(&config_dir, "owner");
        let keeper = address(&config_dir, "keeper");
        let token_id = output_text(run_network(
            &config_dir,
            &rpc_url,
            ["contract", "id", "asset", "--asset", "native"],
        ));
        let wasm =
            workspace_root().join("target/wasm32-unknown-unknown/release/keeper_registry.wasm");
        assert!(
            wasm.is_file(),
            "build keeper-registry for wasm32-unknown-unknown before running this test"
        );
        let registry_id = output_text(run_network_owned(
            &config_dir,
            vec![
                "contract".into(),
                "deploy".into(),
                "--wasm".into(),
                wasm.display().to_string(),
                "--source-account".into(),
                "admin".into(),
                "--rpc-url".into(),
                rpc_url.clone(),
                "--network-passphrase".into(),
                PASSPHRASE.into(),
            ],
        ));

        invoke(
            &config_dir,
            &rpc_url,
            &registry_id,
            "admin",
            &[
                "initialize",
                "--admin",
                &admin,
                "--reward_token",
                &token_id,
                "--fee_bps",
                &FEE_BPS.to_string(),
            ],
            false,
        );

        Self {
            rpc_url,
            config_dir,
            registry_id,
            token_id,
            owner,
            keeper,
        }
    }

    fn balance(&self, address: &str) -> i128 {
        let output = invoke(
            &self.config_dir,
            &self.rpc_url,
            &self.token_id,
            "owner",
            &["balance", "--id", address],
            true,
        );
        scalar(&output_text(output)).parse().expect("token balance")
    }
}

#[derive(Clone)]
struct CliTransport {
    rpc_url: String,
    config_dir: PathBuf,
    source: String,
}

impl CliTransport {
    fn new(rpc_url: String, config_dir: PathBuf, source: &str) -> Self {
        Self {
            rpc_url,
            config_dir,
            source: source.to_string(),
        }
    }

    fn invoke(
        &self,
        request: &InvocationRequest,
        build_only: bool,
    ) -> Result<Output, RpcCallError<u32>> {
        let args = self
            .contract_args(request)
            .map_err(RpcCallError::Transport)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        Ok(invoke(
            &self.config_dir,
            &self.rpc_url,
            &request.contract_id,
            &self.source,
            &refs,
            build_only,
        ))
    }

    fn contract_args(&self, request: &InvocationRequest) -> Result<Vec<String>, TransportError> {
        let env = Env::default();
        let decode_error = || TransportError::Other("could not decode invocation argument".into());
        let address = |value: &ScVal| -> Result<String, TransportError> {
            Ok(decode::<Address>(&env, value)
                .map_err(|_| decode_error())?
                .to_string()
                .to_string())
        };
        let number = |value: &ScVal| -> Result<String, TransportError> {
            decode::<i128>(&env, value)
                .map(|value| value.to_string())
                .map_err(|_| decode_error())
        };

        match request.function.as_str() {
            "register_task" => {
                let task_type =
                    decode::<TaskType>(&env, &request.args[1]).map_err(|_| decode_error())?;
                let calldata =
                    decode::<Bytes>(&env, &request.args[2]).map_err(|_| decode_error())?;
                let verifier = decode::<Option<Address>>(&env, &request.args[7])
                    .map_err(|_| decode_error())?
                    .map(|value| value.to_string().to_string())
                    .unwrap_or_else(|| "null".into());
                Ok(vec![
                    "register_task".into(),
                    "--owner".into(),
                    address(&request.args[0])?,
                    "--task_type".into(),
                    format!("{task_type:?}"),
                    "--calldata".into(),
                    calldata.iter().map(|byte| format!("{byte:02x}")).collect(),
                    "--reward".into(),
                    number(&request.args[3])?,
                    "--deadline".into(),
                    decode::<u64>(&env, &request.args[4])
                        .map_err(|_| decode_error())?
                        .to_string(),
                    "--ttl_ledgers".into(),
                    decode::<u32>(&env, &request.args[5])
                        .map_err(|_| decode_error())?
                        .to_string(),
                    "--lock_ledgers".into(),
                    decode::<u32>(&env, &request.args[6])
                        .map_err(|_| decode_error())?
                        .to_string(),
                    "--verifier".into(),
                    verifier,
                ])
            }
            "claim_task" => Ok(vec![
                "claim_task".into(),
                "--keeper".into(),
                address(&request.args[0])?,
                "--task_id".into(),
                decode::<u64>(&env, &request.args[1])
                    .map_err(|_| decode_error())?
                    .to_string(),
            ]),
            "execute_task" => {
                let proof = decode::<Bytes>(&env, &request.args[2]).map_err(|_| decode_error())?;
                Ok(vec![
                    "execute_task".into(),
                    "--keeper".into(),
                    address(&request.args[0])?,
                    "--task_id".into(),
                    decode::<u64>(&env, &request.args[1])
                        .map_err(|_| decode_error())?
                        .to_string(),
                    "--proof".into(),
                    proof.iter().map(|byte| format!("{byte:02x}")).collect(),
                ])
            }
            "withdraw_rewards" => Ok(vec![
                "withdraw_rewards".into(),
                "--keeper".into(),
                address(&request.args[0])?,
            ]),
            other => Err(TransportError::Other(format!(
                "unsupported integration invocation: {other}"
            ))),
        }
    }
}

impl RpcTransport for CliTransport {
    async fn simulate(
        &self,
        request: &InvocationRequest,
    ) -> Result<SimulationOutcome, RpcCallError<u32>> {
        let output = self.invoke(request, true)?;
        Ok(SimulationOutcome {
            return_value: ScVal::Void,
            transaction: output.stdout,
        })
    }

    async fn submit(&self, signed: &SignedTransaction) -> Result<ScVal, RpcCallError<u32>> {
        let output = self.invoke(&signed.request, false)?;
        let result = scalar(&output_text(output));
        match signed.request.function.as_str() {
            "register_task" => result
                .parse::<u64>()
                .map(ScVal::U64)
                .map_err(|error| transport(error.to_string())),
            "withdraw_rewards" => result
                .parse::<i128>()
                .map(|value| {
                    ScVal::I128(Int128Parts {
                        hi: (value >> 64) as i64,
                        lo: value as u64,
                    })
                })
                .map_err(|error| transport(error.to_string())),
            _ => Ok(ScVal::Void),
        }
    }
}

#[tokio::test]
async fn full_registry_lifecycle_against_quickstart() {
    let rpc_url = match std::env::var("SKN_INTEGRATION_RPC_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("skipping: SKN_INTEGRATION_RPC_URL is not set");
            return;
        }
    };
    let quickstart = Quickstart::provision(rpc_url.clone());
    let env = Env::default();
    let owner_address = Address::from_string(&SorobanString::from_str(&env, &quickstart.owner));
    let keeper_address = Address::from_string(&SorobanString::from_str(&env, &quickstart.keeper));
    let owner = KeeperRegistryClient::new(
        &quickstart.registry_id,
        &rpc_url,
        PASSPHRASE,
        CliTransport::new(rpc_url.clone(), quickstart.config_dir.clone(), "owner"),
    )
    .with_signer(KeypairSigner::new(owner_address));
    let keeper = KeeperRegistryClient::new(
        &quickstart.registry_id,
        &rpc_url,
        PASSPHRASE,
        CliTransport::new(rpc_url.clone(), quickstart.config_dir.clone(), "keeper"),
    )
    .with_signer(KeypairSigner::new(keeper_address));

    assert_eq!(quickstart.balance(&quickstart.registry_id), 0);
    let task_id = owner
        .register_task(
            TaskType::Custom,
            Bytes::from_slice(&env, &[0x01]),
            REWARD,
            4_102_444_800,
            1_000,
            12,
            None,
        )
        .await
        .expect("register task");
    assert_eq!(quickstart.balance(&quickstart.registry_id), REWARD);

    keeper.claim_task(task_id).await.expect("claim task");
    assert_eq!(quickstart.balance(&quickstart.registry_id), REWARD);

    keeper
        .execute_task(task_id, Bytes::from_slice(&env, &[0xaa]))
        .await
        .expect("execute task");
    assert_eq!(quickstart.balance(&quickstart.registry_id), REWARD);

    let withdrawn = keeper.withdraw_rewards().await.expect("withdraw rewards");
    let protocol_fee = REWARD * FEE_BPS / 10_000;
    assert_eq!(withdrawn, REWARD - protocol_fee);
    assert_eq!(quickstart.balance(&quickstart.registry_id), protocol_fee);
}

fn decode<T: TryFromVal<Env, Val>>(env: &Env, value: &ScVal) -> Result<T, ()> {
    let value = Val::try_from_val(env, value).map_err(|_| ())?;
    T::try_from_val(env, &value).map_err(|_| ())
}

fn invoke(
    config_dir: &Path,
    rpc_url: &str,
    contract_id: &str,
    source: &str,
    contract_args: &[&str],
    build_only: bool,
) -> Output {
    let mut args = vec![
        "contract",
        "invoke",
        "--id",
        contract_id,
        "--source-account",
        source,
        "--rpc-url",
        rpc_url,
        "--network-passphrase",
        PASSPHRASE,
    ];
    if build_only {
        args.push("--build-only");
    }
    args.push("--");
    args.extend_from_slice(contract_args);
    run(config_dir, args)
}

fn run_network<const N: usize>(config_dir: &Path, rpc_url: &str, args: [&str; N]) -> Output {
    let mut owned: Vec<String> = args.into_iter().map(str::to_string).collect();
    owned.extend([
        "--rpc-url".into(),
        rpc_url.into(),
        "--network-passphrase".into(),
        PASSPHRASE.into(),
    ]);
    run_network_owned(config_dir, owned)
}

fn run_network_owned(config_dir: &Path, args: Vec<String>) -> Output {
    run(config_dir, args)
}

fn run<I, S>(config_dir: &Path, args: I) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("stellar")
        .arg("--config-dir")
        .arg(config_dir)
        .args(args)
        .output()
        .expect("run Stellar CLI");
    assert!(
        output.status.success(),
        "Stellar CLI failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn output_text(output: Output) -> String {
    String::from_utf8(output.stdout)
        .expect("UTF-8 Stellar CLI output")
        .trim()
        .to_string()
}

fn scalar(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

fn address(config_dir: &Path, identity: &str) -> String {
    output_text(run(config_dir, ["keys", "address", identity]))
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn transport(message: String) -> RpcCallError<u32> {
    RpcCallError::Transport(TransportError::Other(message))
}
