# CLI security review (`skn`)

Review date: 2026-11-20

Reviewed revision: `22fc723` (`main`)

Scope: `packages/cli/src/`, including `keys.ts`, `config.ts`, `settings.ts`,
`confirm.ts`, `failures.ts`, `output.ts` and all command modules under
`src/commands/`. The review covers the four prerequisite issues that are
already closed (#692 signing-key sources, #702 admin commands, #704 deploy,
#700 keeper balance and withdraw) and asks the question in #711: can this be
published without leaking a key or hitting mainnet by accident?

## Verdict

The CLI is **fit for a first publication** with the mitigations recorded below.
No path was found that writes a signing key to disk, prints it, or submits a
mainnet transaction without an explicit opt-in. One disclosure path was found
in operator-facing output: a credentialed RPC URL could be echoed verbatim by
`config show`, `deploy` confirmation and RPC error messages. That path is now
fixed by central redaction.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| CLI-SEC-01 | High | RPC URLs with embedded API keys were printed by `config show`, the deploy confirmation prompt and RPC error messages | **Fixed**: all operator-facing text passes through `src/redact.ts` |
| CLI-SEC-02 | Info | Signing keys come from `--key-file`, `--identity` or `SKN_SECRET_KEY`; errors report the source, not the value | No finding |
| CLI-SEC-03 | Info | No temporary files are created; the only file write is the explicit config file, which holds no secrets | No finding |
| CLI-SEC-04 | Info | Admin and deploy commands require a mainnet opt-in plus an explicit confirmation before submission | No finding, two accepted tradeoffs below |
| CLI-SEC-05 | Low | The config file is created with the OS default permissions and contains no secret, but is world-readable by default | Accepted, see below |

## Key sources and secret leakage

`resolveKey` (`src/keys.ts`) has exactly three sources, in precedence order:

1. `--key-file <path>`: reads the file, rejects it when POSIX permissions give
   group or other users any access (`mode & 0o077`), and validates the seed
   shape. Windows has no POSIX mode bits, so the check is skipped there.
2. `--identity <name>`: reads `~/.config/stellar/identity/<name>.toml`,
   restricts the name to `[A-Za-z0-9_-]+` (so a path cannot be injected), and
   extracts only a `secret_key = "S..."` line. Seed-phrase identities are
   rejected rather than partially supported.
3. `SKN_SECRET_KEY`: trimmed and validated in place.

Every `KeyError` names the variable, file or identity, never the seed or any
part of it. `ResolvedKey` is the only type that holds key material, and its
doc comment requires callers to print only `source` and `origin`.

`config show` builds a view containing only `key: { source, origin }`. It never
includes `ResolvedKey.secret`, and a test asserts the seed is absent from both
text and `--json` output. `toJsonSafe` (`src/output.ts`) converts bigints and
bytes but cannot introduce a secret field; there is no generic object dump of
the environment or config anywhere in the CLI.

**Result: no finding on key sources.**

## Logging, error paths and redaction (CLI-SEC-01)

Before this review, three surfaces could print a URL verbatim:

- `skn config show` prints `rpc url: ...` and includes `rpcUrl` in its JSON
  document.
- `skn deploy` includes the RPC URL in the "show every parameter first" prompt.
- `commandError` prints `KeeperRpcError.message`, which may quote the failing
  RPC response URL.

Provider URLs often embed an API key in user info or a query parameter, and
terminal output frequently ends up in CI logs. The fix is a single helper,
`redactSecrets` in `src/redact.ts`, applied to every one of those surfaces:

- it removes user info and the query string from any URL-like token while
  keeping scheme, host and path, so an operator can still identify the failed
  endpoint;
- it replaces a Stellar secret seed with `[REDACTED]` if one appears in free
  text, as a defence in depth for third-party error messages;
- ordinary text and URLs without credentials are unchanged.

The unit tests in `test/redact.test.ts` cover all three surfaces. The same
tests assert that the redacted output still contains `https://rpc.example.com/api`,
so redaction cannot silently hide which endpoint was used.

**Result: finding fixed.** New output paths must pass through `redactSecrets`
before being printed.

## Temporary files

The only file write in the CLI is `writeConfig` (`src/config.ts`), which writes
the explicit `--config` path (default `~/.config/skn/skn.config.json`). It
refuses to overwrite an existing file unless `--force` is passed. `Profile`
holds a network and contract ids only, never a key. There is no use of
`tmpdir`, `mkdtemp`, shell redirection or a signing library that caches keys
to disk.

**Result: no finding.**

## Admin commands and mainnet confirmation

`requireMainnetConfirmation` (`src/settings.ts`) is called by admin and deploy
**before any network call**. On mainnet without `--confirm-mainnet` the command
fails with a usage error and the RPC server is untouched. A test asserts zero
RPC calls on that path.

`skn admin <subcommand>` additionally:

1. resolves the signing key and derives its public address;
2. reads the contract's current admin and refuses to continue if it differs,
   so the wrong signer cannot submit a privileged call;
3. computes the execution plan and prints current and new values;
4. requires either `--yes` or an interactive confirmation. With a non-TTY
   stdin and no `--yes`, it fails closed with a message that includes the
   proposed change.

`skn deploy <target>` refuses mainnet before any network call, validates every
initialization parameter locally, loads and validates the WASM files, then
prints all parameters (with the RPC URL redacted) before requiring the same
confirmation.

`skn keeper withdraw` calls the mainnet guard only on the path that actually
submits a transaction, so a dry run with nothing to withdraw cannot be blocked
by a guard for a transaction that will never be sent.

**Result: no finding.**

## Accepted tradeoffs

- **`--yes` bypasses the interactive prompt.** It is required for automation,
  where no terminal exists. It does *not* bypass `--confirm-mainnet`, so a
  script still needs an explicit mainnet opt-in. Accepted because the
  alternative (no non-interactive admin commands) would make scheduled
  operations impossible.
- **`SKN_SECRET_KEY` is visible in the process environment.** Environment
  variables are readable by the process owner and by tools that inspect
  `/proc`, so this source is accepted for convenience but not recommended for
  production. Use `--key-file` (mode 0600) or `--identity` instead.
- **Config file permissions (CLI-SEC-05).** `writeConfig` does not set mode
  `0600` because the file contains no secret. Accepted as low severity;
  operators should still restrict it, and the review recommends tightening the
  default in a follow-up if a future profile type ever holds sensitive data.

## Recommendations before publish

1. Keep the `redactSecrets` check in the review checklist for every new output
   field: no URL with credentials, no seed, no raw error object.
2. Preserve the fail-closed behaviour when stdin is not a terminal. A CI job
   must pass both `--yes` and, on mainnet, `--confirm-mainnet`.
3. Document the key-source precedence and the mainnet guard in
   [`docs/CLI.md`](CLI.md) and [`packages/cli/README.md`](../packages/cli/README.md).

## Related documents

- [Indexer security review](INDEXER_SECURITY_REVIEW.md)
- [Keeper bot v2 security review](KEEPER_BOT_V2_SECURITY_REVIEW.md)
- [CLI design](CLI_DESIGN.md)
- [Generated command reference](CLI.md)
- [CLI quickstart](../packages/cli/README.md)

A repo-wide threat model and observability catalogue are being added in
parallel changes. This review does not depend on either of them.
