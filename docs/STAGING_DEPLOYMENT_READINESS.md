# Staging deployment readiness (Railway + Vercel)

This is the operational runbook for the first real staging deployment - what to set, what to
check, and what genuinely cannot be known until that deployment exists. It complements
`docs/POSTGRES_MIGRATION.md` (the full build history) and `docs/USERS_AUTH_CUTOVER_RUNBOOK.md`
(the Users/Auth backend-selector switch specifically) rather than replacing either.

**Nothing in this document has been run against a real Railway or Vercel account.** No such
account/project exists for this app yet (confirmed in Step 37's audit). Every claim below is
either a local, code-level fact (verified by this project's own tests) or an explicit statement
that it is unverified - never a guess presented as fact.

## Before provisioning anything

- `KNOWN_ROUTE_GROUPS` must still be `["settings"]` and Users/Auth cutover must still be
  disabled. A staging deployment does not require or imply activating either.
- Preserve every uncommitted change from Steps 27-38 - none of this needs a commit to be staged
  for review; nothing here requires one either.

## Railway (backend)

- `railway.json` (added in Step 38) tells Railway to build with Nixpacks, run `npm start`, and
  health-check `/api/health`. This is a standard, documented Railway schema (verified against
  `railway.json`'s own JSON Schema locally, in `server/tests/railwayConfig.test.js`) - its
  *runtime* behaviour on an actual Railway service is still unverified.
- `/api/health` today only reports MongoDB's connection state (Step 37 finding #6). A Railway
  health check against it will correctly fail if MongoDB is unreachable, but will NOT catch a
  PostgreSQL misconfiguration - PostgreSQL is not yet authoritative for anything, so this is
  consistent with today's architecture, not a bug to fix as part of staging.
- **Required Railway environment variables** (set in Railway's dashboard, never committed):
  - `NODE_ENV=production` - without this, `AUTH_SECRET` and `MONGODB_URI` are NOT required at
    start-up (Step 38's own new safeguard, and the pre-existing `AUTH_SECRET` one, are both
    production-only checks - see "Production safeguards" below) and `COOKIE_SECURE` defaults to
    `false`. Forgetting this one variable silently weakens several other settings at once.
  - `AUTH_SECRET` - a long random value (see `.env.example` for how to generate one). Required in
    production; the app refuses to start without it.
  - `MONGODB_URI` - the real MongoDB connection string. Required in production as of Step 38
    (previously, a missing value silently fell back to `127.0.0.1:27017`, which usually still
    failed to connect on a real host, but with a confusing error message).
  - `PORT` - Railway sets this automatically; the app already reads it from the environment.
  - `TRUST_PROXY` - the correct value depends on Railway's actual edge-proxy hop count. This
    cannot be determined without a real deployment (see
    `docs/POSTGRES_MIGRATION.md`'s own TRUST_PROXY section for how to check it once one exists).
  - `ALLOWED_ORIGINS` - the Vercel frontend's real address, once known, e.g.
    `https://your-app.vercel.app`.
  - `BACKUP_DIR` - see "Backup storage" below. Do not leave this unset on Railway.
  - `DATABASE_URL`, `PG_CUTOVER_ROUTES` - leave both unset for a MongoDB-only staging deployment.
    If `PG_CUTOVER_ROUTES` is ever set, `DATABASE_URL` must be set too - the app now refuses to
    start otherwise (Step 38).
- **PostgreSQL on Railway, if provisioned at all for staging**: `pg_dump`/`pg_restore`
  availability inside Railway's own runtime environment, and the actual privilege level Railway
  grants its managed-database role, remain **unverified** (Step 36's own finding - the restore
  design no longer *needs* superuser, but "doesn't need it" is not the same as "confirmed to have
  what it needs on Railway specifically").

## Vercel (frontend)

- `client/vercel.json`'s `/api/*` rewrite still has the literal placeholder
  `<RAILWAY_BACKEND_URL>` - **this is correct and must stay that way until a real Railway backend
  URL exists.** `server/tests/vercelConfig.test.js` already asserts the destination still looks
  like a placeholder (`<[A-Z0-9_]+>`), specifically so a forgotten placeholder fails a test
  instead of silently deploying something broken.
- When the real Railway URL is known: replace `<RAILWAY_BACKEND_URL>` with it, re-run
  `npm.cmd test` (the placeholder test will now fail until the replacement is a real address, by
  design), and only then deploy to Vercel.
- Do not substitute `localhost`, a guessed Railway hostname, or any other placeholder value -
  only the real, provisioned address.

## Backup storage

- MongoDB's XML backups (`npm run backup` via the Settings page / timer) and PostgreSQL's
  `.dump` + `.manifest.json` pairs (`npm run backup:pg`, Step 35) both write under `BACKUP_DIR`,
  in their own subfolders (PostgreSQL's under `<BACKUP_DIR>/postgres/`).
- **Step 38 finding**: the existing "is this backup folder safe?" warning
  (`describeBackupFolder()`'s `onSystemDrive`) only ever means anything on Windows (the club PC) -
  it is unconditionally `false` on Linux/Railway, by construction, so it can never warn about a
  container's own ephemeral storage. A new, platform-independent signal was added instead:
  `configured` (whether `BACKUP_DIR` was explicitly set at all, regardless of platform) - the
  Settings page now shows a separate warning when it wasn't. This does **not** claim to know
  whether a given `BACKUP_DIR` is actually durable - only whether one was deliberately chosen.
- **Before relying on Railway for backups**: confirm `BACKUP_DIR` points at a Railway **persistent
  volume** (not the service's own ephemeral filesystem, which is wiped on every redeploy) - this
  requires actually provisioning and attaching a volume on Railway, which has not been done (no
  Railway project exists).
- **Disaster recovery - what must be copied off-host, regularly, regardless of which volume
  Railway provides**: a volume survives a redeploy but not necessarily the loss of the whole
  Railway project/account, a billing lapse, or a region-wide incident. Copy off-host:
  - Every `snooker-backup-*.xml` / `snooker-before-restore-*.xml` file in
    `<BACKUP_DIR>` (MongoDB).
  - Every `snooker-postgres-backup-*.dump` **and its matching `.manifest.json`** in
    `<BACKUP_DIR>/postgres/` - the manifest is required to restore with
    `restore-backup:pg`'s own safeguards (Step 35); a `.dump` file without its manifest cannot be
    restored by that script at all.
  - A reasonable cadence matches `backupIntervalHours` (Settings page) for MongoDB; PostgreSQL's
    backup has no automatic timer yet (Step 35 - `backup:pg` is run manually), so an off-host copy
    is only as fresh as the last manual run.

## Production safeguards (Step 38)

Narrowly scoped, backward-compatible - every change below is **production-only**; local/test
behaviour is unchanged (verified: `server/tests/productionSafeguards.test.js`, 10 tests):

- `MONGODB_URI` is now required in production, the same "fail loudly" rule `AUTH_SECRET` already
  used. Development still falls back to the local default silently, exactly as before.
- `PG_CUTOVER_ROUTES` naming a route group without `DATABASE_URL` also set is refused at
  start-up, in every environment (this misconfiguration is unsafe regardless of NODE_ENV, so it
  is not gated on production specifically).
- PostgreSQL connectivity is deliberately **not** checked at start-up, even when `DATABASE_URL`
  is set. PostgreSQL is still not authoritative for anything (Users/Auth and every other route
  remain MongoDB-only); making a real PostgreSQL connection a start-up requirement would turn an
  optional, lazily-connected foundation into a mandatory dependency the current architecture does
  not call for, and would risk the app refusing to start over a database nothing currently reads
  or writes. The one real misconfiguration risk - `PG_CUTOVER_ROUTES` set with no `DATABASE_URL`
  at all - is already caught above without needing a live connection.

## What remains unverified (only a real staging deployment can confirm)

- `railway.json`'s actual build/deploy/health-check behaviour on Railway.
- Whether Railway's managed PostgreSQL (if provisioned) actually has `pg_dump`/`pg_restore`
  available, and what privilege level its own app role gets.
- The correct `TRUST_PROXY` hop count for the real Railway/Vercel path.
- Vercel's actual rewrite/redirect/header behaviour for `client/vercel.json`.
- Whether a Railway persistent volume, once attached, truly survives a redeploy as expected.
- End-to-end login and API requests through the real Vercel → Railway path.

## Recommended next step

Provisioning a real Railway + Vercel **staging** project (not production, no real club data) is
the smallest safe next step that can resolve the "unverified" list above - it requires no
Users/Auth cutover decision and no production data. It should be its own explicitly approved
step, separate from this one, since it is the first step in this entire migration that actually
touches infrastructure outside this repository.
