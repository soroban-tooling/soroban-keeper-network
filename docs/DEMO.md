# Live Demo — Stellar Testnet

The `KeeperRegistry` contract is **deployed and running on Stellar testnet**.
This page records a full, real end-to-end run — every step below is an actual
on-chain transaction you can open on the block explorer.

## Deployment

| | |
|---|---|
| **Network** | Testnet (`Test SDF Network ; September 2015`) |
| **Contract ID** | [`CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`](https://stellar.expert/explorer/testnet/contract/CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4) |
| **WASM hash** | `e9defafc84fd207e3bcc3cf18768b30207d20962df664c0167c2cf06515a9796` |
| **Reward token** | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| **Protocol fee** | 300 bps (3%) |

Accounts used in the run:

- **Owner / admin (dApp):** `GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM`
- **Keeper:** `GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K`

## End-to-end transaction trace

A single task registered, claimed, executed, and settled — the complete keeper
loop, on-chain:

| Step | What happened | Transaction |
|------|---------------|-------------|
| Upload WASM | Contract code installed | [`97e6c1e4…`](https://stellar.expert/explorer/testnet/tx/97e6c1e42cc85c88ff83b28436bfe2d49d0d705dcd395b2c28d485ef96855a4f) |
| Deploy | Contract instance created | [`29250323…`](https://stellar.expert/explorer/testnet/tx/2925032370a56729bcb40069c3017d44da2a4f269970b0e4e1e26b0eaf21572f) |
| `initialize` | Admin, reward token, 3% fee set | [`435e01dc…`](https://stellar.expert/explorer/testnet/tx/435e01dc75df8f5822fcf67ea3828360078aedb6eda7355bd13e7704b229e96a) |
| `register_task` | Owner posts a Liquidation task, escrows **1.0 XLM** | [`e308f155…`](https://stellar.expert/explorer/testnet/tx/e308f155b39c58fbae8eb60891db2d56ec46a627b277aa1540f256b3ffd65339) |
| `claim_task` | Keeper locks task #1 | [`6b91bfdb…`](https://stellar.expert/explorer/testnet/tx/6b91bfdb136afc15c0590e78db4a77ff1ee58637931f3d9340fff3c463412d7f) |
| `execute_task` | Keeper submits proof, credited **0.97 XLM** | [`538aff0a…`](https://stellar.expert/explorer/testnet/tx/538aff0a729a5f00d9749611dd8d669b038c30fea8aa2263db59a24d0f07eeb6) |
| `withdraw_rewards` | Keeper withdraws **0.97 XLM** to its account | [`d42c1c90…`](https://stellar.expert/explorer/testnet/tx/d42c1c90513510ac4455a37485fd98a9ac231273d967d4426c11309a8a568cac) |

### Result

- Owner escrowed **1.0 XLM**; keeper received **0.97 XLM**; **0.03 XLM** (3%)
  retained as protocol fee. Verified on-chain: `fees_accrued` returns `300000`
  stroops and `task_count` returns `1`.
- Every state transition emitted its event (`reg`, `claim`, `exec`, `wdraw`),
  visible in each transaction's event log on the explorer.

## Reproduce it yourself

See [DEPLOYING.md](DEPLOYING.md) for the full command sequence. In short:

```bash
make wasm
stellar keys generate me --network testnet --fund
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/keeper_registry.optimized.wasm \
  --source me --network testnet
# initialize → register_task → claim_task → execute_task → withdraw_rewards
```

> Testnet state is periodically reset by the network; the transaction links
> above are permanent records, while the live contract entry may expire.
