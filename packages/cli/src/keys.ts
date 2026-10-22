import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { usageError } from "./errors.js";
import type { Runtime } from "./runtime.js";

export interface LoadedKey {
  keypair: Keypair;
  publicKey: string;
  secret: string;
}

/**
 * Loads the signing key from `--key-file` or, failing that, the
 * `SKN_SECRET_KEY` environment variable.
 *
 * There is deliberately no `--secret-key` flag: a value on the command line
 * lands in shell history and in `ps` output. Neither source is ever echoed.
 * The secret is registered with the runtime so {@link toCliError} scrubs it from
 * any message, and every message produced here names the source, never the value.
 */
export function loadKey(rt: Runtime, keyFile: string | undefined): LoadedKey {
  let raw: string | undefined;
  let source: string;

  if (keyFile) {
    source = `key file ${keyFile}`;
    raw = rt.readFile(keyFile);
  } else if (rt.env.SKN_SECRET_KEY) {
    source = "SKN_SECRET_KEY";
    raw = rt.env.SKN_SECRET_KEY;
  } else {
    throw usageError(
      "This command signs a transaction and needs a secret key. Set SKN_SECRET_KEY, or pass " +
        "--key-file <path> to a file containing the key. Keys are never accepted as flags.",
    );
  }

  const secret = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!secret) {
    throw usageError(`The ${source} is empty.`);
  }
  rt.secrets.push(secret);

  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw usageError(`The ${source} is not a valid Stellar secret seed (it should start with "S"). The value is not shown.`);
  }

  const keypair = Keypair.fromSecret(secret);
  return { keypair, publicKey: keypair.publicKey(), secret };
}
