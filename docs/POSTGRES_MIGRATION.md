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
| 1.5 | Client-side page-role guard (user experience only — the API's `requirePermission` stays the real protection) | `server/{routes,controllers,validators}/auth.*`, `client/js/core/layout.js`, `client/css/layout.css`, `tests/browser/{server.js,run.js}`, tests |
| 1.6 | `client/vercel.json` (API rewrite with a placeholder Railway URL, `/` → dashboard, security headers) + `client/404.html` | `client/vercel.json`, `client/404.html`, `server/tests/vercelConfig.test.js` |
| 1.7 | Docs + `.env.example`; full server + browser test runs | `README.md`, `.env.example`, `docs/POSTGRES_MIGRATION.md` |

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

#### 1.5 Client-side page-role guard — done

**Problem:** the server's `pageGuard` (`server/middleware/auth.js`) refuses a restricted page before
sending it (login page if logged out; `/pages/dashboard.html?denied=1` if the role lacks the page's
permission). On Vercel the pages are plain static files, so `pageGuard` never runs there - anyone
could fetch a restricted page's HTML directly. **This step makes the browser do the same redirect,
purely as a UX/navigation convenience.** The server stays the only real authority: every API
endpoint still checks login (401) and role (403) on its own, exactly as before.

**Design — the server stays the single source of truth:**
- New read-only endpoint `GET /api/auth/page-access?page=<path>` (`server/routes/auth.routes.js`,
  `server/validators/auth.validators.js`, `server/controllers/auth.controller.js`). It calls the
  **exact same functions `pageGuard` uses** (`canonicalPagePath`, `PAGE_NAME`, `PAGE_PERMISSIONS`,
  `roleHasPermission`), so `allowed` can never disagree with what `pageGuard` would actually do.
  No new rule, no copy of the permission table anywhere else. 401 when logged out; 400
  `"Invalid page address"` for a missing or malformed `page`; otherwise
  `{ page: "<canonical>", allowed: true|false }`.
- `client/js/core/layout.js`: on every page, in parallel with the existing `/auth/me` call, asks
  `/auth/page-access?page=<location.pathname>`. `client/css/layout.css` hides `main.page-content`
  by default (**fail-closed**: nothing is shown until the server says "allowed").
  | Answer | Browser does |
  |---|---|
  | `allowed: true` | reveals the page (`body[data-access="allowed"]`) |
  | `allowed: false` | `location.replace("/pages/dashboard.html?denied=1")` - same toast as the server's own redirect |
  | 401 (login expired between `/me` and this call) | `goToLogin()` with `?next=`, same as everywhere else |
  | network/server error, or an unexpected response | **stays hidden**, shows "Could not check your access to this page." + Reload - no redirect, so a transient problem can never create a redirect loop |
- Nothing else changed: login, logout, cookies, roles, `pageGuard`, the origin check, MongoDB.
  No other controller was touched - every API still enforces its own permission regardless of
  what this endpoint answers (tested explicitly, see below).

**Tests:**
- `server/tests/pageAccess.test.js` (8 tests, own database `snooker_club_pro_test_pageaccess`):
  401 when logged out / bad cookie / after logout; 400 for missing, duplicated or malformed `page`
  (`../`, bad `%` escape, non-`/pages/x.html` shapes); different spellings (case, `%2E`, double
  slash) agree with the canonical one; **every page × every role, compared against what `pageGuard`
  itself actually does when the page is requested** (the source-of-truth check) and against
  `PAGE_PERMISSIONS` directly; the login page is always allowed; a page being "allowed" never
  bypasses a stricter API check (cashier can see the café products page but still gets 403
  creating a product; staff can see Reports but a cashier's API call is still 403).
- `tests/browser/server.js` / `run.js`: a **second listener** (`BROWSER_TEST_STATIC_PORT`, default
  `PORT+1`) serves `client/` with `express.static` and **no `pageGuard`** - a faithful stand-in for
  Vercel - while `/api/*` keeps the real backend (`requireAuth`, roles, everything). A suite named
  `static-*` runs against this port instead of the normal one. A new `/_failaccess/on|off` switch
  makes `/api/auth/page-access` return 503, to test the fail-closed path.
- `tests/browser/suites/static-pageguard.html` (new suite, 39 checks): confirms the static host
  truly has no `pageGuard` (a restricted page's HTML is served while logged out); logged-out
  redirect to login; every role × every restricted page matches the `PERMISSIONS` table (admin: all
  allowed; staff: not Settings/Users; cashier: also not Reports); an allowed page never weakens the
  API's own check; the fail-closed error state and recovery; logout and a server-side-expired
  session both end at the login page, never a blank or stuck one. The existing `auth` suite (the
  real server-side `pageGuard` redirects) passes unchanged.

**Security notes / limitations:**
- The client guard can be bypassed (JavaScript disabled, DevTools) - by design, since it decides
  nothing. Every `/api` request is checked by the server on its own regardless.
- On a static host, a restricted page's HTML/CSS/JS is publicly readable (it holds no club data -
  all real figures come from `/api` calls that are still protected).
- One extra small request per page load (parallel with `/auth/me`, so no added round-trip).
- Not yet verified on the live Vercel deployment (Phase 5) - only the static-host browser-test
  listener stands in for it here.

Test results after 1.5: `npm.cmd test` **294 passed, 0 failed** (287 + 7 new);
`npm.cmd run test:browser` **780 passed, 0 failed** (15 suites, +1 new: `static-pageguard`).

#### 1.6 `client/vercel.json` + `client/404.html` — done

Neither file existed before this step; both are new.

**How a request is handled, once deployed (`client/` as the Vercel project root):**

| Address | What happens |
|---|---|
| `/pages/dashboard.html`, `/css/...`, `/js/...`, `/vendor/...` | served directly - real static files, unchanged |
| `/` | **redirect** (302, `permanent: false`) to `/pages/dashboard.html` - same as `server/app.js`'s `res.redirect()` today |
| `/api/*` | **rewrite** (server-side proxy) to `https://<RAILWAY_BACKEND_URL>/api/:path*` - the browser's address bar never changes, so the login cookie stays first-party (Step 1.3) |
| anything else (typo, old bookmark, removed page) | Vercel's own static-hosting convention: a `404.html` at the project root is served automatically, with a 404 status |

`<RAILWAY_BACKEND_URL>` is a **placeholder** - it must be replaced with the real Railway service
address before deploying (see "What you must provide" below). Left as-is, the rewrite simply fails
(an unresolvable host) rather than silently reaching a real, unrelated server.

`cleanUrls: false` is explicit: every internal link in this app already includes the `.html`
extension (`/pages/users.html`, not `/pages/users`), so Vercel must not strip it.

**Headers:** `client/vercel.json`'s `headers` rule adds the exact header set `helmet()` already
sends for every response today (confirmed by starting the app locally and reading the response:
`Content-Security-Policy` with the same directives except `upgrade-insecure-requests` - already off
- plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Resource-Policy`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`,
`Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `Strict-Transport-Security`). Without this, every
static file Vercel serves would carry none of them - only `/api/*` responses would, since those
still come from the Express app on Railway. The rule's `source` (`/(.*)`) also matches the rewritten
`/api/*` requests; Railway's own identical headers may then appear twice on an API response, which
is harmless (same policy, so nothing is more or less restrictive) but is a known minor overlap.

**`client/404.html`:** built from the existing design system (`theme.css`/`layout.css`/`components.css`,
the same `.login-card` shell `login.html` uses) - not Express's own plain-text 404
(`server/middleware/notFound.js`, unchanged - it only matters for Railway/local, which still use it;
Vercel never reaches it). Deliberately has **no `<script>`**: an error page must keep working even if
the backend or the login check can't be reached, and must never claim the visitor is logged in. Its
one link goes to `/pages/dashboard.html`; if the visitor isn't logged in, that page's own Step 1.5
guard sends them to the login page as usual - the 404 page itself bypasses nothing.

**Tests:** `server/tests/vercelConfig.test.js` (6 tests, no database): valid JSON with the expected
`cleanUrls`/`rewrites`/`redirects`/`headers` shape; the `/api/:path*` rewrite is an absolute
cross-origin URL (never a local path, never `404.html` or `/pages/...`) and no other rule touches an
`/api` address; the `/` redirect matches `server/app.js`'s own behaviour; the header keys and the CSP
value match what the running app actually sends; `404.html` has no script, uses the real stylesheets,
has a working link to a real file, and never prints a fabricated figure or an internal detail
(`MONGODB_URI`, `AUTH_SECRET`, `localhost`, …). These checks run against the **files**, not a live
Vercel deployment - see the limitation below. Steps 1.5's own suites (`pageAccess.test.js`,
`static-pageguard`) were re-run unchanged to confirm no regression.

**Not verified (needs the live deployment, Phase 5):**
- That Vercel's rewrite/redirect/headers rules behave exactly as the JSON says once actually deployed.
- That a missing path truly gets `404.html` with a 404 status (this is Vercel's documented static-site
  convention, not something `vercel.json` configures explicitly, so it cannot be checked from the repo).
- The real Railway backend address - still a placeholder.

**What you (the project owner) must provide before deploying:** the real Railway backend URL, to
replace `<RAILWAY_BACKEND_URL>` in `client/vercel.json`.

Test results after 1.6: `npm.cmd test` **300 passed, 0 failed** (294 + 6 new; one run showed 8
unrelated failures in game-modes/stock tests from MongoDB load - re-running those files alone and
the full suite again both passed cleanly, confirming it was a transient flake, not caused by this
step); `npm.cmd run test:browser` **780 passed, 0 failed** (15 suites, unchanged from step 1.5).

#### 1.7 Final documentation, `.env.example` and Phase 1 verification — done

- `.env.example`: added `TRUST_PROXY` and `ALLOWED_ORIGINS` (introduced in 1.2/1.3 but never added
  here until now - a real gap this step closes), each marked optional with its default and a
  one-line explanation; a short note at the top says every variable is optional except
  `AUTH_SECRET`, which is required in production. `DATABASE_URL` is **not** added - Phase 2 hasn't
  started, nothing in the code reads it yet, and `.env.example` should only list variables the app
  actually uses today.
- `README.md`: the Settings table gained `TRUST_PROXY` and `ALLOWED_ORIGINS` rows (same gap).
- This section: the "Phase 1 status" summary and final checklist below.
- `docs/API.md` and `docs/ARCHITECTURE.md`: already up to date from steps 1.4/1.5 (vendored
  Chart.js, the static-hosting security row, the `page-access` endpoint) - nothing further needed.

## Phase 1 status — code and documentation complete; live deployment not yet verified

Every Phase 1 step (1.1–1.7) is implemented, tested locally and committed on `main`. **"Done" here
means: the code exists, is tested against a local server (and, for 1.5/1.6, a browser-test listener
built to behave like the real hosting target), and the documentation matches the code.** It does
**not** mean the app has been deployed, or that Vercel/Railway have been shown to behave the way
this documentation describes - only an actual deployment can show that (Phase 5).

**What is genuinely still unverified, and can only be checked after deploying:**
1. Vercel's actual rewrite/redirect/header behaviour for `client/vercel.json` (step 1.6).
2. The real Railway backend URL - `client/vercel.json` still has the placeholder `<RAILWAY_BACKEND_URL>`.
3. End-to-end login and API requests through the real Vercel → Railway path (steps 1.3, 1.5, 1.6 together).
4. The correct `TRUST_PROXY` value for the real hosting setup (step 1.2 documents how to check it).
5. That Vercel truly serves `client/404.html` automatically with a 404 status for an unknown address
   (a documented Vercel convention, not something this repo's tests can exercise).

**What you (the project owner) must still provide, not invented here:**
- The real Railway backend URL, once that service exists.
- `AUTH_SECRET`, `ALLOWED_ORIGINS` and `TRUST_PROXY` as Railway environment variables (never
  committed) - see "Environment variables" below for what each should be set to.

Test results after 1.7 (no code changed - documentation and `.env.example` only):
`npm.cmd test` **300 passed, 0 failed**; `npm.cmd run test:browser` **780 passed, 0 failed** (15 suites).

### Phase 2 — PostgreSQL foundation (branch `postgres`)

#### Step 2.1 — Inspection and foundation plan (planning only, no code changed) — done

**Branch:** created `postgres` from `main` at commit `34138b3` (the verified end of Phase 1).
All of Phase 2 happens here until it is fully tested; `main` is untouched.

**What database the app uses today, with evidence:**
- `dependencies.mongoose` in `package.json` (`^9.10.3`); no `pg` or any other SQL driver is installed.
- `server/config/db.js` connects with `mongoose.connect(env.mongoUri, …)` and calls
  `mongoose.connection.syncIndexes()` on start-up.
- `server/config/env.js`: `mongoUri` (default `mongodb://127.0.0.1:27017/snooker_club_pro`).
- `npm run db` (`server/scripts/startDatabase.js`) starts a **portable, local** `mongod.exe` -
  no cloud database is involved today.
- A repo-wide search for `postgres`, `require("pg")` and `DATABASE_URL` found **nothing** in
  `server/`, `client/` or `tests/` except this document and one string in a test's "never print
  this word" check (`server/tests/vercelConfig.test.js`) - confirming PostgreSQL work has not started.

**The 16 models (`server/models/*.js`) and how they relate** (every reference below is a plain
`ObjectId` with a Mongoose `ref:` - a **hint for population, not an enforced foreign key**;
nothing stops an orphaned reference today):

```
User ──< AuthSession                     Table ──< Session ──< Match ──< Bill ──< Payment
Customer ──< Booking ──< Session                              Session ──< Bill
Category ──< Product ──< StockMovement                        Session ──< CafeOrder ──< Bill
                          Product ──< CafeOrder, Bill.lineItems[], StockMovement
Player ──< Match.players[], Bill.players[], Bill.lineItems[].consumerPlayer
Counter (standalone: running numbers)     Setting (standalone: one row per key)
```

**Patterns the current (MongoDB) implementation uses that a PostgreSQL design must reproduce
(same outcomes), not just "add a database":**

| Pattern | Where (file:line) | What it does | PostgreSQL equivalent |
|---|---|---|---|
| Atomic conditional update | `payments.service.js` `recordPayment` | `Bill.findOneAndUpdate({ status: …, amountPaid: { $lte: … }, players.$elemMatch: … }, { $inc: … })` - overpayment is impossible because the check and the write are the same database step | `UPDATE bills SET amount_paid = amount_paid + $1 WHERE id = $2 AND amount_paid <= total - $1 …` inside a transaction; `0` rows updated = the same rule failed |
| Atomic conditional update | `stock.service.js` `increase`/`decrease` | stock changes with `$inc`, guarded by `stockQuantity: { $gte: n }` | same `UPDATE … WHERE stock_quantity >= $1` pattern - this one is **simpler** in Postgres, no change in behaviour needed |
| Atomic "claim" + unique index (two layers) | `sessions.service.js` `claimTable`/`startSession`; `Session.js:51` (`one_open_session_per_table`, `partialFilterExpression: { isOpen: true }`) | an atomic `Table` status change, backed by a **partial unique index** so MongoDB itself refuses a second open session even if the first check races | Postgres: the atomic update + a **partial unique index** (`CREATE UNIQUE INDEX … ON sessions (table_id) WHERE is_open`) - directly supported, no behaviour change |
| Sequence counter | `models/Counter.js` `nextSequence` (`findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true })`) | race-free running numbers (bill numbers, etc.) | a Postgres `SEQUENCE` (or the same upsert-and-increment pattern on a small table) - Postgres makes this simpler, not harder |
| **No DB-level overlap constraint (optimistic insert-and-verify)** | `bookings.service.js` `createBooking` (lines ~111-142): check for a clash, insert anyway, check again, and if the *other* booking's `_id` sorts first, **delete the one just created** and return 409 | MongoDB has no range-exclusion constraint, so the app invents one with a "second check decides who loses, loser self-deletes" dance. `docs/ARCHITECTURE.md` §5.5 already documents this as a known, accepted gap ("a local MongoDB without a replica set can't lock two collections at once") | **This is the one real risk** (see "Known risks" below): Postgres *can* do this properly with `EXCLUDE USING gist (table_id WITH =, tsrange(start_at, end_at) WITH &&)`, but that needs the `btree_gist` extension, which must be confirmed on Railway (not guessed) before relying on it. A tested fallback that needs no extension: `SELECT … FOR UPDATE` on the table's own row (or a dedicated per-table lock row) inside a transaction, serializing booking creation for that table, then the same overlap check - genuinely stronger than today's optimistic dance, not just a copy of it |
| No multi-document transactions anywhere | confirmed by `grep -rn "mongoose.startSession\|startTransaction"` across `server/` → **no matches** | every multi-step write today is either one atomic document update, or (for money: `payments.service.js` step 3) a **manual compensation** - record the `Payment`, and if that fails, "take the money back off the bill" | Postgres gives real `BEGIN`/`COMMIT` transactions "for free" (no replica set needed, unlike MongoDB). Phase 3 should use a genuine transaction for bills+payments and session+stock+café steps - a straightforward **improvement**, not a risk, as already noted in the Phase 3 plan above |
| String ids in every API response | `models/plugins/cleanJson.js`: `toJSON` transform turns Mongo's `_id` (ObjectId) into `id` (string), drops `__v` | the API's documented contract (`docs/API.md`) already promises string ids - nothing to change there | PostgreSQL tables use `uuid` primary keys (`gen_random_uuid()` or app-generated v4/v7); the row mapper layer (Phase 2.2) converts `uuid` → `string` the same way `cleanJson` does today, so the JSON shape is identical |
| "Who did it", embedded | `models/schemas/actor.js` (`actorSchema`): `{ user, name, username }` embedded on bills, payments, bookings, sessions, settings, users via `actorFrom(req.user)` | a denormalized copy (so history reads correctly even if the account is later renamed), not a live join | becomes plain `actor_user_id / actor_name / actor_username` columns on each table - same denormalization, same reason, just flattened instead of embedded |
| Embedded arrays as the hard case | `models/Bill.js`: `lineItems[]` (`lineItemSchema`) and `players[]` (`playerSchema`), both `{ _id: false }` sub-documents, with a `balanceDue` virtual and 5 indexes (2 of them partial/conditional) | the most complex model in the app | becomes two real child tables (`bill_line_items`, `bill_players`) with a foreign key to `bills.id` and their own rows - this is genuinely more work, which is exactly why the Phase 3 plan above puts "Bills and payments" near the end (step 11 of 15), after the simpler models are proven |
| Tests use a throw-away database per file | `server/tests/helpers/testDb.js` (`assertTestDatabase`: the name must contain `"test"`, or nothing is dropped); every `*.test.js` connects to its own `snooker_club_pro_test_<area>` database | this is the safety rule that stops a mistyped test URI from ever deleting the club's real data | the same rule, same enforcement, must exist for the PostgreSQL test databases (Step 2.2/2.3) before any test touches a real connection |

**Money, dates and other "easy" parts** (confirmed, not assumed): every amount is already stored as
an **integer paisa** (`money` schema type, `validate: Number.isInteger`) - maps directly to Postgres
`BIGINT`, no precision work needed. Every date is already stored as a UTC `Date` - maps directly to
`timestamptz`. Enums (`status`, `role`, `gameMode`, …) map to Postgres `CHECK (… IN (…))` constraints
or native `ENUM` types - the same fixed value lists already defined in each model file.

**What must stay unchanged (the API contract, already documented and tested):** JSON shapes,
string ids, HTTP status codes and the exact error messages in `docs/API.md` and the 300 passing
server tests - `server/tests/*.test.js` is itself the acceptance test a PostgreSQL implementation
must keep passing (per model/service, ported one at a time per the Phase 3 order above).

**Recommended Step 2.2 scope (the smallest safe next step - not started in 2.1):**
1. Add `pg` as a dependency (justification: it is the standard, officially supported Node.js
   PostgreSQL driver; no ORM is proposed, to keep the same explicit, parameterized-query style the
   codebase already uses in its services).
2. `server/config/db.pg.js` (new, separate file - `server/config/db.js`/Mongoose is **not touched**):
   a `pg.Pool` built from `DATABASE_URL`, plus small `query()`/`withTransaction()` helpers.
3. `DATABASE_URL` is added to `.env.example` **at that point** (not now - Step 2.1 adds no code
   that reads it, and `.env.example` should only list variables the app actually uses).
4. A local, portable PostgreSQL for Windows (mirroring `npm run db`'s approach), and a test helper
   that refuses to touch any database whose name doesn't contain `"test"` (mirroring
   `server/tests/helpers/testDb.js` exactly).
5. One smoke test only: connect, run `SELECT 1`, confirm the pool and the transaction helper work -
   **no schema, no migrations, no repositories yet**. Those are Step 2.3+, informed by this
   inspection (settings → users → tables → … , the Phase 3 order above).
6. Before Step 2.3 relies on any PostgreSQL 15+ feature or the `btree_gist` extension (for the
   booking-overlap case above), confirm Railway actually provides it - do not assume.

No application code, dependency, environment variable or test was changed in Step 2.1 - this is
documentation only, matching the instruction not to add a database connection merely to make
progress while the next step owns implementation.

No application code changed in Step 2.1, so no regression was expected; both suites were still run
in full on the new `postgres` branch as a safety check, confirming the branch genuinely behaves like
`main`: `npm.cmd test` **300 passed, 0 failed**; `npm.cmd run test:browser` **780 passed, 0 failed**
(15 suites) - identical to the numbers reported at the end of Phase 1.

#### Step 2.2 — `pg`, connection pool, transaction helper, smoke test — done (connection verified in step 2.2A below)

**Dependency:** `pg` `^8.23.1` added to `package.json`'s `dependencies` (not a devDependency - the
real app will need it once Phase 3 starts). No ORM, no other database framework. `npm.cmd install`
only added `pg` and its own transitive packages to `package-lock.json` (`pg-pool`, `pg-protocol`,
`pg-types`, `pg-connection-string`, `pg-cloudflare`, `pgpass`, `pg-int8`, `postgres-array`,
`postgres-bytea`, `postgres-date`, `postgres-interval`, `split2`, `xtend`) - nothing else in the
lockfile changed or was upgraded. `pg`'s own requirement is Node `>=16`; the project already
requires `>=20` (`package.json` `engines`), so it is compatible as installed - confirmed by
actually running it (the smoke test below), not merely by reading version numbers.

**`server/config/env.js`:** one new, optional setting - `databaseUrl: process.env.DATABASE_URL || ""`.
Nothing reads it at start-up; it does nothing on its own.

**`server/config/db.pg.js` (new - `server/config/db.js`, Mongoose, is untouched):**
- `getPool()` - builds the `pg.Pool` from `env.databaseUrl` **the first time it is actually called**,
  never just because this file is required. Throws a clear, specific error ("DATABASE_URL is not
  set...") if it's empty - never `pg`'s own confusing error from guessing a default local address.
- `query(text, params)` - one query through the pool. `params` are bound as `$1, $2, …`; the file's
  own header comment says plainly that a value must never be joined into `text` itself (SQL
  injection). Every value this project will ever put through PostgreSQL goes through `params`, the
  same discipline the Mongoose services already use with query filters.
- `withTransaction(fn)` - acquires one client, `BEGIN`, runs `fn(client)`, `COMMIT` on success,
  `ROLLBACK` on any error from `fn` (and the original error is what callers see - a failed rollback
  is attached as `error.rollbackError`, never swapped in instead). The client is always released in
  a `finally`, so a crash inside `fn` can never leak a connection out of the pool.
- `closePool()` - the one explicit, documented way to close it. Nothing calls this automatically.
- No credential logging anywhere: `safePgTarget()` (mirrors `db.js`'s `safeMongoTarget`) prints only
  the host and database name, never the user name or password, and is the only thing the pool's
  own error listener ever prints.

**Test-database safety (`server/tests/helpers/testDb.pg.js`, new):** deliberately **not** a reuse
of the MongoDB helper (`server/tests/helpers/testDb.js`), because that helper's rule - "test"
*anywhere* in the name - has a real gap: a database named `snooker_club_pro_latest` would wrongly
pass it (`"latest"` contains the substring `"test"`). The new PostgreSQL-only rule requires `"test"`
as its **own word** (`\btest\b`, case-insensitive): `test`, `club_test`, `test_club` pass;
`latest`, `attest` do not. It also introduces its own test-only variable, `PG_TEST_DATABASE_URL`
(not `DATABASE_URL`): a test must never be able to run just because the real, future production
variable happens to be set - the same separation the MongoDB tests already use
(`MONGODB_URI` vs. each file's own `MONGODB_<AREA>_TEST_URI`). This module makes no queries and
has no drop/reset function - Phase 2 doesn't need one yet, and the smoke test only ever reads.

**Smoke test (`server/tests/postgresConnection.test.js`, new, the ONLY file touching PostgreSQL):**
three tests -
1. connect, `SELECT 1`, close the pool - **skipped** when `PG_TEST_DATABASE_URL` isn't set;
2. a transaction that commits, and one that deliberately fails and is confirmed to roll back,
   checking the *original* error (not a rollback error) is what comes out - also **skipped** without it;
3. `db.pg.js` throws its clear "DATABASE_URL is not set" message (via a fresh subprocess with
   `DATABASE_URL` genuinely empty, the same isolation pattern `server/tests/helpers/envSetting.js`
   already uses) - this one needs no PostgreSQL server and always runs.

**Configuring a local PostgreSQL test database (so tests 1-2 actually run):** install PostgreSQL
locally (any recent version), create one throw-away database whose name contains `test` as its own
word, e.g.:

```sql
CREATE DATABASE snooker_club_pro_test;
```

then run the smoke test with that database's connection string in `PG_TEST_DATABASE_URL`
(PowerShell):

```powershell
$env:PG_TEST_DATABASE_URL = "postgres://postgres:yourpassword@127.0.0.1:5432/snooker_club_pro_test"
node --test server/tests/postgresConnection.test.js
```

**Limitation as first written in step 2.2:** this environment had no PostgreSQL server and no
Docker, so `PG_TEST_DATABASE_URL` could not be set, and tests 1-2 were **skipped**, not passed - a
skip is evidence of nothing. What *was* actually run and passed then was only: `pg` installs and
loads correctly on this Node version, and `db.pg.js`'s "DATABASE_URL is missing" error path (test
3). **Step 2.2A (below) closes this gap with a real connection.**

**Backward compatibility (checked):** `npm.cmd test`/`npm.cmd run test:browser` still pass in full
(below) with no PostgreSQL configured anywhere - proving normal start-up, MongoDB, and every route
are completely unaffected by this module's mere existence.

Test results after 2.2 (no PostgreSQL available yet): `npm.cmd test` **303 passed, 0 failed, 2
skipped** (300 + 3 new, 2 of the 3 skipped as explained above); `npm.cmd run test:browser`
**780 passed, 0 failed** (15 suites, unchanged).

#### Step 2.2A — Real local PostgreSQL connection, actually verified — done

Closes step 2.2's one open limitation: a genuine PostgreSQL server was set up locally and the
smoke test was run against it for real - the two previously-skipped tests now **pass**, not skip.

**Setup chosen (portable, no installer, no admin rights, no Windows service)** - the same idea as
this project's own portable MongoDB (`npm run db`): EDB's "binaries" zip (no registration step
needed), confirmed as a genuine zip (384,620,317 bytes) before trusting it, extracted to
`%LOCALAPPDATA%\SnookerClubPro\postgresql\pgsql`. **Version actually running: PostgreSQL 18.6**
(`pg_config --version`, read directly from the running binaries - not assumed).

```powershell
$PG = "$env:LOCALAPPDATA\SnookerClubPro\postgresql\pgsql"
$DATA = "$env:LOCALAPPDATA\SnookerClubPro\postgresql\data"
& "$PG\bin\initdb.exe" -D $DATA -U postgres -A trust --locale=C   # local-only, no password: never used for anything but this test database
& "$PG\bin\pg_ctl.exe" -D $DATA -o "-p 5433 -h 127.0.0.1" -l "$env:LOCALAPPDATA\SnookerClubPro\postgresql\log.txt" start
& "$PG\bin\createdb.exe" -h 127.0.0.1 -p 5433 -U postgres snooker_club_pro_test
```
Port **5433** (not PostgreSQL's usual 5432) and `-h 127.0.0.1` only, specifically so this throw-away
instance can never collide with, or be reached from outside, any other PostgreSQL someone might
already have. `-A trust` has no password at all - safe only because the server listens on the
loopback address alone; this is a local test instance, never a production credential.

**A real bug this step found and fixed:** `server/tests/helpers/testDb.pg.js`'s rule from step 2.2,
`/\btest\b/i`, looked right but was wrong - regex `\b` treats `_` as part of a word (it's in `\w`),
so it does **not** see a boundary in `pro_test`. The very name this document recommends,
`snooker_club_pro_test`, was **refused** by the helper that was supposed to accept it (confirmed by
testing the regex directly before touching anything else). Fixed by splitting the name on every run
of non-alphanumeric characters (`_`, `-`, `.`, `/`, `:`, …) and checking `"test"` is one of the
resulting words - verified against the same cases as before, now correctly: `snooker_club_pro_test`,
`test`, `club_test`, `test_club` → accepted; `latest`, `attest`, `mytest`, `test123` → still refused.

**What actually ran, against the real database above** (`PG_TEST_DATABASE_URL` set to the
`snooker_club_pro_test` connection string, no password, loopback only):
- `node --test server/tests/postgresConnection.test.js` → **all 3 tests passed** (0 skipped):
  the connection was established, `SELECT 1` returned `1`, a transaction committed, another was
  deliberately failed and confirmed to roll back (and the *original* error - not a rollback error -
  is what came out), and the pool closed cleanly.
- Full suite, same `PG_TEST_DATABASE_URL` still set: `npm.cmd test` **303 passed, 0 failed, 0
  skipped**. With it unset again (the ordinary state for anyone who hasn't configured PostgreSQL):
  the two connecting tests **skip** again, confirmed directly - proving the opt-in design works
  both ways, not just when configured.
- `npm.cmd run test:browser` **780 passed, 0 failed** (15 suites) - unaffected either way, as expected.

**Still true, unchanged from step 2.2:** no schema or table was created, no model was ported, no
production data exists or was touched, MongoDB remains the only database the running app actually
uses. The local PostgreSQL server above is left running on `127.0.0.1:5433` for convenience (Step
2.3 will need it again); stop it any time with:
```powershell
& "$env:LOCALAPPDATA\SnookerClubPro\postgresql\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\SnookerClubPro\postgresql\data" stop
```

Test results after 2.2A: `npm.cmd test` **303 passed, 0 failed** (0 skipped, with
`PG_TEST_DATABASE_URL` configured); `npm.cmd run test:browser` **780 passed, 0 failed** (15 suites).

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
- [x] 1.5 Client-side page-role guard (294 server / 780 browser; live Vercel check pending Phase 5)
- [x] 1.6 `client/vercel.json` + `client/404.html` (300 server / 780 browser; live Vercel check and real backend URL still pending Phase 5)
- [x] 1.7 Docs + `.env.example` + full test runs (300 server / 780 browser) — **Phase 1 complete in code and docs; live deployment unverified (see "Phase 1 status" above)**
- [x] Phase 2, Step 2.1 — inspection + foundation plan (docs only, `postgres` branch created from `34138b3`; 300 server / 780 browser re-run clean)
- [x] Phase 2, Step 2.2 — `pg` dependency, connection pool, transaction helpers, smoke test (303 server / 780 browser, PostgreSQL tests skipped at this point - no local server yet)
- [x] Phase 2, Step 2.2A — real local PostgreSQL 18.6 set up (portable, port 5433); smoke test actually connected and passed (303/0/0 skipped); fixed a word-boundary bug in testDb.pg.js found in the process
- [ ] Phase 2, Step 2.3 — start on schemas/migrations, one table at a time, per the Phase 3 order (settings first)
- [ ] Phase 3 — Services ported
- [ ] Phase 4 — Tests + Mongo import verified
- [ ] Phase 5 — Live on Railway + Vercel, verified
