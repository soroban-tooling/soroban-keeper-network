-- Per-ledger content fingerprints, so a ledger the RPC source later reports
-- differently is detected rather than silently absorbed (issue 0224).
--
-- Stellar's SCP has deterministic finality, so a closed ledger cannot be
-- replaced by a competing history. A ledger that reads differently on a second
-- look is therefore an RPC-node view problem, not a chain reorganization -- and
-- the two need opposite handling. A reorg would make the new answer
-- authoritative; an inconsistent node view means one of the two answers is
-- wrong and we cannot tell which, so nothing here is ever overwritten.
--
-- The row is written on first sight and never updated. On a disagreement the
-- original survives, because it is the only evidence that the two views ever
-- differed.
CREATE TABLE IF NOT EXISTS ledger_fingerprints (
    ledger          INTEGER PRIMARY KEY,
    -- How many events the source reported for this ledger.
    event_count     INTEGER NOT NULL,
    -- Order-independent digest over the ledger's events. Stored as INTEGER
    -- because SQLite has no unsigned type; read back through the same cast.
    digest          INTEGER NOT NULL,
    first_seen_at   INTEGER NOT NULL
);
