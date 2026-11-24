#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Soroban Keeper Network — Contract error documentation check
#
# Verifies that every variant in every `contracts/*/src/errors.rs` is
# documented in `docs/ERRORS.md` with its exact numeric discriminant.
#
# Usage:
#   scripts/check-error-docs.sh [docs-path] [contracts-dir]
#
#   docs-path      defaults to docs/ERRORS.md
#   contracts-dir  defaults to contracts
#
# Exits 0 when every error variant is documented with its matching code.
# Exits 1 when any variant is missing or has a mismatched discriminant.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

docs_file="${1:-docs/ERRORS.md}"
contracts_dir="${2:-contracts}"

if [ ! -f "$docs_file" ]; then
  echo "error: documentation file '$docs_file' does not exist" >&2
  exit 1
fi

if [ ! -d "$contracts_dir" ]; then
  echo "error: contracts directory '$contracts_dir' does not exist" >&2
  exit 1
fi

# Collect all contracts/*/src/errors.rs files.
error_files=()
for f in "$contracts_dir"/*/src/errors.rs; do
  if [ -f "$f" ]; then
    error_files+=("$f")
  fi
done

if [ ${#error_files[@]} -eq 0 ]; then
  echo "error: no error files found matching '$contracts_dir/*/src/errors.rs'" >&2
  exit 1
fi

missing=0
checked=0

for err_file in "${error_files[@]}"; do
  # Extract `enum_name variant_name code` lines from `pub enum ... { ... }`.
  while IFS=$'\t' read -r enum_name variant code; do
    [ -z "$variant" ] && continue
    checked=$((checked + 1))

    # Verify the enum heading exists and the exact `| \`<code>\` | \`<variant>\` |`
    # row appears inside that enum's section in docs/ERRORS.md.
    if ! awk -v enum_name="$enum_name" -v variant="$variant" -v code="$code" '
      BEGIN { in_section = 0; found = 0 }
      { sub(/\r$/, "") }
      /^## / {
        in_section = (index($0, "(" enum_name ")") > 0 || index($0, "(`" enum_name "`)") > 0)
        next
      }
      in_section {
        pattern = "| `" code "` | `" variant "` |"
        if (index($0, pattern) > 0) {
          found = 1
          exit 0
        }
      }
      END { exit (found ? 0 : 1) }
    ' "$docs_file"; then
      echo "error: undocumented or mismatched error variant: ${enum_name}::${variant} = ${code} (from ${err_file})" >&2
      missing=$((missing + 1))
    fi
  done < <(awk '
    BEGIN { in_enum = 0; enum_name = "" }
    { sub(/\r$/, "") }
    /^[[:space:]]*pub[[:space:]]+enum[[:space:]]+[A-Za-z_][A-Za-z0-9_]*/ {
      line = $0
      sub(/^[[:space:]]*pub[[:space:]]+enum[[:space:]]+/, "", line)
      sub(/[^A-Za-z0-9_].*$/, "", line)
      enum_name = line
      in_enum = 1
      next
    }
    in_enum && /^[[:space:]]*}/ {
      in_enum = 0
      enum_name = ""
      next
    }
    in_enum {
      # Strip line comments.
      line = $0
      sub(/\/\/.*$/, "", line)
      if (match(line, /^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*,?[[:space:]]*$/)) {
        v = line
        sub(/^[[:space:]]*/, "", v)
        sub(/[[:space:]]*=.*$/, "", v)
        c = line
        sub(/^.*=[[:space:]]*/, "", c)
        sub(/[^0-9].*$/, "", c)
        printf "%s\t%s\t%s\n", enum_name, v, c
      }
    }
  ' "$err_file")
done

if [ "$checked" -eq 0 ]; then
  echo "error: no error variants parsed from ${error_files[*]}" >&2
  exit 1
fi

if [ "$missing" -gt 0 ]; then
  echo "error: $missing undocumented or mismatched error variant(s) found. Update $docs_file." >&2
  exit 1
fi

echo "ok: all $checked error variants across ${#error_files[@]} contract(s) are documented in $docs_file"
