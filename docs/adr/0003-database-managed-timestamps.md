# Database-managed creation and update timestamps

Every application-owned table must have `created_at` and `updated_at` as non-null PostgreSQL `timestamptz` columns. This includes inventory, orders, allocations, submissions, and enum lookup tables. PostgreSQL system catalogs and tooling-owned tables such as Prisma migration history are outside the application schema policy.

Follow the timestamp pattern in ed-creative-fusion: both columns use `NOT NULL DEFAULT NOW()`, and one shared `update_timestamp()` function sets `NEW.updated_at = NOW()` through a per-table `BEFORE UPDATE FOR EACH ROW` trigger named `update_<table>_updated_at`. This covers Prisma and raw SQL updates, including no-op updates, without relying on Prisma `@updatedAt`.

Defaults initialize omitted insert timestamps; explicit insert values are permitted. The update trigger overrides supplied `updated_at` but does not modify or prevent explicit changes to `created_at`. Application update paths must leave `created_at` unchanged. This matches the source pattern rather than adding database-enforced creation-time immutability.

Use `NOW()` to capture the transaction start time. Database-generated timestamps on inserts and updates within the same transaction share that value; repeated updates within that transaction do not advance `updated_at`. Timestamps are not commit timestamps, concurrency tokens, or a guaranteed strictly increasing sequence. Updates rolled back by a transaction also roll back timestamp changes. Reading or replaying a submission result must not issue an unnecessary UPDATE just to touch its timestamp.

This centralizes the behavior for Prisma, raw SQL, seeds, and other writers. Migration authors must maintain trigger coverage. Adding the policy to existing tables requires an explicit backfill before enforcing NOT NULL; unknown historical creation times must not be presented as measured history.

This decision supersedes the earlier strict Hasura enum-table column restriction. Lookup tables retain text primary keys, optional descriptions, and foreign-key references, but also receive both timestamps. This is the lookup-table pattern rather than a promise of compatibility with Hasura's strict enum-table shape. Hasura itself remains outside the stack.

## Example SQL

The following is an illustrative migration, not an applied migration or the final warehouse schema. Use the actual application schema consistently when implementing it.

```sql
CREATE OR REPLACE FUNCTION public.update_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE public.example_warehouse (
    id uuid PRIMARY KEY, -- Caller supplies a UUIDv7.
    name text NOT NULL,
    stock integer NOT NULL CHECK (stock >= 0),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_example_warehouse_updated_at
ON public.example_warehouse;
CREATE TRIGGER update_example_warehouse_updated_at
BEFORE UPDATE ON public.example_warehouse
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Illustrative text-key lookup table: timestamps are required here too.
CREATE TABLE public.example_submission_outcome (
    value text PRIMARY KEY,
    description text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_example_submission_outcome_updated_at
ON public.example_submission_outcome;
CREATE TRIGGER update_example_submission_outcome_updated_at
BEFORE UPDATE ON public.example_submission_outcome
FOR EACH ROW
EXECUTE FUNCTION public.update_timestamp();

-- Database generates equal creation/update timestamps on insert.
INSERT INTO public.example_warehouse (id, name, stock)
VALUES ('01995d88-0000-7000-8000-000000000001', 'Example warehouse', 10)
RETURNING id, created_at, updated_at;

-- Creation time stays unchanged; update time comes from PostgreSQL.
UPDATE public.example_warehouse
SET stock = stock - 1
WHERE id = '01995d88-0000-7000-8000-000000000001'
RETURNING id, stock, created_at, updated_at;
```

Prisma fields may use camelCase mapped to `created_at` and `updated_at`; represent both as `DateTime` with the matching `Timestamptz` native type and database defaults. Install the trigger function and per-table triggers in SQL migrations. Use CREATE OR REPLACE for the function and DROP TRIGGER IF EXISTS before recreating each trigger, matching the source installation pattern. Table creation itself is not made idempotent by this example. When removing one table trigger, retain the shared function while other tables still depend on it. Integration tests must build the schema through these migrations so their trigger behavior matches deployed databases. Use the database-returned values rather than predicting timestamps in application code.

## Verification required during schema implementation

- Check every application-owned table for both non-null timestamp columns and the enabled trigger.
- Insert through Prisma and raw SQL without supplying timestamps; verify both fields are populated and equal.
- Update through Prisma and raw SQL; verify ordinary updates leave creation time unchanged and update time is database-generated even when a caller supplies a different updated_at. Do not claim the trigger prevents explicit created_at edits.
- Exercise a no-op update, multiple statements within one transaction, and rollback. Assert that writes within the same transaction share its start timestamp; do not require updated_at to increase for each statement.
- Include a text-key lookup table in the checks and confirm read-only verification/replay does not touch timestamps.

References: [PostgreSQL date/time semantics](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) and [trigger functions](https://www.postgresql.org/docs/current/plpgsql-trigger.html).

## Source pattern

Adapted from ed-creative-fusion at commit `0c34da8a4c82c1e6d4f58d499d7abf1862eb6f20`:

- [TimestampMixin defaults](https://github.com/amity-arac/ed-creative-fusion/blob/0c34da8a4c82c1e6d4f58d499d7abf1862eb6f20/libs/ai-core/ai_core/core/db/base.py)
- [Shared function and per-table trigger installation](https://github.com/amity-arac/ed-creative-fusion/blob/0c34da8a4c82c1e6d4f58d499d7abf1862eb6f20/libs/ai-core/ai_core/core/db/triggers.py)
- [Raw SQL update behavior test](https://github.com/amity-arac/ed-creative-fusion/blob/0c34da8a4c82c1e6d4f58d499d7abf1862eb6f20/libs/ai-core/tests/models/test_timestamp_trigger_behavior.py)

Only the timestamp pattern is adopted. SCOS keeps Prisma SQL migrations and UUIDv7; SQLAlchemy/Alembic hooks and the source's UUIDv4 choice are not copied.
