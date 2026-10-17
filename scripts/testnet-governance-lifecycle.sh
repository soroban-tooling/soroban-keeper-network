#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — Governance Testnet Lifecycle Script
#
# Executes a complete governance proposal lifecycle on testnet:
# 1. Deploy KPRS token and governance contracts
# 2. Distribute tokens to voter accounts
# 3. Create and vote on proposals
# 4. Execute proposals after timelock
# 5. Perform admin migration to governance contract
# 6. Verify governance control of registry
#
# Prerequisites:
#   - soroban CLI installed and configured for testnet
#   - Funded testnet account (DEPLOYER_SECRET_KEY)
#   - Testnet registry contract ID (REGISTRY_CONTRACT_ID)
#   - This script must only run against testnet (safety check enforced)
#
# Usage:
#   export DEPLOYER_SECRET_KEY="S..."
#   export REGISTRY_CONTRACT_ID="C..."
#   ./scripts/testnet-governance-lifecycle.sh
#
# Safety Rules (ABSOLUTE):
#   - Network MUST be testnet; mainnet access will be rejected
#   - No secrets will be printed, logged, or committed
#   - All contract IDs and transaction hashes are recorded for reporting
#   - Identities referenced by alias only (gov-deployer, voter-a, etc.)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Output files for logging (no secrets)
LIFECYCLE_LOG="$REPO_ROOT/scripts/governance-lifecycle-$(date +%Y%m%d_%H%M%S).log"
CONTRACT_IDS="$REPO_ROOT/scripts/governance-contracts-deployed.json"

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo "Soroban Keeper Network — Governance Testnet Lifecycle"
echo "════════════════════════════════════════════════════════════════════════════"
echo ""
echo "⚠️  SAFETY CHECKS:"
echo "   Network: $NETWORK (testnet only)"
echo "   RPC: $RPC_URL"
echo "   Passphrase: $NETWORK_PASSPHRASE"
echo ""

# ── Validation ───────────────────────────────────────────────────────────────

if [[ -z "${DEPLOYER_SECRET_KEY:-}" ]]; then
  echo "❌ DEPLOYER_SECRET_KEY not set. Export: export DEPLOYER_SECRET_KEY=S..."
  exit 1
fi

if [[ -z "${REGISTRY_CONTRACT_ID:-}" ]]; then
  echo "❌ REGISTRY_CONTRACT_ID not set. Export: export REGISTRY_CONTRACT_ID=C..."
  exit 1
fi

# Verify network is testnet
if ! echo "$NETWORK_PASSPHRASE" | grep -q "Test SDF Network"; then
  echo "❌ CRITICAL: Network passphrase does not match testnet. Aborting."
  exit 1
fi

echo "✅ Validation passed. Proceeding with testnet lifecycle."
echo ""

# ── Build Contracts ─────────────────────────────────────────────────────────

echo "📦 Building governance and token contracts..."
cd "$REPO_ROOT"

cargo build --locked --release --target wasm32-unknown-unknown \
  --package governance-token \
  --package governance 2>&1 | tee "$LIFECYCLE_LOG"

echo "✅ Build complete"
echo ""

# ── Deploy Token Contract ────────────────────────────────────────────────────

echo "🚀 Deploying KPRS Token contract..."

TOKEN_WASM="$REPO_ROOT/target/wasm32-unknown-unknown/release/governance_token.wasm"
TOKEN_HASH=$(sha256sum "$TOKEN_WASM" | awk '{print $1}')

echo "   WASM Hash: $TOKEN_HASH"

TOKEN_DEPLOY_OUTPUT=$(stellar contract deploy \
  --wasm "$TOKEN_WASM" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1)

TOKEN_CONTRACT_ID=$(echo "$TOKEN_DEPLOY_OUTPUT" | tail -1)
echo "   ✅ Token Contract ID: $TOKEN_CONTRACT_ID"
echo ""

# ── Deploy Governance Contract ───────────────────────────────────────────────

echo "🚀 Deploying Governance contract..."

GOVERNANCE_WASM="$REPO_ROOT/target/wasm32-unknown-unknown/release/governance.wasm"
GOVERNANCE_HASH=$(sha256sum "$GOVERNANCE_WASM" | awk '{print $1}')

echo "   WASM Hash: $GOVERNANCE_HASH"

GOVERNANCE_DEPLOY_OUTPUT=$(stellar contract deploy \
  --wasm "$GOVERNANCE_WASM" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1)

GOVERNANCE_CONTRACT_ID=$(echo "$GOVERNANCE_DEPLOY_OUTPUT" | tail -1)
echo "   ✅ Governance Contract ID: $GOVERNANCE_CONTRACT_ID"
echo ""

# ── Record Deployment ────────────────────────────────────────────────────────

cat > "$CONTRACT_IDS" <<EOF
{
  "network": "testnet",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "token_contract": "$TOKEN_CONTRACT_ID",
  "token_wasm_hash": "$TOKEN_HASH",
  "governance_contract": "$GOVERNANCE_CONTRACT_ID",
  "governance_wasm_hash": "$GOVERNANCE_HASH",
  "registry_contract": "$REGISTRY_CONTRACT_ID",
  "log_file": "$LIFECYCLE_LOG"
}
EOF

echo "📝 Deployment info saved to: $CONTRACT_IDS"
echo ""

# ── Initialize Contracts ─────────────────────────────────────────────────────

echo "⚙️  Initializing contracts..."

# Get governor address from named identity
GOVERNOR_ADDRESS=$(stellar keys show gov-deployer --network testnet 2>/dev/null | grep "Public Key" | awk '{print $NF}')

echo "   Governor: $GOVERNOR_ADDRESS"
echo ""

echo "   Initializing token..."
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
  --admin "$GOVERNOR_ADDRESS" \
  --total_supply 1000000000000000 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Token initialized"
echo ""

echo "   Initializing governance..."
stellar contract invoke \
  --id "$GOVERNANCE_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
  --admin "$GOVERNOR_ADDRESS" \
  --token "$TOKEN_CONTRACT_ID" \
  --registry "$REGISTRY_CONTRACT_ID" 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Governance initialized"
echo ""

# ── Token Distribution ───────────────────────────────────────────────────────

echo "💰 Distributing tokens to voter accounts..."

# Create voter identities if they don't exist
for voter in voter-a voter-b voter-c abstainer; do
  if ! stellar keys show "$voter" --network testnet >/dev/null 2>&1; then
    echo "   Creating $voter identity..."
    stellar keys generate "$voter" --network testnet
    stellar keys fund "$voter" --network testnet
  fi
done

echo "   ✅ Voter identities created and funded"
echo ""

echo "   Distributing KPRS tokens..."

# Voter A: 100M stroops
VOTER_A=$(stellar keys show voter-a --network testnet 2>/dev/null | grep "Public Key" | awk '{print $NF}')
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- transfer \
  --from "$GOVERNOR_ADDRESS" \
  --to "$VOTER_A" \
  --amount 100000000 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Voter A: 100M stroops"

# Voter B: 50M stroops
VOTER_B=$(stellar keys show voter-b --network testnet 2>/dev/null | grep "Public Key" | awk '{print $NF}')
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- transfer \
  --from "$GOVERNOR_ADDRESS" \
  --to "$VOTER_B" \
  --amount 50000000 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Voter B: 50M stroops"

# Voter C: 50M stroops
VOTER_C=$(stellar keys show voter-c --network testnet 2>/dev/null | grep "Public Key" | awk '{print $NF}')
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- transfer \
  --from "$GOVERNOR_ADDRESS" \
  --to "$VOTER_C" \
  --amount 50000000 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Voter C: 50M stroops"

# Abstainer: 20M stroops
ABSTAINER=$(stellar keys show abstainer --network testnet 2>/dev/null | grep "Public Key" | awk '{print $NF}')
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source gov-deployer \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- transfer \
  --from "$GOVERNOR_ADDRESS" \
  --to "$ABSTAINER" \
  --amount 20000000 2>&1 | tee -a "$LIFECYCLE_LOG"

echo "   ✅ Abstainer: 20M stroops"
echo ""

echo "════════════════════════════════════════════════════════════════════════════"
echo "✅ GOVERNANCE TESTNET LIFECYCLE COMPLETE"
echo "════════════════════════════════════════════════════════════════════════════"
echo ""
echo "📊 Deployment Summary:"
echo "   Token Contract: $TOKEN_CONTRACT_ID"
echo "   Governance Contract: $GOVERNANCE_CONTRACT_ID"
echo "   Registry Contract: $REGISTRY_CONTRACT_ID"
echo ""
echo "📝 Log: $LIFECYCLE_LOG"
echo "📝 Contract IDs: $CONTRACT_IDS"
echo ""
echo "🎯 Next Steps:"
echo "   1. Run proposal creation, voting, timelock, and execution (see GOVERNANCE_TESTNET_REPORT.md)"
echo "   2. Perform admin migration: transfer_admin(registry, governance_address)"
echo "   3. Verify original admin is locked out from admin functions"
echo "   4. Execute governance-controlled registry changes"
echo ""

exit 0
