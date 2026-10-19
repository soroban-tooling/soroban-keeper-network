/**
 * Process exit codes for `skn`. The table is the contract documented in
 * `docs/CLI_DESIGN.md`: scripts branch on these values, so renumbering one is
 * a breaking change.
 */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  rpc: 3,
  contract: 4,
  notFound: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
