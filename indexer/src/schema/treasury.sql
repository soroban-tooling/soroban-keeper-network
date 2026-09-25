-- Treasury contract event storage.
--
-- Mirrors the keeper/admin schema split in `keepers.sql` / `admin.sql`:
-- recipient-management events (added/removed/shares-updated) get their own
-- audit-trail table, distributions and withdrawals get their own append-only
-- tables, and every derived answer -- current recipient set, a recipient's
-- balance, the running total distributed -- is a view folded from that
-- history rather than mutable state kept separately.

CREATE TABLE IF NOT EXISTS treasury_recipient_events (
    ledger          BIGINT NOT NULL,
    tx_index        BIGINT NOT NULL,
    event_index     BIGINT NOT NULL,

    -- One of: added, removed, shares_updated.
    kind            TEXT   NOT NULL,
    recipient       TEXT   NOT NULL,

    -- `added` sets `shares_bps`. `shares_updated` sets both `old_shares_bps`
    -- and `new_shares_bps`. `removed` carries no share fields.
    shares_bps      INTEGER,
    old_shares_bps  INTEGER,
    new_shares_bps  INTEGER,

    PRIMARY KEY (ledger, tx_index, event_index),

    CONSTRAINT treasury_recipient_events_kind_known CHECK (kind IN (
        'added', 'removed', 'shares_updated'
    )),
    CONSTRAINT treasury_recipient_events_payload_present CHECK (
        CASE kind
            WHEN 'added'          THEN shares_bps IS NOT NULL
            WHEN 'removed'        THEN TRUE
            WHEN 'shares_updated' THEN old_shares_bps IS NOT NULL AND new_shares_bps IS NOT NULL
        END
    )
);

CREATE INDEX IF NOT EXISTS treasury_recipient_events_recipient_idx
    ON treasury_recipient_events (recipient, ledger DESC, tx_index DESC, event_index DESC);

-- Every `Distributed` event is its own row -- one per recipient credited in a
-- single `distribute` call -- so a per-recipient distribution history query
-- (the pattern `keeper_activity`/`keeper_executions` establishes for
-- per-keeper activity) is a plain filtered `SELECT`, and `SUM(amount)` over
-- the whole table is the indexer's independent check against the contract's
-- own `total_distributed` view.
CREATE TABLE IF NOT EXISTS treasury_distributions (
    ledger             BIGINT NOT NULL,
    tx_index           BIGINT NOT NULL,
    event_index        BIGINT NOT NULL,
    recipient          TEXT   NOT NULL,
    amount             NUMERIC(39,0) NOT NULL,
    -- The contract's own running lifetime total immediately after this
    -- credit, as emitted -- lets a consumer sanity-check without a separate
    -- aggregate query.
    total_distributed  NUMERIC(39,0) NOT NULL,

    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS treasury_distributions_recipient_idx
    ON treasury_distributions (recipient, ledger, tx_index, event_index);

CREATE TABLE IF NOT EXISTS treasury_withdrawals (
    ledger       BIGINT NOT NULL,
    tx_index     BIGINT NOT NULL,
    event_index  BIGINT NOT NULL,
    recipient    TEXT   NOT NULL,
    amount       NUMERIC(39,0) NOT NULL,

    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS treasury_withdrawals_recipient_idx
    ON treasury_withdrawals (recipient, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Current recipient set, derived from the latest recipient-management event
-- per address. A `removed` recipient (or one that has never seen `added`) is
-- excluded rather than shown with a zero share -- it is not a current
-- recipient, distinct from one configured with a zero share (which the
-- contract itself never allows, but this view does not assume that).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW treasury_current_recipients AS
SELECT DISTINCT ON (recipient)
    recipient,
    CASE kind
        WHEN 'added'          THEN shares_bps
        WHEN 'shares_updated' THEN new_shares_bps
    END AS shares_bps
FROM treasury_recipient_events
ORDER BY recipient, ledger DESC, tx_index DESC, event_index DESC;

-- Only currently-registered (non-removed) recipients appear.
CREATE OR REPLACE VIEW treasury_current_recipients_active AS
SELECT recipient, shares_bps
FROM treasury_current_recipients
WHERE shares_bps IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-recipient balance: credited total minus withdrawn total. Must agree
-- with the contract's `recipient_balance` view once the indexer is caught up
-- -- the same agreement `keeper_balances` establishes for keepers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW treasury_recipient_balances AS
SELECT
    recipient,
    COALESCE(credited_total, 0) AS credited_total,
    COALESCE(withdrawn_total, 0) AS withdrawn_total,
    COALESCE(credited_total, 0) - COALESCE(withdrawn_total, 0) AS available_balance
FROM (
    SELECT
        recipient,
        COALESCE(SUM(amount), 0) AS credited_total
    FROM treasury_distributions
    GROUP BY recipient
) credited
FULL OUTER JOIN (
    SELECT
        recipient,
        COALESCE(SUM(amount), 0) AS withdrawn_total
    FROM treasury_withdrawals
    GROUP BY recipient
) withdrawn USING (recipient);
