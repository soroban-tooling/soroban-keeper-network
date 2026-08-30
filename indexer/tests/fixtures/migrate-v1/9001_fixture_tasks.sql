-- Fixture v1: the schema an early deployment ran.
create table if not exists fixture_tasks (
    id     bigint primary key,
    status text not null
);
