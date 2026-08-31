-- Initial indexer schema.
--
-- One append-only `events` table is the source of truth for all fifteen
-- registry events; every derived view (task state, keeper balances, current
-- admin config) is computed by folding that history rather than being kept as
-- mutable state that could drift from the events it came from.

CREATE TABLE IF NOT EXISTS events (
    -- Monotonic ingestion sequence. This is the API's pagination cursor: it is
    -- assigned once on insert and never renumbered, so a page boundary stays
    -- correct even as new events arrive between a client's requests.
    cursor            INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger            INTEGER NOT NULL,
    ledger_close_time INTEGER NOT NULL,
    tx_hash           TEXT    NOT NULL,
    event_index       INTEGER NOT NULL,
    event_type        TEXT    NOT NULL,
    -- Denormalised filter columns, so the API can select by task or address
    -- without decoding every payload. NULL where the event has no such field.
    task_id           INTEGER,
    owner_address     TEXT,
    keeper_address    TEXT,
    -- The full typed payload, exactly as the REST and WebSocket feeds emit it.
    payload           TEXT    NOT NULL,

    -- Ingestion idempotency: re-reading a ledger, whether from an overlapping
    -- backfill page or a retried poll, must not duplicate an event. A
    -- (tx_hash, event_index) pair identifies an emission uniquely.
    UNIQUE (tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_owner ON events (owner_address) WHERE owner_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_keeper ON events (keeper_address) WHERE keeper_address IS NOT NULL;

-- Leaderboard and keeper-balance queries both scan executions by keeper over a
-- time window; this covering index keeps that from touching the payload blob.
CREATE INDEX IF NOT EXISTS idx_events_keeper_time
    ON events (keeper_address, ledger_close_time)
    WHERE keeper_address IS NOT NULL;

-- Ingestion progress, so an interrupted backfill resumes where it stopped
-- rather than restarting from the configured start ledger. Single row.
CREATE TABLE IF NOT EXISTS ingest_checkpoint (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    -- Highest ledger fully ingested. Every event at or below this is stored.
    last_ledger         INTEGER NOT NULL,
    -- False until the historical walk reaches the chain tip; the service uses
    -- this to decide whether to keep backfilling or switch to steady polling.
    backfill_complete   INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL
);
