-- Governance event storage and views (Issue #504 / backlog 0376).
--
-- Tracks proposals end to end: creation, every vote cast, evaluations,
-- queueing, execution, and cancellation.
--
-- Conforms to the indexer's design principles:
-- 1. History first, state derived: All raw events are stored in append-only tables
--    keyed by (ledger, tx_index, event_index).
-- 2. Complete lifecycle view: `governance_proposal_lifecycles` assembles the full
--    lifecycle of every proposal (proposer, action, votes, tallies, execution status).
-- 3. Per-address voting history: `governance_address_votes` provides an activity-feed
--    ready query surface for each voter.

-- ─────────────────────────────────────────────────────────────────────────────
-- Proposals: Created proposals audit trail
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_proposals (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    proposal_id  BIGINT        NOT NULL,
    proposer     TEXT          NOT NULL,
    voting_end   BIGINT        NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index),
    UNIQUE (proposal_id)
);

CREATE INDEX IF NOT EXISTS governance_proposals_proposer_idx
    ON governance_proposals (proposer, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Votes: Every vote cast
-- choice: 0 = Against, 1 = For, 2 = Abstain
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_votes (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    proposal_id  BIGINT        NOT NULL,
    voter        TEXT          NOT NULL,
    choice       INTEGER       NOT NULL,
    weight       NUMERIC(39,0) NOT NULL,
    PRIMARY KEY (ledger, tx_index, event_index),
    CONSTRAINT governance_votes_choice_valid CHECK (choice IN (0, 1, 2))
);

CREATE INDEX IF NOT EXISTS governance_votes_proposal_idx
    ON governance_votes (proposal_id, ledger, tx_index, event_index);

CREATE INDEX IF NOT EXISTS governance_votes_voter_idx
    ON governance_votes (voter, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Status transitions: passed, defeated, queued, executed, cancelled
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_transitions (
    ledger       BIGINT        NOT NULL,
    tx_index     BIGINT        NOT NULL,
    event_index  BIGINT        NOT NULL,
    proposal_id  BIGINT        NOT NULL,
    kind         TEXT          NOT NULL,
    caller       TEXT,
    eta          BIGINT,
    votes_for    NUMERIC(39,0),
    votes_against NUMERIC(39,0),
    total_votes  NUMERIC(39,0),
    quorum       NUMERIC(39,0),
    PRIMARY KEY (ledger, tx_index, event_index),
    CONSTRAINT governance_transitions_kind_valid CHECK (kind IN (
        'passed', 'defeated', 'queued', 'executed', 'cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS governance_transitions_proposal_idx
    ON governance_transitions (proposal_id, ledger, tx_index, event_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-proposal full lifecycle view
-- Assembles creation, vote tallies, latest status, and timing.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_proposal_lifecycles AS
WITH vote_sums AS (
    SELECT
        proposal_id,
        COALESCE(SUM(CASE WHEN choice = 1 THEN weight ELSE 0 END), 0) AS votes_for,
        COALESCE(SUM(CASE WHEN choice = 0 THEN weight ELSE 0 END), 0) AS votes_against,
        COALESCE(SUM(CASE WHEN choice = 2 THEN weight ELSE 0 END), 0) AS votes_abstain,
        COUNT(*) AS total_votes_cast
    FROM governance_votes
    GROUP BY proposal_id
),
latest_transition AS (
    SELECT DISTINCT ON (proposal_id)
        proposal_id,
        kind AS status,
        eta,
        ledger AS status_ledger
    FROM governance_transitions
    ORDER BY proposal_id, ledger DESC, tx_index DESC, event_index DESC
)
SELECT
    p.proposal_id,
    p.proposer,
    p.ledger AS created_ledger,
    p.voting_end,
    COALESCE(t.status, 'active') AS status,
    t.eta,
    t.status_ledger,
    COALESCE(v.votes_for, 0) AS votes_for,
    COALESCE(v.votes_against, 0) AS votes_against,
    COALESCE(v.votes_abstain, 0) AS votes_abstain,
    COALESCE(v.total_votes_cast, 0) AS total_votes_cast
FROM governance_proposals p
LEFT JOIN vote_sums v ON v.proposal_id = p.proposal_id
LEFT JOIN latest_transition t ON t.proposal_id = p.proposal_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-address voting history query view
-- Matches activity feed pattern for addresses participating in governance.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW governance_address_votes AS
SELECT
    v.voter,
    v.proposal_id,
    v.choice,
    CASE v.choice
        WHEN 0 THEN 'against'
        WHEN 1 THEN 'for'
        WHEN 2 THEN 'abstain'
    END AS choice_label,
    v.weight,
    v.ledger,
    v.tx_index,
    v.event_index,
    p.proposer AS proposal_proposer,
    p.voting_end AS proposal_voting_end
FROM governance_votes v
JOIN governance_proposals p ON p.proposal_id = v.proposal_id
ORDER BY v.voter, v.ledger DESC, v.tx_index DESC, v.event_index DESC;
