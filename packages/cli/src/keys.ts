/**
 * Signing-key sources. Precedence, highest first:
 *
 * 1. `--key-file <path>` -- a file holding one `S...` secret seed. Refused
 *    if group or other users have any access to it (POSIX only; see below).
 * 2. `--identity <name>` -- a Stellar CLI identity (`stellar keys generate`).
 * 3. `SKN_SECRET_KEY` -- an environment variable holding the secret seed.
 *
 * `--key-file` and `--identity` together is a usage error rather than one
 * silently winning. A secret is never accepted as a command-line argument,
 * because arguments end up in shell history and process listings.
 *
 * No message built here contains key material: errors name the *source*
 * ("key file /path", "SKN_SECRET_KEY") and never the value. Every value read
 * is also registered with the output redactor before it is validated, so an
 * invalid one cannot leak through a dependency's error message either.
 *
 * On Windows, POSIX mode bits do not describe who can read a file (NTFS uses
 * ACLs, and `fs.stat` reports 0o666 for any writable file), so the
 * permission check is skipped there. Restrict the file's ACL yourself.
 */

import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { TransactionSigner } from "@soroban-keeper-network/sdk";
import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

import { CliError } from "./cliError.js";
import type { CliIo, SecretRedactor } from "./context.js";

export const SECRET_KEY_ENV = "SKN_SECRET_KEY";

export interface KeyFlags {
  keyFile?: string | undefined;
  identity?: string | undefined;
}

/** A loaded key. Deliberately exposes no way to read the secret back. */
export interface SigningKey {
  publicKey: string;
  signer: TransactionSigner;
  /** Human-readable description of where the key came from, safe to print. */
  source: string;
}

/** Identity names as the Stellar CLI accepts them; also rules out path traversal. */
const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** True for a string that is a valid `S...` secret seed. */
export function isSecretSeed(value: string): boolean {
  return StrKey.isValidEd25519SecretSeed(value);
}

/**
 * Refuses a key file that group or other users can access in any way. Write
 * access counts too: someone who can replace the key can make you sign for
 * their account.
 */
export function assertPrivateKeyFileMode(mode: number, platform: NodeJS.Platform, path: string): void {
  if (platform === "win32") return;
  if ((mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, "0");
    throw new CliError(
      `Refusing to use key file ${path}: its permissions (${octal}) let other users access it. ` +
        `Restrict it to your user with: chmod 600 ${path}`,
    );
  }
}

/** Loads the signing key per the precedence at the top of this file. */
export async function loadSigningKey(
  flags: KeyFlags,
  io: CliIo,
  redactor: SecretRedactor,
): Promise<SigningKey> {
  if (flags.keyFile && flags.identity) {
    throw new CliError("--key-file and --identity are mutually exclusive; pass only one.");
  }
  if (flags.keyFile) return fromKeyFile(flags.keyFile, io, redactor);
  if (flags.identity) return fromIdentity(flags.identity, io, redactor);

  const fromEnv = io.env[SECRET_KEY_ENV];
  if (fromEnv) return toSigningKey(fromEnv, SECRET_KEY_ENV, redactor);

  throw new CliError(
    `No signing key. Set ${SECRET_KEY_ENV}, pass --key-file <path>, or pass --identity <name> ` +
      `to use a Stellar CLI identity.`,
  );
}

async function fromKeyFile(path: string, io: CliIo, redactor: SecretRedactor): Promise<SigningKey> {
  const source = `key file ${path}`;
  let contents: string;
  let handle: FileHandle | undefined;
  try {
    // Check and read through one handle, so the file that passed the
    // permission check is the file that is read.
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) throw new CliError(`Key file ${path} is not a regular file.`);
    assertPrivateKeyFileMode(info.mode, io.platform, path);
    contents = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read key file ${path}: ${describeFsError(error)}`);
  } finally {
    await handle?.close();
  }
  return toSigningKey(contents, source, redactor);
}

/**
 * Where the Stellar CLI keeps identities, in the order it searches them:
 * a project-local directory first, then the user-wide one, then the legacy
 * `soroban` locations from before the CLI was renamed.
 */
export function identityPaths(name: string, io: CliIo): string[] {
  const userConfig = io.env.XDG_CONFIG_HOME || join(io.homedir, ".config");
  const roots = [
    join(io.cwd, ".stellar"),
    io.env.STELLAR_CONFIG_HOME,
    join(userConfig, "stellar"),
    join(io.cwd, ".soroban"),
    join(userConfig, "soroban"),
  ];
  return roots
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, "identity", `${name}.toml`));
}

async function fromIdentity(name: string, io: CliIo, redactor: SecretRedactor): Promise<SigningKey> {
  if (!IDENTITY_NAME.test(name)) {
    throw new CliError(
      `Invalid identity name "${name}": use letters, digits, "-" and "_" only.`,
    );
  }

  const searched = identityPaths(name, io);
  for (const path of searched) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CliError(`Cannot read Stellar CLI identity file ${path}: ${describeFsError(error)}`);
    }

    // Register anything secret-shaped before deciding what to do with it.
    const seedPhrase = /^\s*seed_phrase\s*=\s*"([^"\r\n]*)"\s*$/m.exec(text)?.[1];
    if (seedPhrase) redactor.add(seedPhrase);
    const secret = /^\s*secret_key\s*=\s*"([^"\r\n]*)"\s*$/m.exec(text)?.[1];
    if (secret !== undefined) {
      return toSigningKey(secret, `Stellar CLI identity "${name}" (${path})`, redactor);
    }
    if (seedPhrase !== undefined) {
      throw new CliError(
        `Stellar CLI identity "${name}" (${path}) stores a seed phrase, which skn cannot derive ` +
          `a key from. Use --key-file or ${SECRET_KEY_ENV} instead.`,
      );
    }
    throw new CliError(
      `Stellar CLI identity "${name}" (${path}) has no secret_key entry; it may be ` +
        `public-key-only or kept in the OS keychain. Use --key-file or ${SECRET_KEY_ENV} instead.`,
    );
  }

  throw new CliError(
    `No Stellar CLI identity named "${name}". Looked in:\n  ${searched.join("\n  ")}`,
  );
}

function toSigningKey(raw: string, source: string, redactor: SecretRedactor): SigningKey {
  const secret = raw.trim();
  redactor.add(raw);
  redactor.add(secret);

  if (!isSecretSeed(secret)) {
    throw new CliError(
      `The signing key from ${source} is not a valid Stellar secret seed ` +
        `(expected 56 characters starting with "S"). The value has not been printed.`,
    );
  }

  const keypair = Keypair.fromSecret(secret);
  return { publicKey: keypair.publicKey(), signer: keypairTransactionSigner(keypair), source };
}

/**
 * The SDK's `keypairSigner`, but signing with this package's own copy of
 * `@stellar/stellar-sdk`. The signer contract is base64 XDR in, base64 XDR
 * out, so no `Keypair` or XDR object ever crosses between the two copies a
 * `file:` dependency on the SDK can leave installed.
 */
function keypairTransactionSigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    signTransaction(xdrBase64, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "no such file.";
  if (code === "EACCES" || code === "EPERM") return "permission denied.";
  return code ? `${code}.` : "unknown error.";
}
