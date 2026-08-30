-- Keeper-facing event storage (issue #349).
--
-- The point of this schema is that "what has this keeper address done" is one
-- indexed lookup per event kind, not a full scan of the task-events table with
-- client-side filtering. Every table here is therefore keyed on `keeper` first.
--
-- Amounts are the contract's i128 token units (stroops). NUMERIC(39, 0) is
-- used rather than BIGINT because i128 does not fit in a 64-bit column;
-- 39 digits covers the full i128 range, and scale 0 keeps them exact
-- integers so summing them can never introduce a floating-point discrepancy
-- against the contract's own arithmetic.
--
-- Every table carries the (ledger, tx_index, event_index) cursor the event was
-- observed at. It is both the ordering key for history and the uniqueness key
-- that makes re-ingesting an already-seen ledger a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- Claims — one row per TaskClaimed event.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_claims (
    ledger       BIGINT      NOT NULL,
    tx_index     BIGINT      NOT NULL,
    event_index  BIGINT      NOT NULL,
    keeper       TEXT        NOT NULL,
    task_id      BIGINT      NOT NULL,
    -- The ledger sequence the contract stamped at claim time. This is the
    -- contract's own value from the event payload, not the ledger we observed
    -- the event in; the two agree today but the payload is the authority.
    claim_ledger BIGINT      NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_claims_keeper_idx
    ON keeper_claims (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Executions — one row per TaskExecuted event.
--
-- `net_reward` is what the keeper was actually credited (reward minus the
-- protocol fee), which is why the derived balance below sums this column and
-- not the task's gross reward.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_executions (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    task_id      BIGINT        NOT NULL,
    net_reward   NUMERIC(39,0) NOT NULL,
    proof        BYTEA         NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_executions_keeper_idx
    ON keeper_executions (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Withdrawals — one row per RewardsWithdrawn event.
--
-- Note that the contract's `withdraw_rewards` zeroes the whole balance, so
-- `amount` is always a full drain of what was credited at that moment. The
-- schema does not assume that, because a future partial-withdrawal entry point
-- would emit the same event with a smaller amount and this table would still
-- be correct.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keeper_withdrawals (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    keeper       TEXT          NOT NULL,
    amount       NUMERIC(39,0) NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS keeper_withdrawals_keeper_idx
    ON keeper_withdrawals (keeper, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Derived balance per keeper.
--
-- This mirrors the contract's `keeper_balance` view exactly:
--
--     KeeperReward(addr) = Σ net_reward (credit_keeper on execute)
--                        − Σ amount     (withdraw_rewards zeroes the entry)
--
-- Exposing it as a view rather than leaving each consumer to recompute the
-- subtraction is the point of acceptance criterion 2 on issue #349 — there is
-- one definition of "credited but unwithdrawn", and it lives here.
--
-- `credited_total` and `withdrawn_total` are kept as their own columns so a
-- consumer can distinguish lifetime earnings from the current claimable
-- balance without a second query.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW keeper_balances AS
WITH credited AS (
    SELECT keeper, SUM(net_reward) AS total
    FROM keeper_executions
    GROUP BY keeper
),
withdrawn AS (
    SELECT keeper, SUM(amount) AS total
    FROM keeper_withdrawals
    GROUP BY keeper
)
SELECT
    k.keeper                                        AS keeper,
    COALESCE(c.total, 0)                            AS credited_total,
    COALESCE(w.total, 0)                            AS withdrawn_total,
    COALESCE(c.total, 0) - COALESCE(w.total, 0)     AS available_balance
FROM (
    SELECT keeper FROM keeper_executions
    UNION
    SELECT keeper FROM keeper_withdrawals
) AS k
LEFT JOIN credited  c ON c.keeper = k.keeper
LEFT JOIN withdrawn w ON w.keeper = k.keeper;
