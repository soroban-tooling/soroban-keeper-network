-- API keys for cost-sensitive endpoints (issue 0243).
--
-- Keys are optional and additive: the core read endpoints stay public, and a
-- key buys a higher rate limit plus access to expensive operations such as bulk
-- export, where per-consumer accountability matters for abuse response.
--
-- The secret is stored as a digest, never in plaintext: a database dump -- a
-- backup, a leaked replica, an over-broad support query -- must not hand out
-- working credentials. Issuance is the only moment the plaintext exists.
--
-- Revoked keys are marked rather than deleted. An abuse investigation needs to
-- know a key existed, who held it, and when it was withdrawn.
CREATE TABLE IF NOT EXISTS api_keys (
    -- Public identifier, safe to log and to quote in a support conversation.
    -- Carried inside the secret so verification is a primary-key lookup rather
    -- than a scan-and-compare across every stored key.
    key_id                  TEXT PRIMARY KEY,
    -- Which consumer this was issued to.
    label                   TEXT NOT NULL,
    secret_hash             TEXT NOT NULL,
    -- Requests per minute this key is allowed, above the anonymous default.
    rate_limit_per_minute   INTEGER NOT NULL,
    created_at              INTEGER NOT NULL,
    -- NULL while the key is live. Set on revocation, and read on every request
    -- so a withdrawal takes effect immediately rather than after a cache TTL.
    revoked_at              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_live ON api_keys (key_id) WHERE revoked_at IS NULL;
