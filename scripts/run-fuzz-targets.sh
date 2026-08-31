#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — Fuzz target runner (CI)
#
# Runs every registered cargo-fuzz target (one binary per file under
# fuzz/fuzz_targets/) for a fixed wall-clock budget and appends a Markdown
# summary to $GITHUB_STEP_SUMMARY. Shared by the fuzz-pr (short budget) and
# fuzz-nightly (long budget, cached corpus) CI jobs so the two never drift in
# how they report results — see docs/CI.md.
#
# A crash is reported both in the summary (with the decoded input, since
# targets use #[derive(Arbitrary, Debug)] inputs) and as a `::error::`
# workflow annotation so it is hard to miss even though this script always
# exits 0 (the caller decides advisory-ness via `continue-on-error`, not this
# script's exit code).
#
# A target that fails to build (register_task, smoke — see docs/FUZZING.md)
# is reported distinctly from a crash, so a known pre-existing gap doesn't
# read as a new bug on every PR.
#
# Usage:
#   ./scripts/run-fuzz-targets.sh <seconds-per-target> <summary-heading>
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail # not -e: one target failing must not stop the loop

SECONDS_PER_TARGET="${1:?usage: run-fuzz-targets.sh <seconds-per-target> <summary-heading>}"
HEADING="${2:?usage: run-fuzz-targets.sh <seconds-per-target> <summary-heading>}"
SUMMARY="${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is not set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

{
  echo "### $HEADING"
  echo
  echo "| Target | Status | Runs (approx.) | Corpus (files, before → after) | Corpus (KiB, before → after) | Crash artifact |"
  echo "|---|---|---|---|---|---|"
} >>"$SUMMARY"

for target_path in fuzz/fuzz_targets/*.rs; do
  target="$(basename "$target_path" .rs)"
  corpus_dir="fuzz/corpus/$target"
  before=0
  before_kib=0
  if [ -d "$corpus_dir" ]; then
    before=$(find "$corpus_dir" -type f | wc -l | tr -d ' ')
    before_kib=$(du -sk "$corpus_dir" 2>/dev/null | cut -f1)
  fi

  echo "Running $target for ${SECONDS_PER_TARGET}s "
  log_file="$(mktemp)"
  cargo +nightly fuzz run "$target" -- -max_total_time="$SECONDS_PER_TARGET" >"$log_file" 2>&1
  exit_code=$?
  cat "$log_file"

  after=0
  after_kib=0
  if [ -d "$corpus_dir" ]; then
    after=$(find "$corpus_dir" -type f | wc -l | tr -d ' ')
    after_kib=$(du -sk "$corpus_dir" 2>/dev/null | cut -f1)
  fi
  corpus_files_cell="$before → $after"
  corpus_kib_cell="$before_kib → $after_kib"

  runs="$(grep -oE '^#[0-9]+' "$log_file" | tail -1 | tr -d '#')"
  runs="${runs:-n/a}"

  crash_file="$(grep -oE 'Test unit written to \S+' "$log_file" | tail -1 | awk '{print $NF}')"

  if [ -n "$crash_file" ] && [ -f "$crash_file" ]; then
    echo "::error title=Fuzz crash in ${target}::cargo fuzz run ${target} found a crash — see the job summary for the decoded input."

    minimized="$crash_file"
    if cargo +nightly fuzz tmin "$target" "$crash_file" -- -max_total_time=60 >"${log_file}.tmin" 2>&1; then
      tmin_path="$(grep -oE 'Minimized artifact written to \S+' "${log_file}.tmin" | tail -1 | awk '{print $NF}')"
      [ -n "$tmin_path" ] && [ -f "$tmin_path" ] && minimized="$tmin_path"
    fi
    decoded="$(cargo +nightly fuzz fmt "$target" "$minimized" 2>&1)"

    {
      echo "| \`$target\` | crash found | $runs | $corpus_files_cell | $corpus_kib_cell | \`$minimized\` |"
    } >>"$SUMMARY"
    {
      echo
      echo "<details><summary>Decoded crashing input for <code>$target</code></summary>"
      echo
      echo '```'
      echo "$decoded"
      echo '```'
      echo "</details>"
      echo
    } >>"$SUMMARY"
    rm -f "${log_file}.tmin"
  elif [ "$exit_code" -ne 0 ]; then
    echo "| \`$target\` | build/run failed (pre-existing — see docs/FUZZING.md) | - | $corpus_files_cell | $corpus_kib_cell | - |" >>"$SUMMARY"
  else
    echo "| \`$target\` | ran clean | $runs | $corpus_files_cell | $corpus_kib_cell | none |" >>"$SUMMARY"
  fi

  rm -f "$log_file"
done
