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

#### Step 2.3 — Schema design and migration foundation — done

**Scope check against the 16 models:** `ls server/models/*.js` confirms exactly **16** model
files today (`AuthSession, Bill, Booking, CafeOrder, Category, Counter, Customer, Match, Payment,
Player, Product, Session, Setting, StockMovement, Table, User`) - verified again before writing
any SQL, not assumed from step 2.1's count.

##### Schema mapping (Part A/B)

Every model was re-read in full for this step. The schema lives in `server/db/migrations/0001_initial_schema.sql`
(itself heavily commented); this table is the short, reviewable version - **20 tables**, one
dedicated PostgreSQL schema (`app`, not the default `public` - a clean, disposable namespace: it
can be dropped on its own without touching anything else in a database).

Shared conventions (stated once, applied everywhere, exactly reproducing current behaviour):

| Mongoose today | PostgreSQL here | Why |
|---|---|---|
| `_id` (ObjectId) | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` | built into PostgreSQL 13+, no extension; the Phase 3 row-mapper turns it into a string the same way `cleanJson.js` turns `_id` into `id` today |
| `money` schema type (`Number`, whole number) | `bigint` | paisa, unchanged - no new precision rules (ARCHITECTURE.md §5.1) |
| `{ timestamps: true }` | `created_at` / `updated_at timestamptz` | direct equivalent |
| `enum: [...]` | `CHECK (col IN (...))` on `text` | a plain `ALTER TABLE` adds a value later, same ease as the app's own enums growing today (e.g. `PRICING_TYPES` keeps `"per_game"` forever for old bills) - a native Postgres `ENUM` type is harder to extend, so it was not used |
| embedded `actorSchema` (`{ user, name, username }`) | three columns per field: `<x>_user_id` (FK), `<x>_name`, `<x>_username` | the same flattened copy, kept for the same reason Mongo embeds it: history reads correctly even if the account is later renamed/deactivated |
| embedded arrays (`Bill.lineItems[]`, `Bill.players[]`, `Match.players[]`, `Match.teams[]`) | real child tables, FK + `ON DELETE CASCADE`, with a `position` column (SQL rows have no inherent order; Mongo arrays do) | the only way to keep each item individually queryable and constrained in SQL |

Every table (full column lists are in the migration file itself):

| Table | From | Notable |
|---|---|---|
| `users` | User.js | `password_hash`: Phase 3's row-mapper must never `SELECT *` here, the same discipline `select: false` enforces today |
| `auth_sessions` | AuthSession.js | **no TTL** - see "Open design questions" |
| `tables` | Table.js | |
| `customers` | Customer.js | `phone_digits`: computed by the Phase 3 row-mapper (today's `pre("validate")` hook), not a DB trigger |
| `categories` | Category.js | |
| `products` | Product.js | `isLowStock` virtual: computed, not stored |
| `players` | Player.js | |
| `sessions` | Session.js | `booking_id` FK added by a later `ALTER TABLE` (see below) |
| `bookings` | Booking.js | the overlap rule (below) |
| `cafe_orders` | CafeOrder.js | `bill_id` FK added later |
| `stock_movements` | StockMovement.js | `bill_id` FK added later; no `updated_at` (a movement is never edited, matching its Mongoose `timestamps: { updatedAt: false }`) |
| `matches` | Match.js | `bill_id` FK added later (the pointer is a convenience; `bills.match_id` is the source of truth, per Match.js's own comment) |
| `match_players` | Match.js `matchPlayerSchema[]` | |
| `match_teams` | Match.js `teamSchema[]` | `seats` is a native `integer[]`, not another child table - never queried on its own |
| `bills` | Bill.js | `balance_due` is a **generated column** (`GENERATED ALWAYS AS ... STORED`) - PostgreSQL keeps it in sync automatically, reproducing the `balanceDue` virtual exactly, always |
| `bill_line_items` | Bill.js `lineItemSchema[]` | |
| `bill_players` | Bill.js `playerSchema[]` | |
| `payments` | Payment.js | |
| `settings` | Setting.js | `gameRates` flattened to `rate_century/rate_frame/rate_snooker_point/rate_four_player`, nullable - `NULL` still means exactly "never set" (Setting.js's own comment), not `0` |
| `counters` | Counter.js | kept as a table, not a SQL `SEQUENCE` - the app needs one counter **per name** created on demand; `INSERT ... ON CONFLICT (id) DO UPDATE SET seq = seq + 1 RETURNING seq` reproduces `findOneAndUpdate`'s atomic upsert-and-increment exactly (Phase 3) |

**Primary-key strategy for existing data:** every id is a PostgreSQL `uuid`, generated by the
database (`gen_random_uuid()`). Mapping the *existing* MongoDB `ObjectId`s to these UUIDs is a
**Phase 4** task (`importMongoBackup.js`, already in this document's roadmap) - deterministic,
so the same ObjectId always produces the same UUID (e.g. UUID v5 keyed off the ObjectId, so
cross-references between collections import correctly without a separate lookup pass). Step 2.3
builds and tests the empty schema only; no data of any kind has been imported.

**Historical billing/pricing is preserved exactly as today:** every rate, price and snapshot
field Bill.js copies at billing time (`unit_price`, `hourly_rate_at_start`, `table_number`,
`table_name`, …) is copied into these tables the same way - a later change to `products.price` or
`settings.rate_*` **cannot** change an existing bill, because the bill never reads those columns
again after it is created. This is a straight copy of the existing design, not a new one.

**Booking overlap - verified, not assumed:**
- Mongo today has no range-exclusion constraint, so `bookings.service.js`'s `createBooking` uses
  an optimistic "check, insert anyway, check again, delete the later one if both landed" dance
  (step 2.1 found and documented this).
- PostgreSQL's `EXCLUDE USING gist` constraint can enforce this **inside the database itself** -
  tested directly on the local instance before writing it into the migration (not assumed):
  ```sql
  -- (ran against snooker_club_pro_test, then rolled back - nothing kept)
  ALTER TABLE test_bookings ADD CONSTRAINT no_overlap
    EXCLUDE USING gist (table_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
    WHERE (status IN ('pending','confirmed'));
  -- a genuinely overlapping insert: ERROR: conflicting key value violates exclusion constraint "no_overlap"
  ```
- This needs the `btree_gist` extension. **Confirmed available and working on the local
  PostgreSQL 18.6** (`CREATE EXTENSION btree_gist;` succeeded, version 1.8). **Railway's
  availability is still NOT confirmed** - the migration's `CREATE EXTENSION IF NOT EXISTS
  btree_gist;` will fail loudly there if it's missing or not permitted, which is the safe
  outcome (never silently skipped). Documented fallback if it turns out to be unavailable:
  drop this one constraint from the migration and move the equivalent check into the Phase 3
  service layer as a `SELECT ... FOR UPDATE`-serialized transaction (stronger than today's
  MongoDB workaround either way, since Postgres gives real multi-statement transactions).
- `bills`'s compound unique rule (`{session, match}`, including the "only one session-only bill"
  case) has the same kind of gap: a plain SQL `UNIQUE(session_id, match_id)` would NOT work,
  because standard SQL treats every `NULL` as distinct from every other `NULL` - the opposite of
  Mongo's actual behaviour here. Solved with **two partial unique indexes** instead (one `WHERE
  match_id IS NULL`, one `WHERE match_id IS NOT NULL`) - also tested directly before trusting it.

**Circular references, resolved with deferred `ALTER TABLE`:** two pairs of tables refer to each
other (`sessions.booking_id` ↔ `bookings.session_id`; `matches.bill_id` ↔ `bills.match_id`).
Standard SQL can't create two mutually-referencing tables in one statement each; both are created
with the circular column present but unconstrained, then linked once both tables exist. This is a
well-known, ordinary SQL pattern (e.g. "employee ↔ manages-department"), not a workaround specific
to this schema.

**Open design questions (recorded, not guessed):**
1. `auth_sessions` has no TTL equivalent - Mongo deletes expired logins by itself; PostgreSQL
   needs an explicit periodic job (e.g. a `DELETE FROM app.auth_sessions WHERE expires_at <
   now()` on the same timer the app already has for no-shows/backups). Not built in Step 2.3 -
   it's Phase 3 (users/auth) work.
2. `phone_digits`, `name_key` and similar derived fields are computed by Mongoose `pre("validate")`
   hooks today. Step 2.3 keeps them as plain columns (no trigger, no generated column) on the
   assumption that Phase 3's row-mapper layer will compute them before every insert/update, the
   same place every other piece of that logic moves to - flagged for confirmation when Phase 3
   actually writes that layer.
3. `match_players`/`bill_players`/`bill_line_items` order is kept via a plain `position` integer
   column (Mongo arrays are ordered; SQL rows are not) - Phase 3 must always `ORDER BY position`
   when reading these back, and write it explicitly on insert.

##### Migration mechanism (Part C)

- **Files:** `server/db/migrations/*.sql`, applied in plain filename order (`0001_`, `0002_`, …
  *is* the order - no separate config). Today there is exactly one: `0001_initial_schema.sql`.
- **History table:** `app.schema_migrations (id text PRIMARY KEY, applied_at timestamptz)` - `id`
  is the filename. Created by the runner itself (`CREATE TABLE IF NOT EXISTS`), not tracked as a
  migration (it can't record itself as applied in a table that doesn't exist yet).
- **Runner:** `server/db/migrate.js` - no migration framework or new dependency (no
  node-pg-migrate, knex, umzug, …): the actual need (ordered `.sql` files + one tracking table) is
  small, and the MongoDB side of this project has never used a migration framework either (its
  schema grows by adding optional fields). Built directly on `server/config/db.pg.js` (step 2.2).
  - Each file runs inside **its own transaction** (`withTransaction`, step 2.2) - PostgreSQL
    supports transactional DDL, so a failure partway through a file rolls back everything in that
    file, and it is never recorded as applied. Confirmed directly (see tests below): an earlier,
    successful file's changes survive a later file's failure.
  - `node server/db/migrate.js` (or `npm run db:pg:migrate`) applies every pending migration.
  - `node server/db/migrate.js status` (or `npm run db:pg:migrate:status`) lists applied/pending
    - read-only, changes nothing.
  - **Never runs on its own:** nothing in `server/server.js` or `server/app.js` requires this
    file. It only ever runs from the command line or a test, exactly like `npm run db` already
    works for MongoDB.
  - Uses `DATABASE_URL` (via `server/config/db.pg.js`), exactly like every other PostgreSQL code
    in this project - never MongoDB, never a hard-coded address.

##### Tests (Part D) - all against the real, verified local database

`server/tests/postgresMigrations.test.js` (9 checks, **skipped** without `PG_TEST_DATABASE_URL`;
additionally refuses to run unless that URL's host:port is exactly `127.0.0.1:5433`, the verified
local instance from step 2.2A - never a guessed or production address):

1. the runner connects to the intended database (`SELECT current_database()`)
2. `0001_initial_schema.sql` applies successfully
3. it is recorded in `app.schema_migrations`
4. running migrations again applies nothing a second time (and the history has exactly one row, not two)
5. `status()` reports `applied`/`pending` accurately
6. all 20 tables exist; the foreign keys on the trickiest tables (including both deferred ones)
   point at the right tables; the key unique/partial indexes and the `EXCLUDE` constraint exist
7. **functional**, not just structural: an actual second open session on the same table is
   rejected by `sessions_one_open_per_table`; an actual overlapping booking is rejected by
   `bookings_no_overlap`
8. a deliberately-broken second migration is rolled back completely (its `CREATE TABLE` never
   persists, it is never recorded as applied) while an earlier, successful migration's table
   **does** persist - proving per-file transactions are independent and ordered correctly

Isolation: every test lives inside its own `app` **schema** (never the default `public` one),
dropped (`DROP SCHEMA IF EXISTS app CASCADE`) before the run and again afterward in `t.after` -
confirmed clean both before and after by direct inspection (`\dn`, `\dt` show nothing). This never
touches any other schema or database; the rollback test (#8) uses its own temporary fixture
migration directory (`fs.mkdtempSync`), never the real `server/db/migrations/`.

**Actually run, with the real local PostgreSQL 18.6 (127.0.0.1:5433) configured:**
`node --test server/tests/postgresMigrations.test.js` → **9 passed, 0 failed** (run twice in a
row, to confirm it is genuinely repeatable, not just lucky once).

##### Regression checks (Part E)

| Command | With PostgreSQL configured | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **312 passed, 0 failed, 0 skipped** | 303 passed, 0 failed, **9 skipped** (the new file, cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) | unaffected either way |

Explicitly confirmed:
- **MongoDB remains the application's only active database** - nothing in `server/app.js`,
  `server/server.js` or any route was changed; every MongoDB-backed test above still uses its own
  throw-away `snooker_club_pro_test_<area>` database, untouched by anything in this step.
- **No existing functionality was switched to PostgreSQL** - no controller, service or route
  reads or writes through `server/config/db.pg.js` yet. That is Phase 3.
- **No existing MongoDB record was modified** - this step never connects to MongoDB at all.
- **No production database was touched** - every SQL statement above ran only against
  `snooker_club_pro_test` on the local, loopback-only PostgreSQL from step 2.2A.
- **Nothing was deployed.**

##### What is and isn't included in Step 2.3

**Included:** the full schema design for all 16 models (20 tables), the migration file that
creates it, a small reusable migration runner with status/rollback behaviour, and tests that
actually exercise all of it against a real PostgreSQL database.

**Not included (future steps, per the Phase 3/4 roadmap above):** no application code reads or
writes through this schema; no data (test or real) has been imported into any of these tables; no
row-mapper layer (UUID↔string, the `position` columns, computing `phone_digits`/`name_key`); the
`auth_sessions` expiry cleanup job; the Railway `btree_gist` confirmation; a `DATABASE_URL` for
Railway itself (still a placeholder everywhere it's mentioned).

#### Step 2.4 — Row mappers and a Settings service pilot — done

**Scope:** a small, reusable row-mapper layer built for the conversions this pilot actually
demonstrated a need for (not speculatively for all 16 models), plus one standalone PostgreSQL
Settings service, tested on its own against the real local database. **Nothing in the running
application calls any of this** - `server/app.js`, `server/server.js` and every route are
untouched; MongoDB stays the only database the app actually uses.

##### Row-mapper layer (`server/db/rowMappers.js`)

Built only after confirming each conversion was real, by querying the actual local PostgreSQL
directly (not assumed from documentation):

| Conversion | What was actually found | Function |
|---|---|---|
| `bigint` (every money column) | `pg` returns it as a **string** (`"1000"`, not `1000`) - confirmed: `SELECT 1000::bigint` → JS `typeof` is `"string"`. The app's amounts never exceed `MAX_PRICE` (10,000,000), far under `Number.MAX_SAFE_INTEGER`, so converting loses nothing | `toMoney` - also keeps `null` as `null` (never set) **distinct from `0`** (explicitly switched off) - the two must never collapse into each other, per `models/Setting.js`'s own comment |
| `uuid` | already a plain JS string from `pg` - confirmed, not assumed | `toId` - exists to name the conversion in one place, the same way `cleanJson.js` names `_id → id` today |
| plain snake_case columns | e.g. `minimum_billable_minutes` | `snakeToCamel` - for ordinary one-to-one columns **only**; a column needing reshaping (see `gameRates` below) is mapped explicitly instead, never guessed |
| flattened "who did it" (`<prefix>_user_id/_name/_username`, step 2.3) | → `{ user, name, username }` or `null` | `actorFromRow` - a real edge case found while testing (not designed up front): until Phase 3 ports Users, a real actor's `user_id` is stored as `null` (see below) while `name`/`username` ARE still known - Mongoose's embedded `actorSchema` never has that combination, so this had to check presence on name/username, not on `user_id` alone, or it would have silently thrown away a known name |

`timestamptz` columns needed no conversion function: `pg` already returns a JS `Date`, exactly
like Mongoose - `res.json()` serializes both to an ISO string the same way.

##### Settings service pilot (`server/services/settings.pg.service.js`)

A **separate, standalone module** - it neither calls nor is called by
`server/services/settings.service.js` (MongoDB); nothing wires it into a route. It reuses, rather
than re-implements, the two shared pieces that already define Settings' business rules, so the
two paths can never quietly disagree:
- `config/gameModes.js`'s `resolveGameRates` (admin value → legacy field → registry default)
- `models/schemas/actor.js`'s `actorFrom` (building an actor record from a logged-in user)

**Create-once, race-free initialization**, verified directly (not assumed): PostgreSQL's
`INSERT ... ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING *` - a genuine no-op
"update" so the row's own unique `key` constraint (step 2.3) is what actually serializes
concurrent calls, the same role MongoDB's upsert + unique index plays today. Tested with 20
truly concurrent calls (`Promise.all`): exactly one row, every time, both as a standalone probe
and through the real service.

**A genuine architectural finding, not a design choice made up front:** `app.settings
.updated_by_user_id` is a `uuid` **foreign key** to `app.users(id)` (step 2.3). Attempting to
store a real admin's actual id there failed with `violates foreign key constraint
"settings_updated_by_user_id_fkey"` - because **Users has not been ported to PostgreSQL yet**
(that's Phase 3): `app.users` has no real rows, and a logged-in person's real id today is a
MongoDB ObjectId (24 hex characters), never a PostgreSQL `uuid`, so it could never have matched
anyway. Resolved by:
1. `actorUserIdOrNull()`: only a value that is already *shaped* like a uuid is even attempted;
   anything else (every real actor today) becomes `null` before it reaches the database.
2. The name/username are **still stored and returned** even when the id is `null` - readable
   audit history survives, matching the actual intent behind Mongo's embedded actor copy.
3. The foreign key is **deliberately left in place**, not removed or weakened: a test proves it
   correctly refuses a uuid-shaped id that matches no real row, demonstrating the constraint
   actually protects referential integrity (not just that it exists in the schema) - once Phase 3
   populates real `app.users` rows, the exact same code starts linking to them correctly, with
   no further change needed here.

**Preserved exactly, field for field, from `settings.service.js` (MongoDB):** every default
(`minimumBillableMinutes: 15`, `billingIncrementMinutes: 5`, `taxEnabled: false`, `currency:
"PKR"`, `backupEnabled: true`, `backupIntervalHours: 12`, `backupKeepCount: 30`, …), the
`framePrice` ↔ `gameRates.frame` "must agree if both are sent" 400 rule, and the "0 means switched
off, not yet-another-default" distinction for every rate.

##### Tests (`server/tests/postgresSettings.test.js`)

- **Row-mapper unit tests (4, no database - always run, proven in this report):** `toMoney`,
  `snakeToCamel`, `toId`, `actorFromRow` - including the "name known, id unknown" case the
  service pilot actually hit.
- **Settings pilot (12 checks inside one skippable test, needs `PG_TEST_DATABASE_URL` at
  `127.0.0.1:5433` - the verified local instance, step 2.2A):** creating the default row exactly
  once; every stored default matches `Setting.js`; an unset rate is `null` raw but resolves to the
  registry default through `describeSettings` (reusing the shared function); re-initializing
  never overwrites a value already changed; a rate update is stored precisely and other fields
  stay untouched; **the foreign-key finding above, reproduced on demand**; a rate explicitly set
  to `0` stays `0` (never falls back to the default); the `framePrice`/`gameRates.frame` conflict
  rule (400) and the matching-values case (accepted); `MAX_PRICE` round-trips exactly as a number
  through a real update and re-read; 20 concurrent initializations still produce exactly one row;
  and a structural check that this pilot's own require chain never touches `mongoose`.

Isolation: everything happens inside the test database's own `app` **schema**, dropped before and
after (confirmed clean by direct inspection) - never the whole database, never anything outside
that schema, never MongoDB.

**Actually run, against the real local PostgreSQL 18.6 (127.0.0.1:5433), twice in a row:** **16
passed, 0 failed**, both times.

##### Regression checks

| Command | With PostgreSQL configured | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **328 passed, 0 failed, 0 skipped** | 305 passed, 0 failed, **4 skipped** (the four PostgreSQL integration tests, cleanly - the row-mapper unit tests still ran and passed) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) | unaffected either way |

Confirmed: MongoDB remains the application's only active database (no route or controller reads
this module); every MongoDB-backed test above still uses its own throw-away database, untouched;
no production database was touched; nothing was deployed.

##### Remaining conversion risks and open questions

- **`updated_by_user_id` stays `null` for every real call until Phase 3 ports Users** - documented
  above, not a bug. Phase 3 must re-check `actorUserIdOrNull` once real `app.users` rows exist (it
  may simply no longer be needed once every actor genuinely has a PostgreSQL id).
- **`auth_sessions` has no TTL equivalent** (carried over from step 2.3, still open): PostgreSQL
  needs an explicit periodic cleanup job; Settings' own `backupIntervalHours`/`backupKeepCount`
  fields are unaffected by this, but it is Phase 3 (users/auth) work either way.
- **Railway's `btree_gist` availability is still unconfirmed** (carried over from step 2.3) - this
  step didn't touch bookings, so nothing new to add here, but it remains open before Phase 5.
  `gameRates`'s nullable-rate design and the `position`-column approach for embedded arrays (step
  2.3) were not exercised by this pilot (Settings has neither) - still to be proven once a model
  that has them (e.g. Bills, Matches) is ported.

Test results after 2.4: see "Regression checks" above.

#### Step 2.5 — Relationship and ordered-array pilot — done

**Why Categories + Products was chosen:** the task listed three candidates - Tables (simple,
no relationship), Products/Categories (a real foreign key) and "another model with an embedded
array". A plain Tables pilot would have proven nothing new (step 2.4's Settings pilot already
exercises a standalone table with no relationships). Categories/Products is the **smallest real
one-to-many relationship** in the schema, and matches the Phase 3 porting order exactly (third,
right after tables/customers) - the natural next step, not a detour.

**For the ordered-array requirement**, no model that small also has an embedded array of its
own, and the schema's actual ordered-array tables (`match_players`, `match_teams`,
`bill_line_items`, `bill_players`) all sit behind the much heavier `tables → sessions → matches`
or `→ bills` chain. Per the task's own guidance ("if one model cannot safely test both... choose
one narrowly scoped pilot and document the gap"), this step did **not** build a Matches or Bills
service - but rather than leave the gap entirely open, it reached `match_players`/`match_teams`
with the **minimum possible fixture rows** (one `tables`, one `sessions`, one `matches` row,
inserted directly with plain SQL in the test file itself - **no `matches.pg.service.js` exists**,
no business rules were ported) purely to prove the `position` pattern on real tables, not a
throwaway one. This is explicitly scoped and documented, not silently expanded.

##### What was verified (Categories + Products)

`server/services/categories.pg.service.js` and `products.pg.service.js` - standalone, not wired
into any route, reusing `db/rowMappers.js` throughout:
- **Create and read**, a category then a product in it; re-read matches what was returned.
- **Foreign key**: an unknown `category_id` is refused with the *same* message and status
  `products.service.js` already gives ("Category does not exist", 400) - not a raw SQL error -
  and a genuinely malformed id is refused cleanly too.
- **Unique constraints**: a duplicate category name (case/space-insensitive) → 409; the same
  product name twice in **one** category → 409; the same name in a **different** category → fine
  (exactly `products.service.js`'s own rule).
- **Null/missing values**: `trackStock: false` always stores `stockQuantity: 0`; `lowStockLimit`
  defaults to 5 (`models/Product.js`'s `DEFAULT_LOW_STOCK_LIMIT`), matching exactly.
- **Updating**: a category rename and a product price/status change are both stored and
  re-readable.
- **Transaction rollback**: a category insert followed, in the *same* transaction, by a product
  insert that violates a `CHECK` constraint - the category insert is undone too (row count
  unchanged, nothing left behind), proving `withTransaction` rolls back the **whole** transaction,
  not just the statement that failed.
- **Isolation**: neither service's full require tree touches `mongoose` or `server/models/`.

##### What was verified (ordered child rows - `match_players`, `match_teams`)

`server/tests/postgresOrderedRows.test.js`, against real `app.match_players`/`app.match_teams`:
- Four players inserted in a **scrambled** order (seat 3, then 1, then 4, then 2) with `position`
  set to their real order (0-3) - read back `ORDER BY position` gives Alice, Bilal, Charlie, Dee:
  the **intended** order, not the order they were written in. This is the actual claim "ordered
  child rows work" rests on, demonstrated, not assumed.
- `match_players_match_seat_key` (unique per match+seat) and `match_teams_match_number_key`
  (unique per match+team number) both correctly refuse a duplicate.
- `match_teams.seats` (a native `integer[]`, not another child table) round-trips exactly, still
  in `number` order.
- `ON DELETE CASCADE` (step 2.3's design): deleting the match removes its `match_players` and
  `match_teams` rows too - nothing orphaned.

**Still unverified:** `bill_line_items`/`bill_players` (the other two ordered-array tables) were
**not** exercised - they sit behind `bills`, a much larger table with its own partial-unique
constraints (step 2.3). The `position` *mechanism* is now proven on real tables; Bills' own
business rules (payer splits, café-line reshaping) remain for a future, dedicated pilot.

##### Two smaller corrections found while building this step

- `rowMappers.js` gained its own `actorFrom`/`actorUserIdOrNull`, and `settings.pg.service.js`
  was updated to use them: it previously imported `actorFrom` from `models/schemas/actor.js`,
  which itself requires `"mongoose"` (just to define an unused sub-schema) - quietly putting
  MongoDB back into a "mongoose-free" pilot's require chain.
- That gap existed because step 2.4's own isolation test only checked **direct** require
  children, not the full tree - it technically passed while still missing the problem above.
  Rewritten (in `postgresSettings.test.js` too) to walk the entire transitive require tree.

##### A genuine, newly-found concurrency bug (not designed around in advance)

Running this step's new test files **together** with the earlier ones (`postgresMigrations.test.js`,
`postgresSettings.test.js`) produced real failures - `relation "app.settings" does not exist`,
and once, an actual PostgreSQL deadlock (`error code 40P01`, two backend sessions each blocking
the other). Cause, found by testing directly, not assumed: `node --test` runs test **files** in
parallel by default, and several `postgres*.test.js` files each `DROP SCHEMA`/recreate/use the
**same** `app` schema - racing each other.

First fix attempt (a PostgreSQL advisory lock via `pool.query()` for both lock and unlock) **did
not work** and still deadlocked - `pg_advisory_lock`/`unlock` are session-scoped, and a
connection-pool's `.query()` call does not guarantee the same physical connection runs the
matching lock and unlock. Fixed properly in `server/tests/helpers/testDb.pg.js`:
`lockAppSchema(pool)` now checks out and returns **one dedicated client**, held for the test
file's entire run, with `unlockAppSchema(client)` releasing that exact client at the end -
ordinary queries in between still use the pool normally. Verified directly: all five
`postgres*.test.js` files, run together, **three times in a row**, and the full `npm.cmd test`
suite (default parallelism across 300+ files), **twice** - all clean, 0 failures either time.

##### Regression checks

| Command | With PostgreSQL configured | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **348 passed, 0 failed, 0 skipped** (run twice) | 307 passed, 0 failed, **6 skipped** (cleanly - the row-mapper/nameKeyOf unit tests still ran) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) | unaffected either way |

Confirmed: MongoDB remains the application's only active database - no route or controller reads
either new pilot service; every MongoDB-backed test still uses its own throw-away database,
untouched; no production database was touched; nothing was deployed; MongoDB functionality was
not redirected or modified.

##### Remaining relationships, migration risks and open questions

- **Railway's `btree_gist` availability is still unconfirmed** (carried over from step 2.3) -
  unaffected by this step (it didn't touch bookings).
- **`auth_sessions` has no TTL equivalent** (carried over from step 2.3) - still open, Phase 3
  (users/auth) work.
- **`bill_line_items`/`bill_players`** (the other ordered-array tables) remain unverified, as
  above - a future pilot once Bills itself is tackled.
- **Every other foreign key in the schema** (sessions↔bookings and matches↔bills, the two
  deferred-`ALTER TABLE` pairs from step 2.3; `payments→bills`; `stock_movements→products`;
  `cafe_orders→sessions/products/bills`) is still unexercised by any pilot - only
  `products→categories` and `match_players/match_teams→matches` have actually been proven so far.
- **The test-file concurrency fix (advisory lock) only protects the shared `app` schema** across
  this project's own `postgres*.test.js` files - any *future* such test file must also call
  `lockAppSchema`/`unlockAppSchema` (`server/tests/helpers/testDb.pg.js`), or it will race the
  same way these did before the fix.

#### Step 2.6 — Bills repository pilot (the hardest model) — done

**Scope, stated up front:** `server/services/bills.pg.service.js` is a **repository**, not a
port of `bills.service.js`'s business logic. It takes an *already-calculated* bill (the exact
shape `prepareBill()` produces - every number worked out, every snapshot copied) and only saves
or reads it. It does **not** generate bill numbers (`Counter.js`), resolve café tabs, claim
stock, or know Matches' own rules (`loadBillableMatch`, `anotherBillableMatch`) - those each need
their own, still-unported service (Sessions, Matches, Payments, Café), exactly the dependency the
task asked to be documented rather than worked around. What it DOES use for real: **`billing.calculator.js`'s
`calculateBill()` and `billableMinutes()`, unmodified** - a pure function with no MongoDB
dependency at all - so every number this pilot saves is genuinely what the real business rule
would produce for the same input, not invented.

##### Bills field mapping (`server/db/rowMappers.js` conventions, applied to `app.bills`/`bill_line_items`/`bill_players`)

Every field from `Bill.js` maps straight across (full column list: `server/db/migrations/0001_initial_schema.sql`,
written in step 2.3); the pilot only had to decide how to carry them through a repository:
- Money (`unitPrice`, `subtotal`, `taxAmount`, `total`, `amountPaid`, line `unitPrice`/`amount`,
  player `shareAmount`/`paidAmount`/`gameShare`/`cafeShare`) - all through `toMoney` (step 2.4's
  bigint-string fix), confirmed exact for a real calculated total (30 billed minutes × Rs 10 =
  exactly 30000 paisa, verified against `calculateBill()`'s own output, not hand-computed).
- `match`/`matchNumber`/`winningTeam`/`losingTeam`/`pricingType` - absent (`undefined`) on a
  whole-session bill, exactly like a Mongoose document that never had the field, not `null` and
  never `0`.
- `gameShare`/`cafeShare` on a player with no café split - `null`, matching Bill.js's own
  `default: undefined` fields (absent in Mongo, `NULL` here - same meaning, "not applicable").
- `balanceDue` - the schema's `GENERATED ALWAYS AS` column (step 2.3), read back, not recomputed
  here; confirmed equal to `total - amountPaid` for an unpaid bill.
- "Who did it" (`createdBy`/`cancelledBy`) - the same flattened columns and the same
  `user: null, name, username` state (Users not yet ported) as every earlier pilot.

##### What was verified

Against the real local PostgreSQL, using **minimal fixture rows only** (one table, a few
sessions, two matches - inserted with plain SQL in the test file; no Matches/Sessions service
exists):
1. **Create and retrieve**: a bill made from a real `calculateBill()` result round-trips exactly.
2. **Field mapping**: every field above, checked directly.
3. **Line items keep their order**: a game line plus three café lines, inserted via `calculateBill()`'s
   own output order - read back (both from the fresh insert AND a separate re-read from the
   database) as `["Frames", "Cola", "Chips", "Water"]`, never reordered.
4. **Players keep their order**: four players inserted as `["Dee", "Charlie", "Bilal", "Alice"]`
   - read back in that exact order, not alphabetical or insertion-id order.
5. **Monetary/null/missing values**: covered above.
6-7. **Foreign keys**: a real session succeeds; an unknown or malformed `session_id` is refused.
8. **Uniqueness, all three partial indexes from step 2.3, each actually triggered**:
   - a second session-only bill for the same session → *"This session already has a bill"*
   - a duplicate `bill_number` (different session) → *"A bill with this number already exists"*
   - the same match billed twice → *"This match already has a bill"*
   - a second Century (`per_minute`) match bill for a session that already has one → the same
     message `bills.service.js` gives: *"...A session can have only one Century bill."*
9. **Permitted nullable combinations**: a *different* session's session-only bill is unaffected
   by another session already having one - the uniqueness is correctly scoped per session, not global.
10. **Transaction rollback**: a deliberately invalid player (a `result` value the `CHECK`
    constraint refuses) rolls back the **whole** transaction - the bill row and its line items
    from the same attempt are both gone, confirmed by row counts and an orphan check.
11. **Consistency with MongoDB's billing rules**: not re-implemented and compared, but
    **literally the same calculation function** feeding both paths - the numbers can't disagree
    because they come from the one place that decides them.

Isolation: confirmed (no `mongoose`/`server/models/` in the pilot service's full require tree).

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **358 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **7 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) | unaffected either way |

All six `postgres*.test.js` files (now including this one) run together, **three times**, with
no deadlocks or races - the step 2.5 advisory-lock fix holds with a sixth file sharing the schema.

Confirmed: MongoDB remains the application's only active database; no route or controller reads
this pilot; every MongoDB test still uses its own throw-away database, untouched; no production
data was changed; nothing was deployed.

##### Remaining payment/session/match/user dependencies, and other open risks

- **Payments** (the `payments` table, step 2.3) remain completely unexercised - no pilot has
  inserted a `Payment` row yet, so the overpayment-prevention atomic update
  (`payments.service.js`'s `findOneAndUpdate` pattern) has not been reproduced or tested in
  PostgreSQL at all.
- **A real Sessions/Matches service** still does not exist - this and step 2.5 both reached their
  target tables with raw fixture SQL. Porting the actual `sessions.service.js`/`matches.service.js`
  business rules (claim-table atomicity, one-open-session-per-table race test, match number
  generation) is still fully ahead.
- **Users has still not been ported** - every `*_user_id` column across every pilot so far
  (Settings, Categories, Products, Bills) stores `null` for a real actor; this is accepted and
  documented, not a defect, but it means the foreign keys to `app.users` have never been tested
  with an id that actually resolves to a real row.
- **Railway's `btree_gist` availability is still unconfirmed** (carried over from step 2.3) -
  this step didn't touch bookings.
- **`auth_sessions` has no TTL equivalent** (carried over from step 2.3) - still open.
- **Bill number generation** (`Counter.js`'s atomic upsert-and-increment, already designed for
  PostgreSQL in step 2.3's own notes) has not actually been built or tested yet - this pilot's
  tests supply plain string bill numbers directly.

#### Step 2.7 — Payments pilot: real concurrency, no mocks — done

**Scope:** `server/services/payments.pg.service.js` reuses `bills.pg.service.js`'s `mapBillRow`
(step 2.6) rather than inventing a parallel shape - following the established repository
pattern, not a new architecture. It is a standalone pilot: not wired into any route, does not
call and is not called by `payments.service.js` (MongoDB).

**Database guarantees actually implemented - at the transaction/locking level, not an
application-code pre-check:**
- `recordPayment()` runs inside **one** PostgreSQL transaction (`withTransaction`, step 2.2):
  `SELECT ... FOR UPDATE` the bill row, then the player's `bill_players` row - both lock
  immediately, so any other transaction touching the *same* bill or the *same* player row
  **blocks** until this one commits or rolls back. Only once both are locked are the balances
  checked in application code (now guaranteed stable - nothing else can change them underneath),
  and only then are both rows updated and the payment inserted, all before `COMMIT`.
- This is **stronger** than `payments.service.js`'s own approach, not a copy of it:
  MongoDB (without a replica set) can only make ONE document's update atomic, so that service
  saves the `Payment` record as a *separate* step and manually reverses the bill's `$inc` if that
  insert fails. Here, the bill update, the player update and the payment insert are all **one**
  transaction - a failure anywhere rolls back everything together; no compensation logic exists
  or is needed.

**A real bug this step found and fixed, not designed around in advance:** the first version used
two *separate* conditional `UPDATE ... WHERE amount_paid <= total - $1` statements (bill, then
player) - the same idea as `payments.service.js`'s single-document update, just split across two
tables. A real test caught the problem: when the bill's own condition happened to hold but the
player's did not, the bill had *already* been incremented (inside the still-open transaction) by
the time the code tried to explain why the payment was refused - producing a confusing, wrong
balance in the error message (the transaction still rolled back correctly, so no bad data was
ever saved, but the message lied about why). Fixed by locking both rows first and validating
*before* writing anything, as described above.

##### What was verified - with real, simultaneous requests, not mocks

Against the real local PostgreSQL, using bills created by the real `calculateBill()` (step 2.6's
pattern) on minimal fixture rows (no Sessions/Payments-adjacent service exists):
1-2. **Recording and retrieving**: a payment is saved, returned, and listed for its bill.
3. **Bill association / foreign key**: an unknown bill → `"Bill not found"` (404), the same
   message `payments.service.js` gives.
4. **Payer validation**: a name that isn't one of the bill's players → 400; a player with a
   zero share (set directly to test this exact case) → *"doesn't owe anything"* (409).
5. **Amount validation**: `0` and a negative amount are both refused cleanly (the schema's own
   `CHECK (amount >= 1)`, step 2.3, surfaced as a normal rejection, not a raw SQL error leaking out).
6. **Partial payments and full payment**: two partial payments from one player reach their exact
   share and the bill correctly stays `partially_paid` until the *other* player also pays in
   full, at which point it becomes `paid` with `balanceDue: 0`.
7. **Overpayment refused, at both levels**: one paisa over a player's own share → *"only owes
   Rs 0.00 more"* (exact remaining balance, not a rounded figure); a further payment after a
   player's own share is fully paid → the same; a payment after the bill itself is fully paid →
   *"already fully paid"*.
8. **Concurrent payments on the SAME bill - the actual overpayment-prevention proof**: 5
   *simultaneous* (`Promise.allSettled`, real parallel requests, not sequential awaits) attempts
   of Rs 90 each against a Rs 300 bill (mathematically, at most 3 can fit: 3 × 90 = 270 ≤ 300, a
   4th would need ≤ 30 remaining). Result: **exactly 3 succeeded, 2 were refused with 409** - and,
   critically, the number of `payments` rows actually in the database (3), their sum (27000), the
   bill's own `amount_paid` (27000) and the player's own `paid_amount` (27000) **all agree
   exactly** - nothing over-counted, nothing lost, nothing desynced.
9. **Two different players paying concurrently on the same bill** don't interfere with each
   other - both succeed, the bill correctly reaches `paid` with the exact combined total.
10. **Transaction rollback**: an invalid payment method (the schema's `CHECK` on `method`, step
    2.3) rolls back the *entire* attempt - the bill's `amount_paid`, the player's `paid_amount`
    and the payment row count are all confirmed unchanged afterward, not just "probably fine."
11. **Cancelled bills** refuse any payment, matching `payments.service.js`.
- **Idempotency**: `models/Payment.js` defines **no idempotency key or mechanism** - per the
  task's own instruction, this was therefore *not* built or tested as a database guarantee; a
  test instead confirms two identical requests are recorded as two separate payments, which is
  `payments.service.js`'s own behaviour today too (not a gap this pilot introduced).
- **Isolation**: confirmed (no `mongoose`/`server/models/` in the pilot's full require tree).

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **371 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **8 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) | unaffected either way |

All seven `postgres*.test.js` files (now including this one) run together, **three times**, and
the concurrency test alone run **three times** in isolation - no flakiness, the same 3-succeed/
2-refused outcome every time (deterministic because all five concurrent attempts request the
same amount, so which specific requests "win" the race never changes how many can).

Confirmed: MongoDB remains the application's only active database; no route or controller reads
this pilot; every MongoDB test still uses its own throw-away database, untouched; no production
data was changed; nothing was deployed.

##### Remaining risks and unverified behaviour

- **Users still not ported** - every `*_user_id` across every pilot, including `received_by_user_id`
  here, stores `null` for a real actor (documented since step 2.4, unchanged).
- **A real Sessions/Bookings service still does not exist** - Bookings' `btree_gist` `EXCLUDE`
  constraint (step 2.3) remains unverified against an actual service layer, only against raw SQL
  directly (step 2.3's own test). Railway's `btree_gist` availability is still unconfirmed.
- **`auth_sessions` has no TTL equivalent** - still open (carried over since step 2.3).
- **This pilot's locking fix (`SELECT ... FOR UPDATE`) is specific to Payments** - a future
  Bookings pilot will need its own concurrency-safety design (the `EXCLUDE` constraint, not this
  pattern), not an assumption that this same fix applies there unchanged.

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
- [x] Phase 2, Step 2.3 — full schema (20 tables) + migration runner, tested against the real local PostgreSQL (312 server / 780 browser with it configured; 9 new tests, 0 skipped); Railway `btree_gist` still unconfirmed
- [x] Phase 2, Step 2.4 — row-mapper layer + standalone Settings service pilot, tested against the real local PostgreSQL (328 server / 780 browser with it configured, 16 new tests, 0 skipped); found and fixed a real actor-mapping edge case; the Users FK gap is documented, not worked around
- [x] Phase 2, Step 2.5 — Categories/Products (real FK + unique constraints) + match_players/match_teams fixture-only ordered-row proof (348 server / 780 browser with PostgreSQL configured, 19 new tests, 0 skipped); found and fixed a genuine test-concurrency bug (shared schema raced across parallel test files - advisory lock with a dedicated client)
- [x] Phase 2, Step 2.6 — Bills repository pilot: ordered line items/players, all three partial-unique rules, FK, rollback, real calculateBill() numbers (358 server / 780 browser with PostgreSQL configured, 10 new tests, 0 skipped); confirmed the step 2.5 lock fix holds with a sixth test file
- [x] Phase 2, Step 2.7 — Payments pilot: SELECT...FOR UPDATE locking, overpayment prevention proven with 5 real concurrent requests, transaction rollback (371 server / 780 browser with PostgreSQL configured, 13 new tests, 0 skipped); found and fixed a real ordering bug in the first locking design
- [ ] Phase 2, Step 2.8 — Bookings (the btree_gist EXCLUDE constraint against a real service) or Users, per the Phase 3 order above
- [ ] Phase 3 — Services ported
- [ ] Phase 4 — Tests + Mongo import verified
- [ ] Phase 5 — Live on Railway + Vercel, verified
