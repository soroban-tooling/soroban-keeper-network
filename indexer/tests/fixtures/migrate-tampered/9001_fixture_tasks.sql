-- Same version number as v1's 0001, different content: simulates editing
-- an applied migration, which the checksum record must reject.
create table if not exists fixture_tasks (
    id     bigint primary key,
    status text not null,
    sneaky text
);
