
CREATE TABLE IF NOT EXISTS reputation_events (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    action       TEXT          NOT NULL,
    score        BIGINT        NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS reputation_events_keeper_idx
    ON reputation_events (keeper, ledger, tx_index, event_index);

CREATE OR REPLACE VIEW current_reputation AS
SELECT DISTINCT ON (keeper)
    keeper,
    score
FROM reputation_events
ORDER BY keeper, ledger DESC, tx_index DESC, event_index DESC;
