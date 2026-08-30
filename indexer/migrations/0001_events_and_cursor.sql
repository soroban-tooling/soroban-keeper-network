-- The raw event log and the ingest cursor — the idempotency boundary from
-- docs/INDEXER_DESIGN.md §6. Every derived table (0220–0222) is a projection
-- of `events` and applies its effects only when the raw insert here actually
-- inserted; `event_id` is the documented uniqueness key (the RPC's
-- TOID-derived event id: ledger, transaction application order, operation
-- index, event index — deterministic, so identical across backfill and
-- steady-state, which both read the same getEvents surface).

create table if not exists ingest_cursor (
    id          text primary key,
    last_ledger bigint not null,
    updated_at  timestamptz not null default now()
);

create table if not exists events (
    event_id    text primary key,
    ledger      bigint not null,
    closed_at   timestamptz not null,
    contract_id text not null,
    type        text not null,
    -- The task a task-scoped event concerns; null for admin/keeper-scoped
    -- events. Extracted from the payload so "events by task id" — the task
    -- detail page's history query — is an index hit, not a jsonb scan.
    task_id     bigint,
    payload     jsonb not null
);

create index if not exists events_type_ledger on events (type, ledger);
create index if not exists events_task_id on events (task_id) where task_id is not null;

-- Derived: current task state (0220 owns fleshing this out for every
-- feeding event; the columns are exactly the design's).
create table if not exists tasks (
    task_id           bigint primary key,
    owner             text not null,
    reward            numeric not null,
    deadline          bigint not null,
    status            text not null,
    claimed_by        text,
    claimed_at_ledger bigint,
    executed_by       text,
    net_reward        numeric,
    proof             bytea,
    created_ledger    bigint not null,
    updated_ledger    bigint not null
);

create index if not exists tasks_status_deadline on tasks (status, deadline);
create index if not exists tasks_owner on tasks (owner);

-- Derived: per-keeper aggregates (0221 owns fleshing this out).
create table if not exists keepers (
    keeper          text primary key,
    balance         numeric not null default 0,
    lifetime_earned numeric not null default 0,
    tasks_executed  bigint not null default 0,
    tasks_claimed   bigint not null default 0
);
