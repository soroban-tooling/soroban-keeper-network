/**
 * The SDK's test RPC, re-exported for the CLI tests. It lives in the SDK's
 * own `test/support` so that its encoding stays coupled to the real
 * `@stellar/stellar-sdk` round trip; the CLI reuses it rather than keeping a
 * second fake that could drift.
 */
export { FakeRpc } from "../../../sdk-ts/test/support/fakeRpc.js";
