# Users/Auth cutover: operational re-login runbook

This document explains what happens to logged-in users when the Users/Auth backend selector is
switched between MongoDB and PostgreSQL, and the checks to run around that switch. It is an
**operational runbook**, not a cutover plan: switching the selector for real traffic still needs
its own, separately approved step (see "Before you switch" below) - this document does not
authorize that switch by itself.

As of this writing, `server/config/cutover.js`'s `KNOWN_ROUTE_GROUPS` does **not** include
`"users"` - the switch described here cannot happen by accident, and nothing in this document
changes that.

## Why switching backends logs everyone out

Login sessions are stored entirely on one backend at a time:

- MongoDB-authoritative sessions live in the `authsessions` collection (`server/models/AuthSession.js`).
- PostgreSQL-authoritative sessions live in the `app.auth_sessions` table (`server/services/authSessions.pg.service.js`).

These are two separate stores. `server/services/authCutover.service.js`'s `resolveSession()`
asks **exactly one** of them, based on the selector - never both, never a fallback from one to
the other. A session created while MongoDB was authoritative does not exist in PostgreSQL's
table, and vice versa (verified directly: `server/tests/postgresUsersAuthHttp.test.js`, scenario
8, logs in on one backend and shows the same cookie is refused - not silently accepted - under
the other).

**The browser's `scp_session` cookie does not change when the selector flips.** The browser keeps
sending the same cookie value it already had. After a switch, that cookie simply no longer
resolves to anything under the newly-selected backend - the same as any other invalid or expired
token. The user sees a normal "please log in" (401 → redirect to the login page), not an error.
**Nobody needs to clear cookies by hand** - logging in again replaces it with a cookie the new
backend recognizes.

This applies to **every** currently logged-in user, every time the selector changes - including
switching back. There is no way to carry a session across the switch; this is fail-closed by
design (confirmed in Steps 33-34's audits: neither direction ever accepts the other backend's
session).

## Recommended communication and maintenance-window checklist

Before switching, for real traffic:

1. Pick a low-activity time window (e.g. outside club hours).
2. Tell everyone who might be logged in (front desk, admin) that they will need to log in again
   right after the switch - a one-line heads-up avoids confused support questions.
3. Confirm nobody is mid-way through an unsaved action that depends on staying logged in (the
   app itself has no unsaved-draft state that a forced logout would lose, but check for anything
   project-specific before relying on that).
4. Make the switch (set `PG_CUTOVER_ROUTES` to include `users`, once `"users"` has actually been
   added to `KNOWN_ROUTE_GROUPS` by a separately approved step - **not yet done**, see "Before
   you switch").
5. Immediately verify (see "Verifying after a switch" below) before telling anyone the switch is
   complete.

## Pre-switch backup and readiness checks

Follow the project's existing backup procedure before any backend switch:

- Take a MongoDB backup through the app's own backup feature (the "Backup Now" action on the
  Settings page, permission `backups:manage`; see `server/services/backup.service.js` and
  `docs/ARCHITECTURE.md`) before switching, the same as before any other data-affecting change.
- Take a **PostgreSQL** backup with `npm run backup:pg` (Step 35 - see "PostgreSQL backup
  approach" below) - this is a separate command, writing a separate file, from the MongoDB
  backup above. Do both; neither replaces the other.
- Confirm the PostgreSQL side has the data and admin account you expect, using the read-only
  checks in `server/services/users.pg.service.js` (e.g. `listActiveAdmins`) via a script or the
  admin CLI - never by editing rows directly.
- Confirm at least one active PostgreSQL administrator exists and can log in (see "Admin
  recovery readiness" below) **before** switching - if nobody can get into PostgreSQL after the
  switch, there is no "fix it from the Users page" option, because the Users page itself needs a
  working login first.

## PostgreSQL backup approach (Step 35)

`npm run backup:pg` (`server/scripts/backupPostgres.js`) makes a PostgreSQL backup using
`pg_dump`'s own "custom" archive format - not a hand-written serializer (unlike the MongoDB
backup, which has no equivalent official single-database dump tool to reuse). It:

- Dumps the whole database (not scoped to one schema - a schema-scoped dump was tried while
  building this and confirmed to drop the `btree_gist` extension, silently breaking
  `app.bookings`'s overlap-prevention constraint on restore; a full-database dump avoids this,
  confirmed directly).
- Excludes session data (`app.auth_sessions`) and migration bookkeeping
  (`app.schema_migrations`) from the data dumped - the same "sessions are nobody's data" policy
  the MongoDB backup already follows.
- Writes `snooker-postgres-backup-<timestamp>.dump` plus a sibling `.manifest.json` (per-table
  row counts at backup time) into `<BACKUP_DIR>/postgres/` - the same `BACKUP_DIR` the MongoDB
  backup already uses, in its own subfolder.
- Verifies the archive with `pg_restore --list` (reads the archive's table of contents without
  touching any database) before the file is considered a real backup - a half-made or corrupt
  backup is deleted, never left looking complete.
- Needs `pg_dump`/`pg_restore` on `PATH`, or `PG_DUMP_PATH`/`PG_RESTORE_PATH` set to their full
  paths. **Whether these tools are available in this project's eventual Railway deployment is
  UNVERIFIED** - no Railway project exists yet for this app (`docs/POSTGRES_MIGRATION.md`).
  Confirmed working against a real **local** PostgreSQL 18.6 install only.

### How to verify a backup

`backup:pg`'s own `pg_restore --list` check (above) is the first verification, run automatically,
before the file is kept. Beyond that:

- Check the printed row counts against what you expect (the Users page's own numbers, etc.).
- The `.manifest.json` file next to the `.dump` is plain, readable JSON - open it to see exactly
  what was backed up, table by table, without needing any PostgreSQL tool.
- The real proof is a successful **restore rehearsal** (next section) - a backup that was never
  test-restored is unverified, no matter how clean its own self-check looked.

### Isolated restore rehearsal

`npm run restore-backup:pg -- --file="<path>" --target="<connection string>"`
(`server/scripts/restorePostgresBackup.js`) restores a backup made by `backup:pg`. There is
**no default `--target`** - it must be given explicitly, every time, so this can never silently
land on whatever database the app itself is configured to use.

**Always rehearse against an isolated, throwaway database first** - never the first time against
anything that matters. A database's name being "test" or "dev" is not treated as proof it is
safe to overwrite (the same reasoning Step 32's admin-CLI safety review already rejected for the
same kind of shortcut) - the only real safeguards are the confirmation prompts themselves:

1. Typing `RESTORE` is always required.
2. If the target already has PostgreSQL user accounts, a SECOND, differently-worded confirmation
   (`OVERWRITE EXISTING DATA`, typed exactly) is also required - this is deliberately a different
   phrase from the first, so it can't be satisfied by habit or a stray keypress.
3. The restore procedure: run the project's own migrations against the target (creates the
   schema/extension/tables if missing - harmless if they already exist), truncate existing data
   only if the operator confirmed that, then `pg_restore --data-only` to load the backup's rows,
   then always clear `app.auth_sessions` (every session ends, on every restore, no exceptions).
4. After restoring, every table's row count is compared against the backup's own manifest. A
   mismatch is reported as a failure even if `pg_restore` itself exited 0 - an exit code alone is
   never treated as proof the data is actually there.

`server/tests/postgresBackupRestore.test.js` (Step 35) exercises this whole sequence - a real
backup, a real restore into a real throwaway recovery database, a cancelled attempt, an
overwrite-confirmed attempt, three consecutive restores against the same target (checking the
migration-tracking table itself is never disturbed by this process) - against a real, isolated
local PostgreSQL. It has never been run against anything resembling production.

### Known limitations and operator responsibilities

- **Locally tested, not production-tested.** Every claim above was verified against a real local
  PostgreSQL 18.6 install (the same one `docs/POSTGRES_MIGRATION.md`'s Phase 2 steps set up).
  Nothing here has been run against Railway (no Railway project exists yet), so whether
  `pg_dump`/`pg_restore` are installable there remains **unverified in production**.
- **Step 36 update**: the restore no longer needs `--disable-triggers` (which needs table-owner
  or superuser rights). Migration `0002_deferrable_foreign_keys.sql` makes every foreign key in
  schema "app" `DEFERRABLE INITIALLY DEFERRED` (integrity is still fully enforced, just checked
  at transaction commit instead of per row), and the restore now runs as one
  `pg_restore --data-only --single-transaction`. This was found necessary, not just safer:
  `pg_restore`'s own data order is NOT dependency-aware by default, and this schema has two
  foreign-key pairs that are genuinely circular at the data level
  (`app.bookings`/`app.sessions`, `app.bills`/`app.matches`) - confirmed directly, and confirmed
  fixed, against a real non-superuser role that owns its own schema (the realistic shape of a
  managed-database app role), including both circular pairs and a real mid-restore failure
  (which rolled back atomically, leaving the target exactly as it was before the attempt). This
  is a materially smaller gap than needing superuser, but whatever role a real managed provider
  eventually grants still has not been tried - that remains open until an actual environment
  exists.
- The operator is responsible for actually running `backup:pg` before a switch (it is not on an
  automatic timer, unlike the MongoDB backup) and for storing the resulting files somewhere that
  survives a broken machine, the same reasoning `describeBackupFolder()`'s own "is this on the
  system drive" check already applies to MongoDB's backups.
- A backup made before `btree_gist` was confirmed available on a given PostgreSQL server will
  restore its data, but the overlap-prevention constraint on `app.bookings` depends on that
  extension being installable on the restore target too.

## Admin recovery readiness

- `npm run create-admin:pg` creates the first PostgreSQL admin (refuses if one already exists).
- `npm run reset-admin-password:pg` resets an existing active PostgreSQL admin's password and
  ends all of their sessions (Step 32).
- Both are PostgreSQL-only: they never touch MongoDB, and running them never changes the
  selector or affects MongoDB-authoritative traffic.
- Rehearse both commands against a non-production PostgreSQL database before relying on them
  against the real one, the same way you would test the existing MongoDB `npm run create-admin` /
  `npm run reset-admin-password` commands.

## Verifying after a switch

After switching, before telling anyone the maintenance window is over:

1. Log in as a known-good PostgreSQL administrator through the real login page.
2. Confirm the Users page loads and lists the expected accounts.
3. Confirm a non-admin role is correctly refused the Users page (if one is available to test
   with).
4. Log out and confirm the session is really gone (logging back in should ask for the password
   again, not silently resume).

`server/tests/postgresUsersAuthHttp.test.js` exercises exactly this sequence (admin login,
protected route, role restriction, logout, re-use-after-logout) against a real, isolated test
database - it is the kind of check this step reproduces against the real environment, not a
replacement for doing so there too.

## Recognizing a failed switch, and rollback

Signs the switch did not go well:

- Nobody (including a previously-active admin) can log in at all → check the PostgreSQL
  connection (`DATABASE_URL`) is correct and reachable, and that an active PostgreSQL admin
  actually exists (`listActiveAdmins`-style check).
- Users/roles behave differently than expected (wrong permissions, missing accounts) → the
  PostgreSQL data may not match what you expected; do not attempt to fix this by editing rows
  directly - stop and investigate using the service layer's own read functions first.

**Rollback** is: set the selector back to MongoDB (remove `users` from `PG_CUTOVER_ROUTES`, or
revert whatever change added it). This is not automated and is not a separate, pre-built
"rollback button" - it is the same kind of deliberate, separately approved change as the forward
switch itself. **Rolling back also logs everyone out again**, for the exact same reason the
forward switch did: PostgreSQL-authoritative sessions created during the attempted switch do not
exist in MongoDB's session store, so the same "please log in again" applies, in the other
direction.

## Before you switch

As of Steps 27-35:

- `"users"` is **not** in `KNOWN_ROUTE_GROUPS` - the switch described in this document is not
  possible yet, by design.
- A real HTTP end-to-end test for PostgreSQL-backed login now exists
  (`server/tests/postgresUsersAuthHttp.test.js`, added in Step 34) and passes against a real,
  isolated PostgreSQL test database.
- A PostgreSQL backup and restore procedure now exists (`npm run backup:pg` /
  `npm run restore-backup:pg`, Step 35) and has been tested, repeatedly, against a real local
  PostgreSQL - see "PostgreSQL backup approach" above. It has **not** been run against Railway or
  any production-like environment - that remains unverified, and is a real open item, not
  something this document can close on its own.
- Adding `"users"` to `KNOWN_ROUTE_GROUPS`, and any production switch, requires its own,
  separately approved cutover-activation step. This runbook describes what to do *around* that
  step once it is approved - it is not that approval, and does not substitute for it. Do not
  activate the selector until both the HTTP tests above and a real (not just locally-rehearsed)
  PostgreSQL restore have been verified for the actual target environment.
