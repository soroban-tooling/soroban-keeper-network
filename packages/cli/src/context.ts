import type { RpcServerLike } from "@soroban-keeper-network/sdk";

/**
 * Everything the CLI reads from or writes to its environment, injected so
 * tests can run commands in-process: no real stdout, no real `process.env`,
 * no network.
 */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homedir: string;
  platform: NodeJS.Platform;
  /**
   * RPC server to use instead of connecting to the configured URL. The seam
   * the test suite uses to run commands against the SDK's fake RPC.
   */
  server?: RpcServerLike | undefined;
}

const REDACTED = "[REDACTED]";

/**
 * Last line of defence for "a key never appears in output": every byte the
 * CLI writes passes through here, and every secret it loads is registered
 * before it is used. The primary guarantee is that no message is ever built
 * from a secret; this catches the case where a dependency does it anyway.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();

  add(secret: string): void {
    // Very short strings are not plausible secrets, and redacting them would
    // garble unrelated output (an `SKN_SECRET_KEY=x` typo must not blank
    // every "x" the CLI prints).
    if (secret.length >= 8) this.secrets.add(secret);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) result = result.split(secret).join(REDACTED);
    return result;
  }
}

/** What every command handler receives. */
export interface CommandContext {
  io: CliIo;
  redactor: SecretRedactor;
  /** Writes one line to stdout. */
  out(line: string): void;
  /** Writes one line to stderr. */
  err(line: string): void;
}

export function createContext(io: CliIo, redactor: SecretRedactor): CommandContext {
  return {
    io,
    redactor,
    out: (line) => io.stdout(redactor.redact(`${line}\n`)),
    err: (line) => io.stderr(redactor.redact(`${line}\n`)),
  };
}
