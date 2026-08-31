-- Task lifecycle event storage (issue #348).
--
-- Stores all task lifecycle events: TaskRegistered, TaskClaimed, TaskExecuted,
-- TaskExpired, TaskCancelled, RewardIncreased, and DeadlineExtended.
--
-- Amounts are the contract's i128 token units (stroops). NUMERIC(39, 0) is
-- used rather than BIGINT because i128 does not fit in a 64-bit column.
--
-- Every table carries the (ledger, tx_index, event_index) cursor the event was
-- observed at. It is both the ordering key for history and the uniqueness key
-- that makes re-ingesting an already-seen ledger a no-op.

CREATE TABLE IF NOT EXISTS task_events (
    ledger        BIGINT NOT NULL,
    tx_index      BIGINT NOT NULL,
    event_index   BIGINT NOT NULL,

    -- One of: registered, claimed, executed, expired, cancelled, reward_increased, deadline_extended.
    kind          TEXT   NOT NULL,
    task_id       BIGINT NOT NULL,

    owner         TEXT,
    keeper        TEXT,
    reward        NUMERIC(39,0),
    net_reward    NUMERIC(39,0),
    deadline      BIGINT,
    claim_ledger  BIGINT,
    proof         BYTEA,

    PRIMARY KEY (ledger, tx_index, event_index),

    CONSTRAINT task_events_kind_known CHECK (kind IN (
        'registered', 'claimed', 'executed', 'expired', 'cancelled', 'reward_increased', 'deadline_extended'
    )),

    CONSTRAINT task_events_payload_present CHECK (
        CASE kind
            WHEN 'registered'        THEN owner IS NOT NULL AND reward IS NOT NULL AND deadline IS NOT NULL
            WHEN 'claimed'           THEN keeper IS NOT NULL AND claim_ledger IS NOT NULL
            WHEN 'executed'          THEN keeper IS NOT NULL AND net_reward IS NOT NULL AND proof IS NOT NULL
            WHEN 'expired'           THEN TRUE
            WHEN 'cancelled'         THEN owner IS NOT NULL
            WHEN 'reward_increased'  THEN reward IS NOT NULL
            WHEN 'deadline_extended' THEN deadline IS NOT NULL
        END
    )
);

CREATE INDEX IF NOT EXISTS task_events_task_id_idx
    ON task_events (task_id, ledger ASC, tx_index ASC, event_index ASC);
