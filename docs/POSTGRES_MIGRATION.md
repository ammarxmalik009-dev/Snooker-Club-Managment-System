# PostgreSQL Migration & Online Deployment

Goal: move Snooker Club Pro from MongoDB (Mongoose) to PostgreSQL, host the backend API on
**Railway** and the frontend (`client/`) on **Vercel** — without changing the app's behaviour,
API contract (JSON shapes, string IDs, status codes, error messages) or business rules.

This file is the plan **and** the progress log. Update the checklist after every step.

## Ground rules

- `main` keeps the working MongoDB app until the PostgreSQL version is fully tested.
  Phases 2–4 happen on a separate `postgres` branch.
- Never delete, overwrite or "migrate in place" the club's real database or backups.
- Never commit `.env`, passwords, connection strings or `AUTH_SECRET`.
- Never weaken login, roles, the origin check, validation or security headers to make deployment work.
- Never remove or skip a failing test; never claim a step is done without real test output.
- Small commits, one logical change each.

## Baseline (before any Phase 1 change)

Recorded on 2026-10-11 at commit `a0ce843` (`main`), MongoDB via `npm run db`:

| Suite | Command | Result |
|---|---|---|
| Server tests (25 files) | `npm.cmd test` | **265 passed, 0 failed** |
| Browser suites (14) | `npm.cmd run test:browser` | **741 passed, 0 failed** |

These numbers are the floor: later runs must not have fewer tests or any failures.

## Target architecture

```
Browser ──► https://<app>.vercel.app            (static files from client/)
              │  /api/*  rewrite (server-side, same origin for the browser)
              ▼
            https://<api>.up.railway.app/api/*   (Express, NODE_ENV=production)
              │
              ▼
            Railway PostgreSQL (DATABASE_URL)    + volume /data/backups (BACKUP_DIR)
```

Because Vercel **rewrites** `/api/*` to Railway, the browser only ever talks to the Vercel
domain: the login cookie stays first-party, `SameSite=Strict` keeps working and no CORS is needed.
The Express server then sees `Origin: https://<app>.vercel.app` with `Host: <api>.up.railway.app`,
so the origin check must accept an explicit allow-list (`ALLOWED_ORIGINS`) — never "any origin".

## Phases

### Phase 1 — Deployment readiness (on `main`, MongoDB untouched)

| # | Step | Files |
|---|---|---|
| 1.1 | This document + baseline results | `docs/POSTGRES_MIGRATION.md` |
| 1.2 | `TRUST_PROXY` setting → `app.set("trust proxy", …)`, so `req.ip` (login throttle) is the real client IP behind Railway/Vercel | `server/config/env.js`, `server/app.js`, tests |
| 1.3 | `ALLOWED_ORIGINS`: the origin check accepts the same host **or** an exact allow-listed origin; everything else stays 403 | `server/config/env.js`, `server/middleware/auth.js`, tests |
| 1.4 | Vendored Chart.js: a committed copy in `client/vendor/`, so Vercel can serve it (no `node_modules` there) | `client/vendor/` (file, licenses, README), `server/app.js`, `.gitattributes`, tests |
| 1.5 | Client-side page-role guard (user experience only — the API's `requirePermission` stays the real protection) | `client/js/core/layout.js`, tests |
| 1.6 | `client/vercel.json` (API rewrite with a placeholder Railway URL, `/` → dashboard, security headers) + `client/404.html` | `client/vercel.json`, `client/404.html`, tests |
| 1.7 | Docs + `.env.example`; full server + browser test runs | `README.md`, `docs/ARCHITECTURE.md`, `.env.example` |

#### 1.2 `TRUST_PROXY` — done

- `server/config/env.js` → `readTrustProxy()` checks the value at start-up:
  - empty, `false` or `0` → `false` (**default**, the club PC: `X-Forwarded-For` is ignored)
  - `1`–`5` → that many proxies in front of the app
  - comma list of `loopback` / `linklocal` / `uniquelocal` / IP / IP/prefix → only those proxies are trusted
  - `true` and anything else → the server refuses to start with a clear message. `true` would take the
    left-most `X-Forwarded-For` entry, which any visitor can type in themselves.
- `server/app.js` → `app.set("trust proxy", env.trustProxy)`. `createApp({ trustProxy })` accepts an override
  for tests only. Nothing else changed: login, cookies, the throttle limits and MongoDB are untouched.
- `server/tests/trustProxy.test.js` (7 tests, own database `snooker_club_pro_test_proxy`):
  - the accepted and refused values
  - off: `req.ip` is the direct connection, and a faked `X-Forwarded-For` can't dodge the IP lock
  - on (1): `req.ip` is the address the proxy appended, not one the visitor typed in
  - on: one visitor's failures lock only that visitor; the username lock still works from any IP

**Production value (to verify in Phase 5, not guessed now):**

| How the request arrives | Expected `TRUST_PROXY` |
|---|---|
| Browser → Railway domain directly | `1` (Railway's edge proxy) |
| Browser → Vercel → (rewrite) → Railway | `2` (Vercel + Railway's edge proxy) |

How to verify after deploying:
1. Log in through the Vercel URL. Look up your own public IP (any "what is my IP" site).
2. Check the `ip` stored with your newest login session (Mongo: `authsessions`; PostgreSQL: the auth
   sessions table). It must equal your public IP.
3. If it shows a Vercel/Railway address → the number is too low (everyone shares one lock).
   Send a login with a fake header (`curl -H "X-Forwarded-For: 1.2.3.4" …`): if `1.2.3.4` is stored,
   the number is too high (visitors can fake their IP). Adjust and repeat until step 2 is right.

Test results after 1.2: `npm.cmd test` **272 passed, 0 failed** (265 + 7 new);
`npm.cmd run test:browser` **741 passed, 0 failed** (14 suites).

#### 1.3 `ALLOWED_ORIGINS` — done

- `server/config/env.js` → `readAllowedOrigins()`: a comma list of exact `http(s)://host[:port]` addresses.
  Empty (default) = `[]`, nothing extra allowed (the club PC behaves exactly as before). A wildcard (`*`),
  a path, query, `#`, user/password, another scheme or an empty entry stops the start-up with a clear message.
  Values are stored the way browsers send `Origin` (lower case, default port dropped; one trailing `/` is accepted).
- `server/app.js` → `app.set("allowed origins", …)` from the checked setting (`createApp({ allowedOrigins })` only for tests).
- `server/middleware/auth.js` → `sameOriginOnly` (still on every `/api` route after `/health`, before login).

**The policy (POST / PUT / PATCH / DELETE; GET, HEAD and OPTIONS change nothing and pass):**

| Request | Result |
|---|---|
| `Origin` host equals the `Host` header (the app's own pages, unchanged) | allowed |
| `Origin` is exactly one of `ALLOWED_ORIGINS` (pages on Vercel through the rewrite) | allowed |
| any other `Origin`: another site, look-alike domain, other Vercel app, `http` instead of `https`, other port, upper case, with a path | **403** "Requests from other websites are not allowed." |
| `Origin` is `null`, not a URL, or not `http(s)` (`file:`, `ftp:`, `chrome-extension:`) | **403** |
| no `Origin`, and `Sec-Fetch-Site` is `cross-site` or `same-site` (a browser says another site sent it) | **403** |
| no `Origin`, and `Sec-Fetch-Site` is missing, `same-origin` or `none` (scripts, tests, old browsers) | allowed |

Why a missing `Origin` is not simply trusted or simply refused: current browsers always send `Origin` on
these requests, so its absence means a non-browser client. Such a client has no visitor's login cookie
(that is what a cross-site attack needs), and the `SameSite=Strict` cookie is a second layer. Refusing it would
break server-side scripts and tests. The `Sec-Fetch-Site` check catches a browser that leaves `Origin` out.
`X-Forwarded-Host` is never used for this check (a client could fake it); an allowed origin is never a login —
`requireAuth` and the role checks still run afterwards.

**Configuration (placeholders):**

```
# Railway (backend) - the Vercel address the pages are served from
ALLOWED_ORIGINS=https://<your-app>.vercel.app
# more than one (e.g. a custom domain later)
ALLOWED_ORIGINS=https://<your-app>.vercel.app,https://<club-domain>
# club PC: leave empty
ALLOWED_ORIGINS=
```

**Not verified yet (needs the live deployment, Phase 5):** the tests *simulate* the rewrite
(`Host: <api>.up.railway.app`, `Origin: https://<app>.vercel.app`). That Vercel's external rewrite forwards
the browser's `Origin` unchanged and sends the Railway address as `Host` is an assumption, not something the
code can prove. It works in every likely case: Host = Railway → allowed by `ALLOWED_ORIGINS`; Host = Vercel →
allowed as same host; `Origin` removed → allowed by the missing-Origin rule (`Sec-Fetch-Site: same-origin`).
It would only fail if Vercel *replaced* `Origin` with another value. Phase 5 check: log in and save a change
through the Vercel URL; then `curl -X POST -H "Origin: https://evil.example" https://<app>.vercel.app/api/auth/logout`
must return 403.

Tests: `server/tests/allowedOrigins.test.js` (11 tests, own database `snooker_club_pro_test_origins`):
setting values; club PC same-host allowed and other sites refused; rewrite allowed only for the exact origin;
faked `X-Forwarded-Host`; malformed and missing `Origin` with `Sec-Fetch-Site`; no cookie → 401 and wrong role → 403
even from an allowed origin; refused-origin logins never count towards the login lock, and the lock still works.
The existing test `requests from another website can't change anything` (`auth.test.js`) passes unchanged.
Shared helper `server/tests/helpers/envSetting.js` (also used by `trustProxy.test.js` now).

Test results after 1.3: `npm.cmd test` **283 passed, 0 failed** (272 + 11 new);
`npm.cmd run test:browser` **741 passed, 0 failed** (14 suites).

#### 1.4 Vendored Chart.js — done

- **Version:** Chart.js **4.5.1** (installed in `node_modules` and pinned in `package-lock.json`; nothing
  downloaded or upgraded). The UMD file bundles `@kurkle/color` 0.3.2 (its notice is inside the file).
- **Asset:** `client/vendor/chart.umd.min.js` — a byte-for-byte copy of `node_modules/chart.js/dist/chart.umd.min.js`
  (208,522 bytes, SHA-256 `48444A82…C9F54A`). The page already loaded `/vendor/chart.umd.min.js`, so
  `client/pages/reports.html` and the chart code are **unchanged**; the path now works both locally
  (Express static) and on Vercel (`client/` is the site root).
- **License:** the copyright header at the top of the file is kept as published; `client/vendor/chart.js.LICENSE.md`
  and `client/vendor/kurkle-color.LICENSE.md` are the packages' own MIT license files. `client/vendor/README.md`
  says where the files came from and how to update them.
- `server/app.js`: the special route that sent the file from `node_modules` is removed; `express.static(client/)` serves it.
- `.gitattributes`: `client/vendor/** -text`, so Git (here `core.autocrlf=true`) never changes the files' line endings.
- `chart.js` stays in `package.json` as the source of the copy; `npm test` fails if the copy and the package differ.
- `docs/ARCHITECTURE.md`: the two lines that said "served from node_modules" are corrected.

Tests: `server/tests/vendor.test.js` (4 tests, no database): same version as `package-lock.json` and same bytes
as the package, header and `@kurkle/color` notice kept; both license files match the packages; every local
`<script src>` / `<link href>` on every page is a file under `client/` and Chart.js is loaded once, only on
`reports.html`; Express serves the file from `client/vendor` as JavaScript. The existing `app.test.js` check of
`/vendor/chart.umd.min.js` and the browser check "revenue chart: drawn with Chart.js" (reports suite) pass
unchanged. **Not verified on Vercel yet** (Phase 5): the path is only checked against the `client/` files.

Test results after 1.4: `npm.cmd test` **287 passed, 0 failed** (283 + 4 new);
`npm.cmd run test:browser` **741 passed, 0 failed** (14 suites).

### Phase 2 — PostgreSQL foundation (branch `postgres`)

- `pg` pool from `DATABASE_URL`, query + transaction helpers, row mappers that keep today's JSON (UUIDs as strings).
- Numbered SQL migrations with a `schema_migrations` table; tables, foreign keys, indexes, unique and check constraints.
- Check Railway's PostgreSQL version and extensions (e.g. `btree_gist` for booking overlap) **before** relying on them; otherwise use a tested alternative (row locks inside a transaction).
- Local PostgreSQL on Windows (portable, like `npm run db` today) and throw-away test databases whose name must contain `test` (same safety rule as `server/tests/helpers/testDb.js`).
- Mongoose stays installed.

### Phase 3 — Port services, one at a time (tests after each)

Order: settings → users/auth → tables → customers → categories/products/stock → players → sessions →
café orders → bookings → matches → bills/payments → player history → dashboard → reports → backup/restore.

Parameterised SQL only. Real transactions for money, stock and sessions. Special care:
concurrent payments (no overpaying), booking overlaps, one active session per table, stock
deduct/restore, duplicate bills, match/bill numbers, last-admin protection, report day edges in
`Asia/Karachi`, foreign keys during restore.

### Phase 4 — Tests and data import

- Port server and browser tests to PostgreSQL; add concurrency, rollback and constraint tests.
- `importMongoBackup.js`: read the existing XML backup, map ObjectIds → deterministic UUIDs, keep all
  references (embedded players, bill lines, actor fields), import in one transaction, then compare
  counts and sample bills, payments, player histories, reports, settings and stock.
- Try it on a separate local PostgreSQL database first. The MongoDB database is only read.
- Remove Mongoose only after all of the above passes.

### Phase 5 — Deploy

- **Railway:** PostgreSQL service; Node service from GitHub; start command runs migrations, then the server;
  env vars `DATABASE_URL`, `NODE_ENV=production`, `AUTH_SECRET`, `COOKIE_SECURE=true`, `TRUST_PROXY`,
  `ALLOWED_ORIGINS`, `CLUB_TIMEZONE=Asia/Karachi`, `BACKUP_DIR=/data/backups` (volume); health check
  `/api/health`; **one replica** (the no-show and backup timers in `server/server.js` run in every replica).
- **Vercel:** root directory `client/`, no build step, real Railway URL in `client/vercel.json`.
- Verify live: login through the Vercel domain, secure cookie, origin check, real client IP in the
  login throttle, roles and page access, full workflow, backups survive a redeploy.

## Environment variables (new or changed)

| Name | Phase | Example (placeholders only) | Meaning |
|---|---|---|---|
| `TRUST_PROXY` | 1 | `2` | how many proxies sit in front of the app (empty/`false` = none, the club-PC default; `true` is refused) |
| `ALLOWED_ORIGINS` | 1 | `https://<app>.vercel.app` | extra origins allowed to send changes (comma-separated, exact match, no wildcard; empty on the club PC) |
| `DATABASE_URL` | 2 | *(set in Railway / `.env`, never in Git)* | PostgreSQL connection string |

## Known risks

- Which header carries the real client IP through Vercel → Railway, and how many hops to trust, must be
  checked on the live deployment (Phase 5). A wrong value either locks everyone out together (all share
  the proxy IP) or lets a client fake its IP. `TRUST_PROXY` is therefore configurable, not hard-coded.
- Pages on Vercel are plain static files: the server's `pageGuard` does not run there. Data stays
  protected because every `/api` route checks the login and role on the server.
- Railway volumes: confirm the plan supports a persistent volume for `/data/backups`.

## Progress checklist

- [x] Inspection of repo, tests, backups (2026-10-11)
- [x] Baseline tests recorded (265 server / 741 browser)
- [x] 1.1 Migration document
- [x] 1.2 `TRUST_PROXY` (272 server / 741 browser)
- [x] 1.3 `ALLOWED_ORIGINS` origin check (283 server / 741 browser; live rewrite check pending Phase 5)
- [x] 1.4 Vendored Chart.js 4.5.1 (287 server / 741 browser; Vercel load check pending Phase 5)
- [ ] 1.5 Client-side page-role guard
- [ ] 1.6 `client/vercel.json` + `client/404.html`
- [ ] 1.7 Docs + full test runs
- [ ] Phase 2 — PostgreSQL foundation
- [ ] Phase 3 — Services ported
- [ ] Phase 4 — Tests + Mongo import verified
- [ ] Phase 5 — Live on Railway + Vercel, verified
