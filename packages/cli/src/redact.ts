/**
 * Scrubs credentials from operator-facing text.
 *
 * RPC provider URLs frequently carry an API key in the user info or query
 * string. Confirmation prompts and error messages can echo those URLs, and
 * terminal output often ends up in CI logs, so every message that can contain
 * external text passes through here before it is printed.
 */

/** Matches a URL with a scheme, optional user info, and an optional query. */
const URL_LIKE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/"'?#]*@)?([^\s"'#]+)/gi;

/** A Stellar ed25519 secret seed. Never print one, even if an error quotes it. */
const SEED_LIKE = /S[A-Z2-7]{55}/g;

/**
 * Returns `text` with user info and query strings removed from any URL and
 * with Stellar secret seeds replaced by `[REDACTED]`.
 *
 * The scheme, host and path are kept: they are needed to identify which
 * endpoint failed. Plain text without a URL is returned unchanged.
 */
export function redactSecrets(text: string): string {
  const withoutUrls = text.replace(
    URL_LIKE,
    (match, scheme: string, userInfo: string | undefined, rest: string) => {
      const path = rest.split("?")[0] ?? "";
      return userInfo === undefined && path === rest ? match : `${scheme}${path}`;
    },
  );
  return withoutUrls.replace(SEED_LIKE, "[REDACTED]");
}
