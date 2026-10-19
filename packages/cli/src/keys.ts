import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where a signing key came from, in precedence order: `--key-file`, then
 * `--identity`, then `SKN_SECRET_KEY`. See docs/CLI_DESIGN.md (Keys).
 */
export type KeySource = "key-file" | "identity" | "env";

export interface KeyFlags {
  keyFile?: string | undefined;
  identity?: string | undefined;
}

export interface KeyContext {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
}

/**
 * A resolved key. `secret` is the only field that holds key material. Every
 * other field is safe to print, and callers must print only those.
 */
export interface ResolvedKey {
  source: KeySource;
  /** Where the key was read from: a path, an identity name, or an env var name. */
  origin: string;
  secret: string;
}

export class KeyError extends Error {}

/** A Stellar ed25519 secret seed: `S` followed by 55 base32 characters. */
const SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const IDENTITY_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const IDENTITY_SECRET_PATTERN = /^\s*secret_key\s*=\s*"(S[A-Z2-7]{55})"/m;

export const ENV_SECRET_KEY = "SKN_SECRET_KEY";

/**
 * Returns the signing key for this invocation, or `undefined` when no source is
 * set. Errors never include the key or any part of it.
 */
export async function resolveKey(
  flags: KeyFlags,
  context: KeyContext,
): Promise<ResolvedKey | undefined> {
  if (flags.keyFile !== undefined) {
    return readKeyFile(flags.keyFile, context.platform);
  }
  if (flags.identity !== undefined) {
    return readIdentity(flags.identity, context.homeDir);
  }
  const fromEnv = context.env[ENV_SECRET_KEY];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const secret = fromEnv.trim();
    if (!SECRET_PATTERN.test(secret)) {
      throw new KeyError(`${ENV_SECRET_KEY} is not a valid secret key`);
    }
    return { source: "env", origin: ENV_SECRET_KEY, secret };
  }
  return undefined;
}

async function readKeyFile(path: string, platform: NodeJS.Platform): Promise<ResolvedKey> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new KeyError(`key file ${path} does not exist or cannot be read`);
  }
  // Windows does not carry POSIX permission bits, so the check applies only
  // on platforms where `mode` means something. On Windows, keep the file in a
  // directory only your user account can read.
  if (platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new KeyError(
      `key file ${path} is readable by other users; restrict it with chmod 600`,
    );
  }

  const secret = (await readFile(path, "utf8")).trim();
  if (!SECRET_PATTERN.test(secret)) {
    throw new KeyError(`key file ${path} does not contain a valid secret key`);
  }
  return { source: "key-file", origin: path, secret };
}

async function readIdentity(name: string, homeDir: string): Promise<ResolvedKey> {
  if (!IDENTITY_NAME_PATTERN.test(name)) {
    throw new KeyError(`identity name '${name}' may only contain letters, digits, '-' and '_'`);
  }
  const path = join(homeDir, ".config", "stellar", "identity", `${name}.toml`);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new KeyError(`no Stellar CLI identity named '${name}' at ${path}`);
  }
  const match = IDENTITY_SECRET_PATTERN.exec(text);
  if (!match || match[1] === undefined) {
    throw new KeyError(
      `identity '${name}' has no secret_key; seed-phrase identities are not supported yet`,
    );
  }
  return { source: "identity", origin: name, secret: match[1] };
}
