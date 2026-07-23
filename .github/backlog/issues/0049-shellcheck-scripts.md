---
title: "chore(ci): lint the shell scripts and make them fail loudly"
labels: [tooling, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

`scripts/deploy.sh` and `scripts/optimize.sh` are part of the documented deployment path and are never checked by anything. They handle secret keys and produce on-chain state, which makes them the worst place in the repository for a silent failure.

## Current state

CI covers Rust and, advisorily, the keeper bot. Nothing looks at the scripts — not a linter, not a syntax check.

Shell is unusually good at failing quietly. Without `set -euo pipefail`, a script continues past a failed command; an unset variable expands to an empty string; a failure mid-pipeline is invisible because only the last command's status is reported. In a deploy script, that means a failed build step can be followed by a deploy of a stale artifact, and the script still exits 0.

Unquoted variable expansions are the other classic: a path containing a space silently becomes two arguments.

## Expected behaviour

ShellCheck runs on every PR touching a shell script, and the scripts themselves fail fast and loudly.

## Suggested approach

Two halves. Do the audit first — the linter only reports, and the actual value is in what it finds.

**Audit the scripts.** For each, confirm:

- `set -euo pipefail` at the top. `pipefail` matters specifically because these scripts pipe CLI output.
- Every variable expansion is quoted.
- Required environment variables are checked before use, with a message naming the variable. `deploy.sh` reads `DEPLOYER_SECRET_KEY` and `ADMIN_ADDRESS` per the README; unset, those currently expand to nothing and get passed to the CLI as empty arguments.
- Secrets are never echoed. Check for `set -x` and for any log line interpolating the secret key.
- The network argument is validated against a known set rather than passed through.

**Add the linter.** Following the advisory pattern in `ci.yml`:

```yaml
  shellcheck:
    name: ShellCheck (advisory)
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - name: Run ShellCheck
        run: |
          sudo apt-get update && sudo apt-get install -y shellcheck
          # -x follows sourced files; -S style reports everything so the
          # findings are visible before deciding what to act on.
          shellcheck -x -S style scripts/*.sh .github/backlog/push.sh
```

Include `.github/backlog/push.sh` — it is shell too, and it creates issues in bulk.

Advisory, consistent with the rest of the pipeline. ShellCheck's style-level findings include suggestions that are not always right for a given script, and blocking on them would be stricter than the policy applied to Rust.

Where a finding is deliberate, silence it inline with a `# shellcheck disable=SCxxxx` comment **and a reason**. A bare disable is worse than the warning.

## Acceptance criteria

- [ ] Every script sets `-euo pipefail`.
- [ ] Every variable expansion is quoted.
- [ ] Required environment variables are validated before use, with messages naming them.
- [ ] No script can echo a secret key, including under `set -x`.
- [ ] The network argument is validated against an allow-list.
- [ ] An advisory ShellCheck job runs on every PR.
- [ ] Any suppressed finding carries a reason.
- [ ] `docs/CI.md` lists the new job.

## Files

- `scripts/deploy.sh`
- `scripts/optimize.sh`
- `.github/backlog/push.sh`
- `.github/workflows/ci.yml`
- `docs/CI.md`
