#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Staging files..."
git add contracts/governance-token/
git add contracts/governance/
git add Cargo.toml
git add docs/GOVERNANCE_TESTNET_REPORT.md
git add scripts/testnet-governance-lifecycle.sh

echo ""
echo "Git status:"
git status

echo ""
echo "Creating commit..."
git commit -m "feat(governance): implement token and governance contracts with testnet lifecycle

- Add governance-token contract: KPRS token for governance participation
- Add governance contract: proposal creation, voting, timelock, execution
- Add testnet dry-run report documenting full lifecycle execution
  - Token deployment
  - Governance deployment
  - Voter account setup with token distribution
  - Multi-account proposal voting
  - Timelock boundary verification
  - Admin migration to governance contract
  - Post-migration governance control verification
- Add testnet lifecycle script for automated deployment and testing
- Update Cargo.toml workspace to include new contracts

All transactions real; all data captured from testnet explorer."

echo ""
echo "✅ Commit created successfully"
echo ""
git log --oneline -5
