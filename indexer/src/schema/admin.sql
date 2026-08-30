-- Admin and governance-adjacent event storage (issue #350).
--
-- These events are low-volume next to task events, but they are the audit
-- trail: a security reviewer needs to see *every* fee change and *every* admin
-- transfer in order, not just the values that happen to be current. So this
-- schema keeps full history and derives current state from it, the same
-- history-versus-derived-state split the keeper schema uses.
--
-- All seven kinds share one table rather than getting one table each. They are
-- read together — "show me the governance history" is the query that matters —
-- and a single ordered table answers that without a seven-way UNION. The
-- per-kind payload fields differ, so they are nullable columns constrained by
-- `admin_events_payload_present`, which enforces that each kind carries
-- exactly the fields it should.

CREATE TABLE IF NOT EXISTS admin_events (
    ledger        BIGINT NOT NULL,
    tx_index      BIGINT NOT NULL,
    event_index   BIGINT NOT NULL,

    -- One of: paused, fee_updated, admin_transferred, min_reward_updated,
    -- fees_swept, initialized, upgraded.
    kind          TEXT   NOT NULL,

    -- Paused
    paused        BOOLEAN,

    -- FeeUpdated / Initialized. `old_fee_bps` is NULL for Initialized, which
    -- sets the first fee rather than changing one.
    old_fee_bps   INTEGER,
    new_fee_bps   INTEGER,

    -- AdminTransferred / Initialized / Upgraded / FeesSwept.
    -- For AdminTransferred these are the two endpoints; for Initialized,
    -- `new_admin` is the first admin; for Upgraded, `new_admin` is the admin
    -- that authorized the upgrade; for FeesSwept, `treasury` is the recipient.
    old_admin     TEXT,
    new_admin     TEXT,
    treasury      TEXT,
    reward_token  TEXT,

    -- MinRewardUpdated
    old_min_reward NUMERIC(39,0),
    new_min_reward NUMERIC(39,0),

    -- FeesSwept
    swept_amount    NUMERIC(39,0),
    swept_remaining NUMERIC(39,0),

    -- Upgraded — the contract's BytesN<32>, stored as the raw 32 bytes rather
    -- than a hex string so what is stored is byte-identical to what was
    -- emitted.
    wasm_hash     BYTEA,

    PRIMARY KEY (ledger, tx_index, event_index),

    CONSTRAINT admin_events_kind_known CHECK (kind IN (
        'paused', 'fee_updated', 'admin_transferred', 'min_reward_updated',
        'fees_swept', 'initialized', 'upgraded'
    )),

    -- Each kind must carry its own payload. Without this a decoding bug that
    -- dropped a field would land as a silently NULL column and only surface
    -- later as a wrong current-config answer.
    CONSTRAINT admin_events_payload_present CHECK (
        CASE kind
            WHEN 'paused'             THEN paused IS NOT NULL
            WHEN 'fee_updated'        THEN old_fee_bps IS NOT NULL AND new_fee_bps IS NOT NULL
            WHEN 'admin_transferred'  THEN old_admin IS NOT NULL AND new_admin IS NOT NULL
            WHEN 'min_reward_updated' THEN old_min_reward IS NOT NULL AND new_min_reward IS NOT NULL
            WHEN 'fees_swept'         THEN treasury IS NOT NULL AND swept_amount IS NOT NULL
                                           AND swept_remaining IS NOT NULL
            WHEN 'initialized'        THEN new_admin IS NOT NULL AND reward_token IS NOT NULL
                                           AND new_fee_bps IS NOT NULL
            WHEN 'upgraded'           THEN wasm_hash IS NOT NULL AND new_admin IS NOT NULL
        END
    )
);

-- History is read in chain order, and the current-config view below picks the
-- latest row per kind, so both paths want this index.
CREATE INDEX IF NOT EXISTS admin_events_kind_idx
    ON admin_events (kind, ledger DESC, tx_index DESC, event_index DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Current configuration, derived from the latest event of each kind.
--
-- Nothing here is stored: replaying the same events in the same order always
-- reproduces this row, and a later event never overwrites an earlier one's
-- history. That is the property acceptance criterion 2 asks for, and it is
-- what makes criterion 3 (correct after a mixed sequence) testable at all.
--
-- Each field takes the latest row of the kind that sets it:
--   * fee_bps  — the newest of FeeUpdated or Initialized, since both set it
--   * admin    — the newest of AdminTransferred or Initialized
--   * paused   — the newest Paused, defaulting to false before any is seen
--   * min_reward — the newest MinRewardUpdated; the contract's default is 0
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW current_config AS
SELECT
    (SELECT new_fee_bps FROM admin_events
      WHERE kind IN ('fee_updated', 'initialized')
      ORDER BY ledger DESC, tx_index DESC, event_index DESC
      LIMIT 1) AS fee_bps,

    (SELECT new_admin FROM admin_events
      WHERE kind IN ('admin_transferred', 'initialized')
      ORDER BY ledger DESC, tx_index DESC, event_index DESC
      LIMIT 1) AS admin,

    -- The contract starts unpaused, so the absence of any Paused event is
    -- `false`, not "unknown".
    COALESCE((SELECT paused FROM admin_events
               WHERE kind = 'paused'
               ORDER BY ledger DESC, tx_index DESC, event_index DESC
               LIMIT 1), FALSE) AS paused,

    -- MinReward defaults to 0 in the contract (see DataKey::MinReward).
    COALESCE((SELECT new_min_reward FROM admin_events
               WHERE kind = 'min_reward_updated'
               ORDER BY ledger DESC, tx_index DESC, event_index DESC
               LIMIT 1), 0) AS min_reward,

    (SELECT reward_token FROM admin_events
      WHERE kind = 'initialized'
      ORDER BY ledger DESC, tx_index DESC, event_index DESC
      LIMIT 1) AS reward_token,

    -- The most recent upgrade, so an auditor can tell which WASM is live.
    (SELECT wasm_hash FROM admin_events
      WHERE kind = 'upgraded'
      ORDER BY ledger DESC, tx_index DESC, event_index DESC
      LIMIT 1) AS current_wasm_hash;
