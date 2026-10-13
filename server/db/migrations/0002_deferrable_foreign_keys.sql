-- Step 36: PostgreSQL restore-compatibility fix.
--
-- Found while auditing whether a restricted (non-superuser) managed-database role can safely
-- restore this schema's data: pg_restore's own default TABLE DATA order is NOT dependency-aware
-- (confirmed directly against a real archive - it is close to alphabetical by table name, not
-- sorted by foreign-key dependency), and this schema also has two foreign-key pairs that are
-- genuinely circular at the DATA level:
--   - app.bookings.session_id <-> app.sessions.booking_id (a session started from a booking
--     references that booking; the booking is then updated to reference the session back)
--   - app.bills.match_id <-> app.matches.bill_id (the same pattern once a match is billed)
-- Neither a plain data-only restore nor one ordered strictly by dependency can satisfy a
-- circular pair's constraints row by row - at least one side's row must exist before its own
-- foreign key can be checked, which is exactly what "circular" means here.
--
-- pg_restore's own built-in fix for this, `--disable-triggers`, needs the restoring role to own
-- the table (or be a superuser) - confirmed directly: it works for a role that owns its own
-- schema (the normal shape of a self-provisioned managed-database app role), but there is no way
-- to verify every managed PostgreSQL provider's own app role will have that privilege without an
-- actual account there (this project has none yet - see docs/POSTGRES_MIGRATION.md).
--
-- The standard, privilege-free alternative used instead: make every foreign key in this schema
-- DEFERRABLE INITIALLY DEFERRED. This does NOT weaken referential integrity - every constraint
-- is still enforced, just at transaction COMMIT instead of immediately after each row - and
-- `ALTER TABLE ... ALTER CONSTRAINT` needs only ordinary table ownership (confirmed directly
-- against a non-superuser role that owns its own schema). Combined with
-- server/scripts/restorePostgresBackup.js's own `pg_restore --data-only --single-transaction`,
-- every table's data can load in ANY order - including both circular pairs above - without ever
-- disabling a trigger or a foreign key check, and without needing superuser rights.
--
-- This changes no application behaviour: ordinary single-row inserts/updates (every real write
-- this app makes) still fail immediately on a genuine foreign-key violation inside their own
-- transaction, the same as before - "deferred" only matters when a transaction temporarily holds
-- more than one row whose constraints only become satisfied once every row in it has landed,
-- which restores are the only place in this codebase that does.

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'app'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', constraint_record.table_name, constraint_record.conname);
  END LOOP;
END $$;
