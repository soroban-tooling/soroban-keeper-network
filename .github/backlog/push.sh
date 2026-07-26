#!/usr/bin/env bash
#
# Publish backlog issues from .github/backlog/issues/ to GitHub Issues.
#
# Each issue file carries YAML front matter (title, labels, epic, wave) followed
# by the Markdown body. This script splits the two, creates the issue with `gh`,
# and skips any issue whose title is already open on the repository so it can be
# re-run safely.
#
#   ./.github/backlog/push.sh --from 1 --to 50 --dry-run
#   ./.github/backlog/push.sh --from 1 --to 50
#
# Requires: gh (authenticated), awk, sed.

set -euo pipefail

FROM=1
TO=600
DRY_RUN=0
REPO="${BACKLOG_REPO:-soroban-tooling/soroban-keeper-network}"

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from)    FROM="$2"; shift 2 ;;
    --to)      TO="$2";   shift 2 ;;
    --repo)    REPO="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUE_DIR="$SCRIPT_DIR/issues"

if [ ! -d "$ISSUE_DIR" ]; then
  echo "No issues directory at $ISSUE_DIR" >&2
  exit 1
fi

# Pull existing titles once rather than querying per issue — 600 API round trips
# would rate-limit long before the run finished.
echo "Fetching existing issue titles from $REPO ..."
EXISTING="$(mktemp)"
trap 'rm -f "$EXISTING"' EXIT
if [ "$DRY_RUN" -eq 0 ]; then
  gh issue list --repo "$REPO" --state all --limit 1000 --json title \
    --jq '.[].title' > "$EXISTING"
else
  : > "$EXISTING"
fi

# Reads the value of a single-line front-matter key.
front_matter_value() {
  awk -v key="$2" '
    NR == 1 && $0 == "---" { inside = 1; next }
    inside && $0 == "---"  { exit }
    inside && index($0, key ":") == 1 {
      v = substr($0, length(key) + 2)
      sub(/^[ \t]+/, "", v)
      # strip surrounding quotes and YAML flow-sequence brackets
      gsub(/^"|"$/, "", v)
      gsub(/^\[|\]$/, "", v)
      print v
      exit
    }
  ' "$1"
}

# Everything after the closing --- of the front matter is the issue body.
issue_body() {
  awk '
    NR == 1 && $0 == "---" { inside = 1; next }
    inside && $0 == "---"  { inside = 0; started = 1; next }
    started { print }
  ' "$1"
}

created=0
skipped=0
failed=0

for file in "$ISSUE_DIR"/*.md; do
  [ -e "$file" ] || continue
  base="$(basename "$file")"
  num="${base%%-*}"
  # Strip leading zeros so 0007 compares as 7, not as an invalid octal literal.
  num_int="$((10#$num))"

  if [ "$num_int" -lt "$FROM" ] || [ "$num_int" -gt "$TO" ]; then
    continue
  fi

  title="$(front_matter_value "$file" title)"
  labels="$(front_matter_value "$file" labels)"

  if [ -z "$title" ]; then
    echo "  !  $base — no title in front matter, skipping" >&2
    failed=$((failed + 1))
    continue
  fi

  if grep -Fxq "$title" "$EXISTING" 2>/dev/null; then
    echo "  =  $base — already on GitHub, skipping"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  +  [dry-run] $base"
    echo "       title : $title"
    echo "       labels: ${labels:-none}"
    created=$((created + 1))
    continue
  fi

  body_file="$(mktemp)"
  issue_body "$file" > "$body_file"

  # Build the --label arguments. Labels are comma-separated in front matter.
  label_args=()
  if [ -n "$labels" ]; then
    IFS=',' read -ra parts <<< "$labels"
    for l in "${parts[@]}"; do
      l="$(echo "$l" | sed 's/^[ \t"]*//; s/[ \t"]*$//')"
      [ -n "$l" ] && label_args+=(--label "$l")
    done
  fi

  if url="$(gh issue create --repo "$REPO" \
              --title "$title" \
              --body-file "$body_file" \
              "${label_args[@]}" 2>&1)"; then
    echo "  +  $base — $url"
    created=$((created + 1))
    echo "$title" >> "$EXISTING"
  else
    echo "  x  $base — failed: $url" >&2
    failed=$((failed + 1))
  fi
  rm -f "$body_file"

  # GitHub secondary rate limits trigger on rapid content creation. A short
  # pause keeps a 50-issue run comfortably under the threshold.
  sleep 2
done

echo
echo "created: $created   skipped: $skipped   failed: $failed"
[ "$failed" -eq 0 ]
