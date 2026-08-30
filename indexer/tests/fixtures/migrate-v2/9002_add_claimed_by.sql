-- Fixture v2: an additive change against live data. Forward-only and
-- additive is the migration discipline documented in migrations/README.md.
alter table fixture_tasks
    add column if not exists claimed_by text;
