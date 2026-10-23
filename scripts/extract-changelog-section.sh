#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — CHANGELOG section extractor
#
# Prints the CHANGELOG.md section for one released version, without its
# heading. The release workflow uses this as the GitHub Release body.
#
# Usage:
#   scripts/extract-changelog-section.sh <version> [changelog-path]
#
#   version         X.Y.Z, with or without a leading "v" (v0.2.0 or 0.2.0)
#   changelog-path  defaults to CHANGELOG.md
#
# The section starts at a heading "## [X.Y.Z]" (optionally followed by
# " - <date>") and ends at the next level-2 heading. Exits 1 with a message on
# stderr when there is no such heading or the section has no content.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <version> [changelog-path]" >&2
  exit 2
fi

version="${1#v}"
changelog="${2:-CHANGELOG.md}"

if [ ! -f "$changelog" ]; then
  echo "error: $changelog does not exist" >&2
  exit 1
fi

# The heading is compared as a fixed string, so the dots in the version are
# literal. awk exits 3 when no heading matches, which is distinct from a
# section that exists but is empty.
status=0
section=$(awk -v heading="## [${version}]" '
  BEGIN { found = 0; inside = 0 }
  inside && /^## / { exit }
  !inside && !found && index($0, heading) == 1 {
    rest = substr($0, length(heading) + 1)
    if (rest == "" || substr(rest, 1, 1) == " ") { found = 1; inside = 1 }
    next
  }
  inside { print }
  END { if (!found) exit 3 }
' "$changelog") || status=$?

if [ "$status" -eq 3 ]; then
  echo "error: $changelog has no '## [$version]' section for version $version" >&2
  echo "Add a '## [$version] - YYYY-MM-DD' section before tagging (CONTRIBUTING.md, Release Process, step 4)." >&2
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "error: could not read $changelog (awk exit $status)" >&2
  exit 1
fi

# Trim blank lines from the start and the end of the section.
trimmed=$(printf '%s\n' "$section" | sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')
if [ -z "$(printf '%s' "$trimmed" | tr -d '[:space:]')" ]; then
  echo "error: the '## [$version]' section in $changelog has no content" >&2
  exit 1
fi

printf '%s\n' "$trimmed"
