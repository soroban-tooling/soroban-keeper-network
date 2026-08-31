// `Keypair.random()` (and, it turns out, `Keypair.fromRawEd25519Seed` given
// a Node `Buffer`) fails under vitest's jsdom environment with
// `"secretKey" expected Uint8Array of length 32, got type=object`. Root
// cause, confirmed by direct inspection rather than assumed: jsdom runs in
// its own JS realm with its own `Uint8Array` global, and Node's `Buffer`
// subclasses the *Node-realm* `Uint8Array` — so `nodeBuffer instanceof
// Uint8Array` is `false` when checked against jsdom's global, which is
// exactly the check `@noble/ed25519`'s internal `abytes` validator performs.
// Wrapping the seed in `new Uint8Array(seed)` copies it into a plain
// array backed by *this* realm's `Uint8Array` constructor, which passes.
import { Keypair } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";

export function randomKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(new Uint8Array(randomBytes(32)));
}
