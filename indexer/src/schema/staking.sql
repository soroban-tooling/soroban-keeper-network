-- Keeper staking event storage (epic E06, issue 0296 / GitHub #432).
--
-- Follows keepers.sql's exact pattern: one history table per event kind, keyed
-- on `keeper` first, plus a derived `CREATE OR REPLACE VIEW` mirroring the
-- contract's own `keeper_stake` view. See docs/STAKING_DESIGN.md for the
-- underlying contract design this schema tracks.
--
-- Amounts are NUMERIC(39, 0) for the same reason as keepers.sql: i128 does not
-- fit in a 64-bit column, and scale 0 keeps sums exact against the contract's
-- own arithmetic.
--
-- Every table carries the (ledger, tx_index, event_index) cursor, both the
-- ordering key for history and the uniqueness key that makes re-ingesting an
-- already-seen ledger a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- Deposits — one row per StakeDeposited event.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_stake_deposits (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    amount       NUMERIC(39,0) NOT NULL,
    new_total    NUMERIC(39,0) NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_stake_deposits_keeper_idx
    ON keeper_stake_deposits (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Unbond requests — one row per UnbondInitiated event.
--
-- Kept for the audit trail only, same as keeper_claims exists in keepers.sql
-- without contributing to keeper_balances. The contract does not move any
-- tokens or change keeper_stake at initiate_unbond time (docs/STAKING_DESIGN.md
-- §3), so this table deliberately does not feed keeper_stakes below.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_unbonds (
    ledger         BIGINT        NOT NULL,
    tx_index       BIGINT        NOT NULL,
    event_index    BIGINT        NOT NULL,
    keeper         TEXT          NOT NULL,
    amount         NUMERIC(39,0) NOT NULL,
    release_ledger BIGINT        NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_unbonds_keeper_idx
    ON keeper_unbonds (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Withdrawals — one row per StakeWithdrawn event.
--
-- `amount` is the value the event itself carries, which is already the
-- contract's post-clamp figure (min(request.amount, current_stake) — see
-- staking.rs's withdraw_stake), so this table does not need to reimplement
-- that clamp.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_stake_withdrawals (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    amount       NUMERIC(39,0) NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_stake_withdrawals_keeper_idx
    ON keeper_stake_withdrawals (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Slashes — one row per Slashed event.
--
-- `incident_id` is stored as the raw 32 bytes the contract emits (mirroring
-- admin.sql's `wasm_hash BYTEA` treatment of Upgraded's BytesN<32>), so the
-- stored value is byte-identical to what was emitted. UNIQUE mirrors the
-- contract's own incident-level idempotency (a repeat slash on the same
-- incident_id is rejected on-chain with DuplicateSlashIncident), as
-- defense-in-depth against a source that somehow replayed a different event
-- under the same incident_id.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_slashes (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    amount       NUMERIC(39,0) NOT NULL,
    reason       TEXT          NOT NULL,
    incident_id  BYTEA         NOT NULL,
    treasury     TEXT          NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index),
    UNIQUE (incident_id)
);

CREATE INDEX IF NOT EXISTS keeper_slashes_keeper_idx
    ON keeper_slashes (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Derived stake per keeper.
--
-- Mirrors the contract's `keeper_stake` view exactly:
--
--     KeeperStake(addr) = Σ amount (stake_deposit)
--                        − Σ amount (withdraw_stake)
--                        − Σ amount (slash)
--
-- UnbondInitiated contributes nothing here, matching the contract: the stake
-- stays escrowed (and slashable) until withdraw_stake actually releases it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW keeper_stakes AS
WITH deposited AS (
    SELECT keeper, SUM(amount) AS total
    FROM keeper_stake_deposits
    GROUP BY keeper
),
withdrawn AS (
    SELECT keeper, SUM(amount) AS total
    FROM keeper_stake_withdrawals
    GROUP BY keeper
),
slashed AS (
    SELECT keeper, SUM(amount) AS total
    FROM keeper_slashes
    GROUP BY keeper
)
SELECT
    k.keeper                                                            AS keeper,
    COALESCE(d.total, 0)                                                AS deposited_total,
    COALESCE(w.total, 0)                                                AS withdrawn_total,
    COALESCE(s.total, 0)                                                AS slashed_total,
    COALESCE(d.total, 0) - COALESCE(w.total, 0) - COALESCE(s.total, 0)  AS current_stake
FROM (
    SELECT keeper FROM keeper_stake_deposits
    UNION
    SELECT keeper FROM keeper_stake_withdrawals
    UNION
    SELECT keeper FROM keeper_slashes
) AS k
LEFT JOIN deposited d ON d.keeper = k.keeper
LEFT JOIN withdrawn w ON w.keeper = k.keeper
LEFT JOIN slashed   s ON s.keeper = k.keeper;
