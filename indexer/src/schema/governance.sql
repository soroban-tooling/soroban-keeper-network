-- Governance contract event storage and views (Issue #504).
--
-- Mirrors the audit trail and aggregation patterns established in `admin.sql`,
-- `keepers.sql`, and `treasury.sql`:
-- - Raw events are stored in append-only immutable tables:
--   - `governance_proposals`: proposal creation events
--   - `governance_votes`: individual vote events cast on proposals
--   - `governance_executions`: proposal execution status transitions (executed, failed, cancelled)
-- - Derived views fold the full proposal lifecycle and per-voter activity history:
--   - `governance_proposal_tallies`: vote counts and voting power aggregated per proposal
--   - `governance_proposal_lifecycle`: full lifecycle view per proposal (creator, votes, tally, status)
--   - `governance_voter_activity`: chronological per-address voting activity feed (issue 0229 pattern)

CREATE TABLE IF NOT EXISTS governance_proposals (
    ledger          BIGINT NOT NULL,
    tx_index        BIGINT NOT NULL,
    event_index     BIGINT NOT NULL,

    proposal_id     BIGINT NOT NULL,
    proposer        TEXT   NOT NULL,
    eta             BIGINT NOT NULL,
    action          TEXT,

    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS governance_proposals_id_idx
    ON governance_proposals (proposal_id);

CREATE INDEX IF NOT EXISTS governance_proposals_proposer_idx
    ON governance_proposals (proposer, ledger DESC, tx_index DESC);

CREATE TABLE IF NOT EXISTS governance_votes (
    ledger          BIGINT NOT NULL,
    tx_index        BIGINT NOT NULL,
    event_index     BIGINT NOT NULL,

    proposal_id     BIGINT NOT NULL,
    voter           TEXT   NOT NULL,
    support         INTEGER NOT NULL,
    voting_power    NUMERIC(39,0) NOT NULL DEFAULT 0,

    PRIMARY KEY (ledger, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS governance_votes_proposal_idx
    ON governance_votes (proposal_id, ledger, tx_index, event_index);

CREATE INDEX IF NOT EXISTS governance_votes_voter_idx
    ON governance_votes (voter, ledger DESC, tx_index DESC, event_index DESC);

CREATE TABLE IF NOT EXISTS governance_executions (
    ledger          BIGINT NOT NULL,
    tx_index        BIGINT NOT NULL,
    event_index     BIGINT NOT NULL,

    proposal_id     BIGINT NOT NULL,
    status          TEXT   NOT NULL, -- 'executed', 'failed', 'cancelled'

    PRIMARY KEY (ledger, tx_index, event_index),

    CONSTRAINT governance_executions_status_known CHECK (status IN (
        'executed', 'failed', 'cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS governance_executions_proposal_idx
    ON governance_executions (proposal_id, ledger DESC, tx_index DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Vote tallies aggregated per proposal
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_proposal_tallies AS
SELECT
    proposal_id,
    COUNT(*) AS total_votes,
    COUNT(*) FILTER (WHERE support = 1) AS votes_for,
    COUNT(*) FILTER (WHERE support = 0) AS votes_against,
    COUNT(*) FILTER (WHERE support = 2) AS votes_abstain,
    COALESCE(SUM(voting_power) FILTER (WHERE support = 1), 0) AS voting_power_for,
    COALESCE(SUM(voting_power) FILTER (WHERE support = 0), 0) AS voting_power_against,
    COALESCE(SUM(voting_power) FILTER (WHERE support = 2), 0) AS voting_power_abstain
FROM governance_votes
GROUP BY proposal_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Latest execution record per proposal
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_proposal_latest_execution AS
SELECT DISTINCT ON (proposal_id)
    proposal_id,
    status AS execution_status,
    ledger AS execution_ledger
FROM governance_executions
ORDER BY proposal_id, ledger DESC, tx_index DESC, event_index DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Assembled full proposal lifecycle (acceptance criterion 2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_proposal_lifecycle AS
SELECT
    p.proposal_id,
    p.proposer,
    p.eta,
    p.ledger AS created_ledger,
    COALESCE(t.total_votes, 0) AS total_votes,
    COALESCE(t.votes_for, 0) AS votes_for,
    COALESCE(t.votes_against, 0) AS votes_against,
    COALESCE(t.votes_abstain, 0) AS votes_abstain,
    COALESCE(t.voting_power_for, 0) AS voting_power_for,
    COALESCE(t.voting_power_against, 0) AS voting_power_against,
    COALESCE(t.voting_power_abstain, 0) AS voting_power_abstain,
    COALESCE(e.execution_status, 'queued') AS status,
    e.execution_ledger
FROM (
    SELECT DISTINCT ON (proposal_id)
        proposal_id, proposer, eta, ledger
    FROM governance_proposals
    ORDER BY proposal_id, ledger DESC, tx_index DESC, event_index DESC
) p
LEFT JOIN governance_proposal_tallies t USING (proposal_id)
LEFT JOIN governance_proposal_latest_execution e USING (proposal_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-address voting activity feed (acceptance criterion 3, issue 0229 pattern)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_voter_activity AS
SELECT
    v.voter,
    v.proposal_id,
    v.support,
    v.voting_power,
    v.ledger,
    v.tx_index,
    v.event_index,
    p.proposer,
    p.eta
FROM governance_votes v
LEFT JOIN (
    SELECT DISTINCT ON (proposal_id)
        proposal_id, proposer, eta
    FROM governance_proposals
    ORDER BY proposal_id, ledger DESC, tx_index DESC, event_index DESC
) p USING (proposal_id)
ORDER BY v.voter, v.ledger DESC, v.tx_index DESC, v.event_index DESC;
