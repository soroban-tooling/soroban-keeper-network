#!/usr/bin/env bash
# Build source-level coverage from each nightly fuzz corpus.

set -uo pipefail

OUTPUT_DIR="${1:-fuzz/coverage-report}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

host="$(rustc +nightly -vV | sed -n 's/^host: //p')"
sysroot="$(rustc +nightly --print sysroot)"
llvm_cov="$sysroot/lib/rustlib/$host/bin/llvm-cov"
summary="$OUTPUT_DIR/summary.md"

{
  echo "# Nightly fuzz coverage"
  echo
  echo "Generated from the restored and newly grown corpus in this workflow run."
  echo
  echo "| Target | Corpus files | Result |"
  echo "|---|---:|---|"
} >"$summary"

for target_path in fuzz/fuzz_targets/*.rs; do
  target="$(basename "$target_path" .rs)"
  corpus_dir="fuzz/corpus/$target"
  corpus_files=0
  if [ -d "$corpus_dir" ]; then
    corpus_files="$(find "$corpus_dir" -type f | wc -l | tr -d ' ')"
  fi

  target_dir="$OUTPUT_DIR/$target"
  mkdir -p "$target_dir"

  if [ "$corpus_files" -eq 0 ]; then
    echo "| \`$target\` | 0 | no corpus; coverage not generated |" >>"$summary"
    continue
  fi

  coverage_log="$target_dir/coverage.log"
  if ! cargo +nightly fuzz coverage "$target" >"$coverage_log" 2>&1; then
    echo "| \`$target\` | $corpus_files | coverage build failed; see log |" >>"$summary"
    continue
  fi

  profdata="$(find "fuzz/coverage/$target" -type f -name '*.profdata' -print -quit 2>/dev/null)"
  binary="$(find fuzz/target -type f -path '*/coverage/*' -name "$target" -perm -111 -print -quit 2>/dev/null)"
  if [ ! -x "$llvm_cov" ] || [ -z "$profdata" ] || [ -z "$binary" ]; then
    echo "coverage output incomplete: llvm_cov=$llvm_cov profdata=$profdata binary=$binary" >>"$coverage_log"
    echo "| \`$target\` | $corpus_files | coverage output incomplete; see log |" >>"$summary"
    continue
  fi

  ignore_regex='(/\.cargo/registry/|/rustc/)'
  "$llvm_cov" report "$binary" \
    -instr-profile="$profdata" \
    -ignore-filename-regex="$ignore_regex" \
    >"$target_dir/report.txt" 2>>"$coverage_log"
  "$llvm_cov" show "$binary" \
    -instr-profile="$profdata" \
    -ignore-filename-regex="$ignore_regex" \
    -format=html \
    -output-dir="$target_dir/html" \
    >>"$coverage_log" 2>&1

  if [ -s "$target_dir/report.txt" ] && [ -f "$target_dir/html/index.html" ]; then
    echo "| \`$target\` | $corpus_files | text and HTML reports generated |" >>"$summary"
  else
    echo "| \`$target\` | $corpus_files | report generation failed; see log |" >>"$summary"
  fi
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

# The nightly fuzz job is advisory. Failed target builds remain visible in the
# manifest and logs while successful targets still publish usable coverage.
exit 0
