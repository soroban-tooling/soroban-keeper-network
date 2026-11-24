#!/usr/bin/env bash
# Build the documentation site: stage the Markdown, then run mdBook.
#
#   ./docs/site/build.sh          # build into docs/site/book/
#   ./docs/site/build.sh serve    # build, serve and watch on localhost:3000
#
# Needs Node.js (>= 18) and mdBook (>= 0.5): `cargo install mdbook --locked`
# or a release binary from https://github.com/rust-lang/mdBook/releases.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "docs: node is required (https://nodejs.org)" >&2; exit 1; }
command -v mdbook >/dev/null 2>&1 || {
  echo "docs: mdbook is required: cargo install mdbook --locked" >&2
  echo "      or download a binary from https://github.com/rust-lang/mdBook/releases" >&2
  exit 1
}

node "$here/stage.mjs"

case "${1:-build}" in
  build) mdbook build "$here" ;;
  serve) mdbook serve "$here" ;;
  *) echo "usage: build.sh [build|serve]" >&2; exit 2 ;;
esac
