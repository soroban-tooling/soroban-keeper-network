export const INIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS keeper_task_outcomes (
  task_id BIGINT PRIMARY KEY,
  task_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  keeper_address VARCHAR(64),
  profit_stroops BIGINT DEFAULT 0,
  skip_reason TEXT,
  claimed_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_keeper_task_outcomes_type ON keeper_task_outcomes(task_type);
CREATE INDEX IF NOT EXISTS idx_keeper_task_outcomes_status ON keeper_task_outcomes(status);
`;
