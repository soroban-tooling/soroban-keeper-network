#!/usr/bin/env bash
set -euo pipefail

# One-command quickstart script for the Soroban Keeper Network
# Usage: ./quickstart.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Launching Soroban Keeper Network Quickstart ==="

# Check if node is installed
if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js (v18+) is required to run the quickstart script."
    exit 1
fi

node quickstart.ts
