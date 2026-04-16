#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — Deployment Script
#
# Deploys the KeeperRegistry contract to Testnet, Futurenet, or Mainnet.
#
# Prerequisites:
#   - soroban CLI installed (https://soroban.stellar.org/docs/getting-started/setup)
#   - Funded Stellar account (secret key exported as DEPLOYER_SECRET_KEY)
#   - Rust + wasm32-unknown-unknown target installed
#
# Usage:
#   export DEPLOYER_SECRET_KEY="S..."
#   ./scripts/deploy.sh testnet
#   ./scripts/deploy.sh mainnet
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

NETWORK="${1:-testnet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_PATH="$REPO_ROOT/target/wasm32-unknown-unknown/release/keeper_registry.wasm"
OPTIMIZED_WASM="${WASM_PATH%.wasm}.optimized.wasm"
DEPLOY_LOG="$REPO_ROOT/scripts/deploy_${NETWORK}_$(date +%Y%m%d_%H%M%S).log"

# ── Network config ───────────────────────────────────────────────────────────

case "$NETWORK" in
  testnet)
    RPC_URL="https://soroban-testnet.stellar.org"
    NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  futurenet)
    RPC_URL="https://rpc-futurenet.stellar.org"
    NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"
    ;;
  mainnet)
    RPC_URL="https://mainnet.sorobanrpc.com"
    NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
    ;;
  *)
    echo "❌  Unknown network: $NETWORK. Use: testnet | futurenet | mainnet"
    exit 1
    ;;
esac

# ── Validate environment ─────────────────────────────────────────────────────

if [[ -z "${DEPLOYER_SECRET_KEY:-}" ]]; then
  echo "❌  DEPLOYER_SECRET_KEY not set."
  echo "    Export your Stellar secret key: export DEPLOYER_SECRET_KEY=S..."
  exit 1
fi

# ── Admin + reward token addresses ──────────────────────────────────────────
ADMIN_ADDRESS="${ADMIN_ADDRESS:-$(stellar keys show --hd-path 0 2>/dev/null || echo '')}"
if [[ -z "$ADMIN_ADDRESS" ]]; then
  echo "❌  ADMIN_ADDRESS not set."
  echo "    Export admin address: export ADMIN_ADDRESS=G..."
  exit 1
fi

# Reward token: default to native XLM SAC on each network
case "$NETWORK" in
  testnet)   REWARD_TOKEN="${REWARD_TOKEN:-CDLZFC3SYJYDZT7K67VZ75HPJVOK46N77GLRNT6BKTEBIPJMHWCBHKV}" ;;
  futurenet) REWARD_TOKEN="${REWARD_TOKEN:-CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYK6AH6KEOT6BTRGSUTLNJ}" ;;
  mainnet)   REWARD_TOKEN="${REWARD_TOKEN:-CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA}" ;;
esac

FEE_BPS="${FEE_BPS:-300}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║      Soroban Keeper Network — Deployment Script             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "  Network   : $NETWORK"
echo "  RPC URL   : $RPC_URL"
echo "  Admin     : $ADMIN_ADDRESS"
echo "  Token     : $REWARD_TOKEN"
echo "  Fee (bps) : $FEE_BPS"
echo ""

# ── Build ────────────────────────────────────────────────────────────────────

echo "🔨  Building WASM (release)..."
cd "$REPO_ROOT"
cargo build --release --target wasm32-unknown-unknown --package keeper-registry 2>&1 | tee "$DEPLOY_LOG"

# Optimize if wasm-opt is available
if command -v wasm-opt &>/dev/null; then
  echo "⚡  Optimizing WASM with wasm-opt..."
  wasm-opt -Oz --strip-debug "$WASM_PATH" -o "$OPTIMIZED_WASM"
  DEPLOY_WASM="$OPTIMIZED_WASM"
  echo "   Optimized: $(du -sh "$OPTIMIZED_WASM" | cut -f1)"
else
  DEPLOY_WASM="$WASM_PATH"
  echo "ℹ️   wasm-opt not found; deploying unoptimized WASM (install with: cargo install wasm-opt)"
fi

echo "✅  WASM ready: $(du -sh "$DEPLOY_WASM" | cut -f1)"

# ── Upload WASM ──────────────────────────────────────────────────────────────

echo ""
echo "📤  Uploading WASM to Stellar network..."
WASM_HASH=$(stellar contract upload \
  --wasm "$DEPLOY_WASM" \
  --source "$DEPLOYER_SECRET_KEY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1 | tee -a "$DEPLOY_LOG" | tail -1)

echo "✅  WASM hash: $WASM_HASH"

# ── Deploy contract ──────────────────────────────────────────────────────────

echo ""
echo "🚀  Deploying contract..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash "$WASM_HASH" \
  --source "$DEPLOYER_SECRET_KEY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1 | tee -a "$DEPLOY_LOG" | tail -1)

echo "✅  Contract ID: $CONTRACT_ID"

# ── Initialize contract ──────────────────────────────────────────────────────

echo ""
echo "🔧  Initializing KeeperRegistry..."
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$DEPLOYER_SECRET_KEY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --reward_token "$REWARD_TOKEN" \
  --fee_bps "$FEE_BPS" \
  2>&1 | tee -a "$DEPLOY_LOG"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                   Deployment Complete! 🎉                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Contract ID : $CONTRACT_ID"
echo "  WASM Hash   : $WASM_HASH"
echo "  Network     : $NETWORK"
echo "  Log         : $DEPLOY_LOG"
echo ""
echo "  Next steps:"
echo "    1. Copy CONTRACT_ID to your keeper bot .env:"
echo "       REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo "    2. Register your first task:"
echo "       stellar contract invoke --id $CONTRACT_ID \\"
echo "         -- register_task --owner $ADMIN_ADDRESS \\"
echo "         --task_type Liquidation --calldata ... \\"
echo "         --reward 1000000 --deadline ... \\"
echo "         --ttl_ledgers 17280 --lock_ledgers 120"
echo ""

# Save deployment info
DEPLOY_INFO="$REPO_ROOT/scripts/deployment_${NETWORK}.json"
cat > "$DEPLOY_INFO" <<EOF
{
  "network": "$NETWORK",
  "contract_id": "$CONTRACT_ID",
  "wasm_hash": "$WASM_HASH",
  "admin": "$ADMIN_ADDRESS",
  "reward_token": "$REWARD_TOKEN",
  "fee_bps": $FEE_BPS,
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "  Info saved : $DEPLOY_INFO"
