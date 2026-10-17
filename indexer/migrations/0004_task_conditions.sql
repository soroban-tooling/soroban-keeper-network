-- Additive task-condition indexing. Existing rows remain NULL, preserving
-- deterministic behavior for events emitted by pre-condition deployments.
ALTER TABLE events ADD COLUMN condition_address TEXT;

CREATE INDEX IF NOT EXISTS idx_events_condition
    ON events (condition_address)
    WHERE condition_address IS NOT NULL;
