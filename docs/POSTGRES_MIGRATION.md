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

#### Step 2.8 — Users + AuthSession pilot: the first real foreign keys to real users — done

**Scope chosen:** Users (per the Phase 3 order's own position - second, right after Settings) plus
a small, independent AuthSession create/read/revoke pilot, since it is what finally lets every
earlier pilot's `*_user_id` column point at something real (the step 2.7 "remaining risks" gap).
Neither is wired into any route. Login, logout, cookies and `auth.service.js`/the auth middleware
are **completely untouched** - nothing in this step changes how anyone actually logs in today.

##### Users (`server/services/users.pg.service.js`)

- **Reused, not re-implemented**: `server/utils/password.js`'s real `hashPassword`/`verifyPassword`/
  `passwordProblem` (Node's built-in scrypt) - the exact same algorithm the live app uses, not a
  new one. `normalizeUsername` and the username format rule are small local copies of `models/User.js`'s
  own (not an import of that file, which requires `"mongoose"` - the same isolation reason every
  earlier pilot's `nameKeyOf`/`actorFrom` copies exist for).
- **Implemented**: create, get-by-id, get-by-username, update (name/role/active) with the exact
  same last-admin and self-protection rules as `users.service.js` - but using a **real PostgreSQL
  transaction** instead of Mongo's "save, check, revert-and-resave": if demoting/deactivating a
  user would leave zero active admins, the *whole* transaction rolls back (nothing is ever
  half-applied, let alone written and then undone).
- **Explicitly out of scope** (recorded, not silently dropped): `setPassword`, `createFirstAdmin`,
  `resetAdminPassword` - admin-password-reset-specific flows, not needed for this pilot's narrow
  goal of "establish real user records and the relationships other pilots need."

##### AuthSession (`server/services/authSessions.pg.service.js`)

Deliberately minimal, exactly as the task allowed: **create / read-by-token-hash / revoke only**.
No TTL cleanup job (still an open item, unchanged from step 2.3's own note - MongoDB's TTL index
has no PostgreSQL equivalent). `app.auth_sessions.user_id` is the **one** `*_user_id` column in
the whole schema that is `NOT NULL` - every other one is a nullable "who did it" copy - so this
pilot is what actually proves that constraint for the first time.

##### What was verified - against the real local PostgreSQL

1. **Create and retrieve**, by id and by (normalized) username - `"  ADMIN.ONE  "` finds the same
   row `"admin.one"` was stored as.
2. **Password hash security**: the raw column (read directly, bypassing the service entirely) is
   in the exact `scrypt$16384$8$1$...` format `server/utils/password.js` writes - confirmed
   verifiable with the real, unmodified `verifyPassword()` (accepts the real password, rejects a
   wrong one) - and confirmed **never** present on anything the service itself returns, because
   `getUserById`'s own `SELECT` doesn't name that column at all, not merely filtered out after.
3. **Unique username**, case/space-insensitive: a duplicate is refused (409) and the original row
   is confirmed unchanged - exactly one row with that username, never two.
4. **Invalid ids, missing users, invalid role, weak password**: all refused cleanly (404/400),
   never a raw SQL or crash.
5. **A real foreign key, for the first time**: admin1 creates admin2 - `created_by_user_id`
   genuinely resolves to admin1's row, confirmed with an actual SQL `JOIN`, not just "not null."
6. **Updating** permitted fields works normally with two active admins.
7. **Self-protection**: can't deactivate your own account; can't remove your own admin role.
8. **Transaction rollback, the real guarantee**: with admin2 demoted to staff, admin1 is the
   *only* active admin - a different actor (admin2) trying to demote admin1 is refused
   (*"last active admin"*), and admin1's role **and** `updatedBy` are both confirmed completely
   unchanged afterward (the attempt never touched the row at all).
9-10. **AuthSession**: create → read-by-token-hash → revoke (gone afterward); the `NOT NULL`
   foreign key correctly refuses a non-existent and a `null` user id.
11. **Closes step 2.7's own documented gap**: a bill is created (minimal fixture, as every earlier
    Bills/Payments test), and a payment is recorded with admin1 - a **real** user - as the actor.
    `payment.receivedBy.user` is now admin1's real id (never `null`, for the first time across
    every pilot), confirmed again with a `JOIN`. A non-existent user id is still correctly refused
    by the same foreign key, unchanged from step 2.7 - **no code in `payments.pg.service.js` or
    `bills.pg.service.js` was changed** to make this work; it already supported a real id
    correctly, there simply was no real user to try it with until now.
- **Isolation**: confirmed for both new services (no `mongoose`/`server/models/` in their full require trees).

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **384 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **9 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All eight `postgres*.test.js` files (now including this one) run together, **three times** - no
deadlocks or races (the step 2.5 advisory-lock fix holds with an eighth file). This file alone
run **three times** in isolation too - the same 13/13 result every time.

Confirmed: MongoDB remains the application's only active database; login, logout and the auth
middleware are unchanged; no route or controller reads either new pilot; every MongoDB test still
uses its own throw-away database, untouched; no production data was changed; nothing was deployed.

##### Unverified behaviour and remaining risks

- **`setPassword`/admin-password-reset flows** were not built (explicitly out of scope above) -
  a future step if Users is ever fully cut over in Phase 3.
- **AuthSession TTL cleanup** - still not built, still open since step 2.3.
- **Login itself has not moved** - this step proves the *data layer* (real users, real sessions,
  real password hashes) works; the actual login/cookie/middleware flow is Phase 3 work, untouched here.
- **A real Sessions/Bookings service still does not exist** - Bookings' `btree_gist` constraint
  remains verified only against raw SQL (step 2.3), not a real service. Railway's `btree_gist`
  availability is still unconfirmed.
- **Only Settings, Categories/Products, Bills, Payments and now Users/AuthSession have ANY
  PostgreSQL pilot** - Tables, Sessions, Matches and Customers have only ever been touched by
  bare SQL fixture rows in tests (no repository of their own); Player, CafeOrder, StockMovement
  and Counter have **never** been touched by anything in Phase 2 at all.

#### Step 2.9 — Bookings pilot: the real EXCLUDE overlap guarantee against a real service — done

**Railway compatibility check (done first, as required):** no Railway project exists yet for this
app - no `railway` CLI on PATH, no `.railway` directory, no `RAILWAY_*` environment variables, and
`client/vercel.json`'s backend rewrite still holds the literal placeholder `<RAILWAY_BACKEND_URL>`.
This is not "unsafe to check" - there is genuinely nothing to check yet. **No compatibility result
is claimed.** Manual verification steps for whenever a Railway PostgreSQL service is actually
provisioned:

1. `railway connect postgres` (or copy `DATABASE_URL` from the Railway dashboard) and run
   `SELECT version();` - confirm it is PostgreSQL 13 or newer (required for `gen_random_uuid()`
   without an extra extension; the local dev database is 18.6, Railway's managed image is commonly
   15/16/17 at the time of writing, all of which qualify).
2. `SELECT * FROM pg_available_extensions WHERE name = 'btree_gist';` - confirm it is **listed**
   (availability), then `CREATE EXTENSION IF NOT EXISTS btree_gist;` on the actual Railway database
   and re-run `\dx` - confirm it is **installed** (Railway's managed PostgreSQL permits
   superuser-free extension creation for the common ones, including `btree_gist`, but this must be
   confirmed on the real instance, not assumed from that general reputation).
3. If either check fails, stop before running `0001_initial_schema.sql` against Railway and report
   back rather than altering the schema to work around it.

Re-confirmed locally before relying on them again (same discipline as every earlier step - a past
confirmation is never assumed to still hold): local PostgreSQL is still 18.6, `btree_gist` 1.8 is
still installed in the local dev/test setup.

##### Bookings (`server/services/bookings.pg.service.js`)

Standalone pilot, not wired into any route; does not call and is not called by the MongoDB
`server/services/bookings.service.js`, which remains the application's only active booking path.

- **Reused, unmodified**: `server/utils/time.js`'s `zonedDateTimeToUtc` for the same club-timezone
  date/time semantics `bookings.service.js` itself uses. `BOOKING_STATUSES`/`ACTIVE_BOOKING_STATUSES`
  are small local copies of `models/Booking.js`'s own (not an import of that file, which requires
  `"mongoose"` - the same isolation reason every earlier pilot's small local copies exist for).
- **Implemented**: create, get-by-id, update (reschedule/change table), confirm (pending→confirmed),
  cancel - the same rules `bookings.service.js` enforces (not in the past, at most 60 days ahead,
  end time after start time, only pending/confirmed bookings can be rescheduled or cancelled,
  cancelling frees the slot immediately).
- **The one genuinely different guarantee**: `bookings.service.js` has no database transactions, so
  it documents its own accepted gap - check for a clash before saving, save anyway, check again
  after, and whichever of two racing requests loses deletes its own row. The schema's
  `bookings_no_overlap` EXCLUDE USING gist constraint (committed already in step 2.3, but never
  tested against a real service until now) makes an overlapping INSERT **or** UPDATE simply
  impossible at the database level - there is no window, however brief, where two overlapping
  active bookings can exist, and no "loser deletes itself" step is needed because the losing
  attempt never succeeds at all. The schema was adequate as committed; no schema change was needed
  for this step.

##### What was verified - against the real local PostgreSQL

1. **Create and retrieve** a booking; re-read matches exactly what was returned on creation.
2. **Non-overlapping bookings on the same table** are both accepted, including a booking that
   starts exactly when another ends (touching, not overlapping, is fine - same rule as MongoDB).
3. **An overlapping booking on the same table is refused by the database itself** - a 409 with the
   same `"Table <n> is already booked HH:MM–HH:MM (<name>)"` message `bookings.service.js` produces,
   and confirmed with a direct `COUNT(*)` that the refused attempt left no row behind at all.
4. **The identical time slot on a different table** is accepted without issue.
5. **Invalid inputs refused cleanly**: a past date (`resolveTimes` throws synchronously, confirmed
   with `assert.throws`), a non-existent table id (404 "Table not found"), a non-existent customer
   id (404 "Customer not found"), and a zero-length booking (refused by the schema's own
   `end_at > start_at` CHECK constraint).
6. **Update**: rescheduling into a slot that clashes on another table is refused (409, same clash
   message); rescheduling into a genuinely free slot succeeds.
7. **Cancellation frees the slot immediately**: a second booking for the exact same freed slot
   succeeds right after cancelling the first; cancelling an already-cancelled booking is refused
   (409 "already cancelled").
8. **Confirm**: pending → confirmed succeeds once, a second attempt is refused (409 "already
   confirmed").
9. **Real concurrency - 6 genuinely simultaneous `createBooking` calls for the identical table and
   time slot** (`Promise.allSettled`, no mocks, no artificial delay): **exactly 1 succeeded, 5 were
   rejected with 409**, and a direct `COUNT(*)` against the database confirmed **exactly 1 row was
   actually committed** - decided by the database's own EXCLUDE constraint, not by any
   check-then-insert logic in the service.
10. **Real concurrency - 3 simultaneous `createBooking` calls on 3 different tables, same time
    slot**: all 3 succeeded, proving the constraint's lock is per-table (via the `table_id` in the
    GiST index), not a broad lock that would have serialized unrelated tables.
11. **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
    tree, checked recursively).

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **396 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **10 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All nine `postgres*.test.js` files (now including this one) run together, **three times** - no
deadlocks or races (the step 2.5 advisory-lock fix holds with a ninth file). This file alone run
**three times** in isolation too - the same 11/11 result every time. After every run, the test
database (`snooker_club_pro_test`) was confirmed left clean - no `app` schema, no leftover tables.

Confirmed: MongoDB remains the application's only active database; `bookings.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB test
still uses its own throw-away database, untouched; no production data was changed; nothing was
deployed; no Railway environment was touched (none exists to touch).

##### Unverified behaviour and remaining risks

- **Railway's PostgreSQL version and `btree_gist` availability remain genuinely unconfirmed** - no
  Railway project exists for this app yet. The manual verification steps above must be run once one
  is provisioned, before Phase 3 relies on this constraint in production.
- **A real Sessions service still does not exist** - the Bookings pilot's fixture rows reference
  `app.tables` and `app.customers` directly; `app.sessions`'s own FK relationship to bookings
  (deferred constraint, step 2.3) has still only ever been exercised by raw SQL, not a service.
- **Login/cookie/middleware flow, and the booking routes/controller themselves, are untouched** -
  this step proves the data-layer guarantee only; wiring Bookings into the actual app is Phase 3 work.
- **Tables, Matches and Customers still have no PostgreSQL pilot of their own** - only fixture rows
  in tests, same as before this step. CafeOrder, StockMovement, Player and Counter remain completely
  untouched by Phase 2.

#### Step 2.10 — Tables pilot: the one model every earlier pilot only ever fixtured — done

**Scope chosen:** a standalone Tables repository, following the same `*.pg.service.js` pattern as
every earlier pilot. Every prior pilot (Sessions fixture rows in step 2.5, Bookings in step 2.9,
Bills/Payments) has inserted raw `app.tables` fixture rows directly, but no pilot had its own CRUD
or business-rule service until now. Not wired into any route; does not call and is not called by
`server/services/tables.service.js` (MongoDB), which stays the application's only active path.

##### Tables (`server/services/tables.pg.service.js`)

- **No actor columns at all** - `app.tables` (step 2.3's schema) never recorded who created or
  changed a table, matching `models/Table.js` itself, which also never tracked this. Simpler than
  Settings/Categories for that reason, not an oversight.
- **Implemented**: create, get-by-id, get-by-number, list (status filter; name search,
  case-insensitive; or exact table number when the search text is all digits - the same two
  conditions `tables.service.js`'s own `listTables` checks), summary (counts grouped by status,
  plus a total), update (name/rate/number/status), delete (with the same three safety checks
  `tables.service.js` enforces).
- **Status validation added explicitly, not left to the schema's CHECK constraint alone**: an
  unrecognised status (e.g. `"closed"`) is refused with the same 400 message
  `tables.service.js`'s own Mongoose enum validation gives, before any `INSERT`/`UPDATE` is even
  attempted - matching the existing service's behaviour rather than letting a raw `23514` leak
  through.
- **"Occupied" still belongs to sessions**: while a session is open on a table
  (`app.sessions.is_open`, the real `sessions_one_open_per_table` partial-unique index from step
  2.3), the status can't be changed by hand - the same rule `tables.service.js`'s `updateTable`
  enforces, checked here against a real `app.sessions` row instead of a Mongo count.
- **Deletion restrictions preserved exactly**: occupied status, an open session, or an upcoming
  (pending/confirmed, not yet ended) booking all refuse the delete with the same message shape as
  `tables.service.js`'s own `deleteTable`. These application-level checks sit **on top of**, not
  instead of, a real database guarantee: `app.sessions.table_id` and `app.bookings.table_id`
  reference `app.tables(id)` with no `ON DELETE CASCADE` declared (step 2.3) - the default
  `RESTRICT` - so even bypassing the application check entirely, the database itself refuses the
  `DELETE` outright (`23503`, confirmed directly).

##### What was verified - against the real local PostgreSQL

1. **Create and retrieve**, by id and by table number.
2. **Unique table numbers**: a duplicate is refused (409) and confirmed, by direct `COUNT(*)`,
   that the original row is untouched and no second row was ever inserted.
3. **Invalid table numbers (0, 1000) and rates (negative, above the maximum)** are refused by the
   schema's own `CHECK` constraints.
4. **Valid and invalid statuses**: `"reserved"` accepted; `"closed"` refused (400) *before* any
   `INSERT` is attempted, confirmed with a `COUNT(*)` showing nothing was tried.
5. **Updating**: name/rate change freely; renumbering into an already-taken number is refused
   (409) with the original number confirmed unchanged; renumbering into a free number succeeds.
6. **Status locked while a session is open**: changing status while `is_open` is refused (409,
   "active session"); name/rate changes are still allowed during the same open session (only
   status is blocked, matching the existing rule precisely).
7. **Foreign-key compatibility**: a real `app.bookings` row referencing this table's id inserts
   cleanly - the same relationship the Bookings pilot (step 2.9) already exercises, now proven
   from the Tables side too.
8. **Deletion restrictions**: occupied status (409 "currently occupied"); an upcoming booking
   (409 "upcoming booking(s)"); and, bypassing the service layer entirely, a raw SQL `DELETE`
   against a table with a dependent booking is refused by the database itself (`23503`) - the
   real guarantee underneath the application-level message. A table with none of these is deleted
   successfully and confirmed gone (404 on a subsequent lookup).
9. **`listTables`**: status filter; number search; case-insensitive name search; default ordering
   by table number ascending - all matching `tables.service.js`'s own behaviour.
10. **`getTableSummary`**: grouped counts plus total, cross-checked against a direct `listTables()`
    count per status.
11. **Transaction rollback, the real guarantee**: inside one `withTransaction`, an `UPDATE` is
    applied and then a second statement fails on a duplicate table number - the whole transaction
    rolls back, and the row is confirmed completely unchanged afterward (the `UPDATE` never stuck,
    even though it ran and succeeded before the later statement failed).
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 schema (unique index on
`table_number`, the two `CHECK` constraints, the default-`RESTRICT` foreign keys from
`app.sessions`/`app.bookings`) was already adequate for every rule above.

##### Regression checks

| Command | With PostgreSQL configured (run 3x) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **409 passed, 0 failed, 0 skipped** (2 of 3 runs); 1 run had a single, pre-existing, unrelated MongoDB test fail (`bookings.test.js`'s own concurrency test, nothing to do with this step - re-run in isolation 4x, passed 4/4; the full suite re-run immediately after also passed 409/409 clean) | 307 passed, 0 failed, **11 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All ten `postgres*.test.js` files (now including this one) run together, **three times** - 109/109
every time, no deadlocks or races (the step 2.5 advisory-lock fix holds with a tenth file). This
file alone run **three times** in isolation too - the same 13/13 result every time. After every
run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app` schema, no
leftover tables.

Confirmed: MongoDB remains the application's only active database; `tables.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB
test still uses its own throw-away database, untouched; no production data was changed; nothing
was deployed.

##### Unverified behaviour and remaining risks

- **The one flaky MongoDB test noted above** (`bookings.test.js`'s "10 people book the same slot"
  concurrency test) is a pre-existing timing sensitivity in that test's own design (no database
  transactions in MongoDB's booking path, by the same documented accepted gap step 2.9's own
  comments describe) - it is unrelated to this step's Tables pilot and was not introduced by it,
  but it has not been separately fixed or investigated further here (out of this step's scope).
- **Customers and Sessions still have no PostgreSQL pilot of their own** - only fixture rows in
  tests, same as before this step (explicitly out of scope per this step's safety rules).
- **Login/cookie/middleware flow, and the tables routes/controller themselves, are untouched** -
  this step proves the data-layer rules only; wiring Tables into the actual app is Phase 3 work.
- **Players, CafeOrder, StockMovement, Matches and Counter still have no PostgreSQL pilot** -
  completely untouched by Phase 2 so far.

#### Step 2.11 — Customers pilot: search, pagination, archive-not-delete — done

**Scope chosen:** a standalone Customers repository, following the same `*.pg.service.js`
pattern as every earlier pilot. Not wired into any route; does not call and is not called by
`server/services/customers.service.js` (MongoDB), which stays the application's only active path.

##### Customers (`server/services/customers.pg.service.js`)

- **No actor columns, no uniqueness on phone** - `app.customers` (step 2.3's schema) matches
  `models/Customer.js` exactly: no "who did it" tracking, and phone is deliberately **not**
  unique (`models/Customer.js`'s own comment: "family members may share one number"). No unique
  check was added here either - that would have contradicted an explicit, documented rule.
- **Length rules enforced in code, not by a CHECK constraint**: name (2-60 chars), phone (≤20
  chars), notes (≤200 chars) - `customers.service.js`'s own Mongoose schema limits, with no
  matching database constraint in step 2.3's schema. Validated here the same way step 2.10's
  Tables pilot validates its status enum in code rather than letting a raw constraint error leak
  through.
- **Implemented**: create, get-by-id, update (partial, `phoneDigits` kept in step with a changed
  `phone` the same way `models/Customer.js`'s own `pre("validate")` hook does), list/search (name,
  case-insensitive; or phone digits when the search text has ≥3 digits - the same two conditions
  `customers.service.js`'s own `searchFilter` checks), pagination, archived-customer filtering,
  and a real per-customer booking count + last-booking date computed with a SQL aggregate against
  `app.bookings` (step 2.9's own table) in place of Mongo's separate aggregation pipeline. Delete:
  no bookings → really deleted; has bookings → archived (`is_active = false`, booking history
  stays complete) - the exact rule `customers.service.js`'s own `deleteCustomer` enforces.
- **Explicitly out of scope** (recorded, not silently dropped): `getCustomerWithHistory` -
  `customers.service.js`'s full profile view, which joins booking history with session info; a
  report-like read, not a repository operation, and not required by this step's narrow goal.

##### What was verified - against the real local PostgreSQL

1. **Create and retrieve**: name trimmed, `phoneDigits` correctly derived from `phone`.
2. **Invalid input refused cleanly** (400, before any `INSERT` is attempted): name below 2 or
   above 60 characters, phone above 20 characters, notes above 200 characters - confirmed with a
   `COUNT(*)` that none of the refused attempts left a row behind.
3. **Phone is genuinely not unique**: two different customers created with the identical phone
   number both succeed, as the existing rule requires.
4. **Missing customer id** refused with 404, for both a read and an update.
5. **Update**: a partial change (phone + notes) applies without touching the untouched name field;
   `phoneDigits` stays in step with the new phone; a refused update (name too short) leaves the
   row completely unchanged.
6. **List/search**: name search (case-insensitive), phone-digit search, default archived-hidden
   behaviour, `includeArchived` adding exactly the expected row, and pagination (two pages of 2
   return disjoint customer ids, `totalPages` matches the real count).
7. **Real booking stats**: two real `app.bookings` rows inserted for one customer - `listCustomers`
   reports `bookingCount: 2` and the later of the two `start_at` values as `lastBookingAt`,
   computed by an actual SQL aggregate, not a canned value.
8. **Delete**: a customer with no bookings is really deleted (404 afterward); a customer with real
   bookings (from test 7) is archived instead (`isActive: false`, row still exists).
9. **The real foreign key backs this up**: bypassing the service entirely, a raw SQL `DELETE`
   against the same customer-with-bookings is refused by the database itself (`23503`,
   `app.bookings.customer_id REFERENCES app.customers(id)`, no `ON DELETE CASCADE` declared in
   step 2.3) - the archive rule is not the only thing preventing data loss here.
10. **Transaction rollback, the real guarantee**: inside one `withTransaction`, a real `UPDATE`
    runs and succeeds, then a second statement fails (duplicate primary key) - the whole
    transaction rolls back, and the row is confirmed completely unchanged afterward.
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 schema (no unique index on phone, by
design; the default-`RESTRICT` foreign key from `app.bookings`) was already adequate for every
rule above.

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **421 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **12 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All eleven `postgres*.test.js` files (now including this one) run together, **three times** -
121/121 every time, no deadlocks or races (the step 2.5 advisory-lock fix holds with an eleventh
file). This file alone run **three times** in isolation too - the same 12/12 result every time.
After every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables. No unrelated failure occurred during this step's verification (unlike
step 2.10's one observed flaky MongoDB test, not seen again here).

Confirmed: MongoDB remains the application's only active database; `customers.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB
test still uses its own throw-away database, untouched; no production data was changed; nothing
was deployed.

##### Unverified behaviour and remaining risks

- **`getCustomerWithHistory`** was not built (explicitly out of scope above) - a report-like,
  multi-table join view; a future step if Customers is ever fully cut over in Phase 3.
- **Login/cookie/middleware flow, and the customers routes/controller themselves, are untouched** -
  this step proves the data-layer rules only; wiring Customers into the actual app is Phase 3 work.
- **Sessions still has no PostgreSQL pilot of its own** - only fixture rows in tests, same as
  before this step (explicitly out of scope per this step's safety rules).
- **Players, CafeOrder, StockMovement, Matches and Counter still have no PostgreSQL pilot** -
  completely untouched by Phase 2 so far.

#### Step 2.12 — Sessions pilot: starting and ending a session in one real transaction — done

**Scope chosen:** a standalone Sessions repository, following the same `*.pg.service.js` pattern
as every earlier pilot. Not wired into any route; does not call and is not called by
`server/services/sessions.service.js` (MongoDB), which stays the application's only active path.

##### Sessions (`server/services/sessions.pg.service.js`)

- **Reused, unmodified**: `server/utils/time.js`'s `secondsBetween`/`startOfDayInTimeZone`/
  `startOfNextDayInTimeZone` (pure, no mongoose) - the exact same duration and club-local day
  boundary rules `sessions.service.js` itself uses.
- **Implemented**: start (claim an available table + create the session), end (close an open
  session, compute its real duration, free the table), get-by-id, list active sessions, count
  active sessions, `hasOpenSession`, and a history list (status filter, club-local date range,
  table name/number search, pagination) - the same rules `sessions.service.js`'s own functions
  enforce.
- **The one genuinely different guarantee**: `sessions.service.js` has no database transactions,
  so starting a session is a documented two-step dance - claim the table with one atomic
  conditional update, create the session, and if *that* insert ever fails (the unique
  open-session index as a safety net), manually release the table back to its previous status as
  a separate compensating step. Here, claiming the table and creating the session happen inside
  **one real PostgreSQL transaction**: if the `INSERT` fails for any reason - including the
  `sessions_one_open_per_table` unique partial index (committed already in step 2.3, but never
  exercised by a real service until now) - the table's `UPDATE` rolls back automatically with it.
  There is no manual "release" step and no window where a table could ever be left claimed
  without a session, however briefly. Ending a session and freeing its table are likewise one
  transaction, not two independent writes.
- **Explicitly out of scope** (recorded, not invented): `listSessions`'s own bill/match joins -
  `sessions.service.js` loads `bills.service.js` and `matches.service.js` for this, and neither
  has a PostgreSQL pilot of its own yet; pulling either in here would be well beyond this step's
  narrow goal. This pilot's `listSessions` returns sessions only.

##### What was verified - against the real local PostgreSQL

1. **Start a session**: claims the table (confirmed `occupied` in the database), creates the
   session with the correct snapshot fields (`tableNumber`, `hourlyRateAtStart`), re-read matches
   exactly what was returned.
2. **Starting on an already-occupied table** is refused (409, "already occupied"), and confirmed
   with a `COUNT(*)` that no second session was created.
3. **A reserved or maintenance table** gives the specific matching reason message; a
   non-existent table id gives 404 - and the reserved/maintenance tables are confirmed left in
   their original status, never touched by the refused attempt.
4. **The real transaction, proven with genuine concurrency, not just reasoned about**: two
   simultaneous `startSession` calls for the identical fresh table - exactly 1 succeeded, 1 was
   refused (409) by the database's own `sessions_one_open_per_table` partial unique index, and
   the table ended up correctly `occupied` by the one session that actually won - never stuck
   claimed-but-sessionless, confirmed by a direct row count.
5. **Ending a session**: computes a real, non-negative duration, frees the table back to
   `available`, confirmed with a direct table-status read; ending the same session again is
   refused (409, "already ended").
6. **Ending a non-existent session** is refused with 404.
7. **`listActiveSessions`/`countActiveSessions`/`hasOpenSession`** reflect real, live state
   before and after starting/ending a session on a fresh table.
8. **`listSessions`**: status filter, table-number/name search, and pagination all behave like
   `sessions.service.js`'s own `listSessions` (minus the explicitly out-of-scope bill/match
   joins).
9. **Foreign-key compatibility**: a real `app.bookings` row's `session_id` can reference this
   session's id; a non-existent session id in that same column is refused by the database
   (`23503`).
10. **Transaction rollback, the real guarantee**: inside one `withTransaction`, a session's
    `UPDATE` (closing it) is applied and then a second statement fails (duplicate primary key) -
    the whole transaction rolls back, and the session is confirmed still genuinely open
    afterward, not half-closed.
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 schema (the
`sessions_one_open_per_table` partial unique index, the `CHECK` constraints, the default-`RESTRICT`
foreign keys) was already adequate for every rule above.

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **433 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **13 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All twelve `postgres*.test.js` files (now including this one) run together, **three times** -
133/133 every time, no deadlocks or races (the step 2.5 advisory-lock fix holds with a twelfth
file). This file alone run **three times** in isolation too - the same 12/12 result every time.
After every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables. No unrelated failure occurred during this step's verification.

Confirmed: MongoDB remains the application's only active database; `sessions.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB
test still uses its own throw-away database, untouched; no production data was changed; nothing
was deployed.

##### Unverified behaviour and remaining risks

- **`listSessions`'s bill/match joins** were not built (explicitly out of scope above) - would
  require Bills and Matches PostgreSQL pilots first; a future step if Sessions is ever fully cut
  over in Phase 3.
- **Login/cookie/middleware flow, and the sessions routes/controller themselves, are untouched** -
  this step proves the data-layer rules only; wiring Sessions into the actual app is Phase 3 work.
- **Checking in a booking to start a session** (the `booking_id` link, Phase 7 per the schema's
  own comment) was not exercised beyond a raw foreign-key insert in test 9 - no real
  "check in" operation exists in `sessions.service.js` itself yet either, so none was invented
  here.
- **Players, CafeOrder, StockMovement, Matches and Counter still have no PostgreSQL pilot** -
  completely untouched by Phase 2 so far.

#### Step 2.13 — Players pilot: duplicate-name rules and the deliberately out-of-scope history — done

**Scope chosen:** a standalone Players repository, following the same `*.pg.service.js` pattern
as every earlier pilot. Not wired into any route; does not call and is not called by
`server/services/players.service.js` (MongoDB), which stays the application's only active path.

##### Players (`server/services/players.pg.service.js`)

- **`nameKeyOf`** is a small, local copy of `models/Category.js`'s own function (the exact rule
  `models/Player.js`'s own `pre("validate")` hook uses) - not an import of it, the same isolation
  reason every earlier pilot's local copies exist for.
- **`nameKey` and `phoneDigits` deliberately left out of the returned shape** -
  `models/Player.js`'s own `toJSON` transform strips both from every response the real app
  sends (internal search/uniqueness helpers, not player data); this pilot matches that exactly.
- **Implemented**: create, get-by-id, update (partial; renaming to the same name with different
  capitals is fine), deactivate/reactivate (`setActive`; a player is **never deleted** - matches
  and bills can always point back to them, exactly as `models/Player.js`'s own header comment
  states), list/search (status filter defaulting to `"active"`, name/phone-digit search,
  pagination, ordered by `name_key`).
- **The one real nuance preserved exactly**: a duplicate-name error's *message* differs depending
  on whether the clashing existing player is active ("already registered") or inactive
  ("already registered (inactive - reactivate them instead)") - the same distinction
  `players.service.js`'s own `duplicateError` makes. This pilot does a pre-check for that
  specific message (reusing the same lookup `createPlayer` and `updatePlayer` both call), with the
  database's own `players_name_key_key` unique index (step 2.3) as the real, final guard -
  verified directly with two genuinely concurrent creates for the identical name below, not just
  reasoned about.
- **No new uniqueness or business rule was introduced** - phone is not unique here either (same
  as Customers, step 2.11), matching the existing model exactly; nothing was added to make this
  pilot look more complete than the real service.

##### Player history - explicitly deferred, not invented

`playerHistory.service.js` (Phase 11.6) builds a player's history by joining `Match` and `Bill`
records (`Player -> Match -> Bill -> Payment`, per its own header comment). **Matches has no real
PostgreSQL repository** - only step 2.5's fixture-only `match_players`/`match_teams` ordered-row
proof exists, not a service with business rules. Building any player-history read here would mean
either fabricating a count/total without a real join, or silently reimplementing Matches'
business rules as a side effect of a Players pilot - both explicitly against this step's
instructions. **Nothing was built**; this gap is recorded as the step's main remaining risk,
unchanged until a real Matches pilot exists.

##### What was verified - against the real local PostgreSQL

1. **Create and retrieve**: name trimmed; `nameKey`/`phoneDigits` confirmed absent from the
   returned object (not just unused - genuinely not present as keys).
2. **Duplicate names refused, case/space-insensitive** ("ALI   khan" collides with "Ali Khan"),
   confirmed with a `COUNT(*)` that the refused duplicate left no row behind; the message changes
   correctly to mention "reactivate them instead" when the clashing player is inactive.
3. **Invalid input refused cleanly**: name below 2 or above 60 characters, phone above 20
   characters, notes above 200 characters.
4. **Missing player id** refused with 404, for both a read and an update.
5. **Update**: a partial change (phone + notes) applies without touching the name; renaming to the
   same name with different capitals succeeds (excludes the player's own row from the duplicate
   check); renaming to a name taken by a *different* player is refused, with the original name
   confirmed unchanged afterward.
6. **Deactivate/reactivate**: `deactivatedAt` is set on deactivation and cleared on reactivation;
   repeating the same state (`"already inactive"`/`"already active"`) is refused.
7. **List/search**: status defaults to active, hides deactivated players unless `status:
   "inactive"` is asked for; name search and phone-digit search; pagination math matches the
   real total.
8. **Real concurrency - 2 genuinely simultaneous `createPlayer` calls for the identical name**
   (different capitalisation/spacing, same `nameKey`, `Promise.allSettled`, no mocks): exactly 1
   succeeded, 1 was refused (409) by the database's own unique index, and a direct `COUNT(*)`
   confirmed exactly 1 row was actually committed.
9. **Foreign-key compatibility**: a real `app.match_players` row (with a real match/session/table
   fixture) referencing this player's id inserts cleanly; a non-existent player id in the same
   column is refused by the database (`23503`); a `NULL` player id (a walk-in player, per the
   schema's own comment) is still accepted, confirming the column's nullability was preserved
   correctly.
10. **Transaction rollback, the real guarantee**: inside one `withTransaction`, an `UPDATE` is
    applied and then a second statement fails (duplicate primary key) - the whole transaction
    rolls back, and the row is confirmed completely unchanged afterward.
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 schema (`players_name_key_key`
unique index, the default-`RESTRICT`-or-nullable foreign keys from `match_players`/`bill_players`)
was already adequate for every rule above.

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **445 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **14 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

All thirteen `postgres*.test.js` files (now including this one) run together, **three times** -
145/145 every time, no deadlocks or races (the step 2.5 advisory-lock fix holds with a thirteenth
file). This file alone run **three times** in isolation too - the same 12/12 result every time.
After every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables. No unrelated failure occurred during this step's verification.

Confirmed: MongoDB remains the application's only active database; `players.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB
test still uses its own throw-away database, untouched; no production data was changed; nothing
was deployed.

##### Unverified behaviour and remaining risks

- **Player history (`playerHistory.service.js`) was not built** (explicitly deferred above) -
  blocked on a real Matches PostgreSQL pilot (and, for bill/payment totals, a Bills/Payments join
  against real match-linked bills), neither of which exists yet in a form this pilot could safely
  join against without fabricating data.
- **Login/cookie/middleware flow, and the players routes/controller themselves, are untouched** -
  this step proves the data-layer rules only; wiring Players into the actual app is Phase 3 work.
- **Matches and CafeOrder/StockMovement still have no PostgreSQL pilot of their own** - step 2.5's
  fixture-only `match_players`/`match_teams` proof remains the only PostgreSQL contact point for
  Matches; Counter remains completely untouched by Phase 2 so far.

#### Step 2.14 — Matches pilot: the session-lock guarantee, player/team rules — done

**Scope chosen:** a standalone Matches repository, following the same `*.pg.service.js` pattern
as every earlier pilot. Not wired into any route; does not call and is not called by
`server/services/matches.service.js` (MongoDB), which stays the application's only active path.

##### Matches (`server/services/matches.pg.service.js`)

- **Reused, unmodified**: `server/config/gameModes.js` (pure config, no mongoose) - the exact same
  player-limit/team/result-type rules `matches.service.js` itself reads from; and
  `server/services/players.pg.service.js`'s own `nameKeyOf` (a PostgreSQL pilot file already, so
  requiring it adds no mongoose to this file's require tree).
- **Implemented**: start (player/team resolution + the atomic per-session match number, all in
  one transaction), update (replace players/teams while `in_progress` only), complete (record a
  winner/loser or a winning team, with every player's own result worked out), cancel, get-by-id,
  list-for-session (players and teams loaded and attached, ordered by seat/number).
- **The one genuinely different guarantee**: `matches.service.js` creates the match FIRST, then
  re-checks whether the session is still open, and **deletes** the just-created match if it
  closed in the meantime - a documented compensating step, because MongoDB gives it no way to
  check-and-create atomically. Here, the session row is locked with `SELECT ... FOR UPDATE`
  **before** anything is created, inside one transaction: a concurrent `endSession`
  (`sessions.pg.service.js`'s own transaction) blocks on that same row until this transaction
  commits or rolls back. There is no window where a match could ever be created on a session that
  has just closed, and no compensating delete exists or is needed. **Proven with genuine
  concurrency** (test 16 below), not just reasoned about.
- **Player/team rules preserved exactly**: player-count limits from the registry; each registered
  player only once and must be active; every name unique (registered or walk-in); team modes
  require every player in exactly one team with exactly the right number of seats; a registered
  player's **current** name is copied at match time, not whatever was typed.

##### Explicitly out of scope - recorded, not invented

- **`listMatchesForSession`'s / `matchSummaryForSessions`'s own bill joins** -
  `matches.service.js` loads `bills.service.js` for this. Deferred the same way step 2.12's
  Sessions pilot deferred its own bill/match joins - joining `bills.pg.service.js` (step 2.6) in
  here would mean reimplementing `matches.service.js`'s billing-adjacent report logic as a side
  effect of a Matches pilot, against this step's own instruction not to.
- **`changeResult`** (changing a completed match's result later) - depends on **both** a Bill
  lookup (`bills.pg.service.js`) **and** `server/config/permissions.js`'s `roleHasPermission` (an
  authorization decision, not a repository concern). Neither dependency belongs inside a
  standalone Matches repository; this operation was not built.

##### A real, pre-existing bug found - not fixed here, reported instead

Repeated test runs (required by this step) surfaced a genuine timing issue in
`sessions.pg.service.js`'s `endSession` (step 2.12, already committed before this step):
`ended_at` is computed with JS's own clock (`new Date()`), while `started_at` comes from
PostgreSQL's `now()` at the session's `INSERT` (transaction-**start** time, not statement time,
per PostgreSQL's own documented behaviour). Calling `startSession` then `endSession` back-to-back
with almost no delay can occasionally make `ended_at` a few milliseconds earlier than
`started_at`, violating the schema's own `sessions_check` CHECK constraint
(`ended_at >= started_at`) - observed directly, not hypothesised: roughly 2 of 3 attempts failed
this way when this step's own Matches test 3 originally chained `startSession`+`endSession` with
no gap. **This is a Sessions pilot issue, not a Matches one, and out of this step's approved
scope to fix** (the task's own strict boundaries: no unrelated refactoring). Test 3 was rewritten
to build its "closed session" fixture directly with SQL instead of a real start-then-end round
trip, sidestepping the issue rather than exercising it. Recorded below as a remaining risk for a
future, dedicated fix (e.g. compute both timestamps from the same clock inside one transaction).

##### What was verified - against the real local PostgreSQL

1. **Start a match** (Century, two walk-ins) on an open session: correct match number (`#1`),
   `in_progress` status, players seated in input order, re-read matches exactly.
2. **A second match on the same session** gets the next number (`#2`) - the atomic per-session
   counter (`app.counters`, the same pattern `models/Counter.js` uses) confirmed correct.
3. **A non-existent session** gives 404; **a closed session** is refused (409, "has ended") and
   confirmed, by `COUNT(*)`, to leave no match behind.
4. **An unknown game mode** is refused (400).
5. **Player-count rules from the registry** are enforced (Snooker Point: exactly 3 players).
6. **Duplicate players refused**: the same registered player twice, or two walk-ins with the same
   name (any capitalisation/spacing).
7. **A registered player must exist and be active**: a non-existent id and a deactivated player
   are both refused with the correct messages.
8. **A registered player's current name is copied**, not a typed one.
9. **Team mode (4 Players)**: exactly 2+2 seats enforced per team; assigning a team on a
   non-team mode is refused with the specific message.
10. **Update**: editing players while `in_progress` works (players replaced, teams recalculated);
    refused once the match is completed.
11. **Complete (player mode)**: the chosen seat's player is marked `winner`, every other player
    `loser`; completing an already-completed match is refused.
12. **Complete (team mode)**: the entire winning team is marked `winner`, the entire losing team
    `loser`; choosing a `winnerSeat` for a team mode is refused with the specific message.
13. **Cancel**: sets status/reason/`cancelledAt`; cannot be cancelled twice, and cannot be
    cancelled once completed.
14. **`listMatchesForSession`**: every match on a session, ordered by number; a non-existent
    session gives 404.
15. **Transaction rollback, the real guarantee**: inside one `withTransaction`, player rows are
    deleted and re-inserted, then a later statement fails (a duplicate seat) - the whole
    transaction rolls back, and the original players are confirmed completely unchanged
    afterward.
16. **Real concurrency, genuinely tested, not just reasoned about**: starting a match and ending
    the same session at the same moment (`Promise.allSettled`, no mocks) - confirmed the outcome
    is always consistent: either the match exists and is really there (`COUNT(*)` = 1), or
    starting it was refused (409) and it left no row behind (`COUNT(*)` = 0); ending the session
    itself always succeeds regardless of which way the race went.
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 schema (`matches_session_number_key`
unique index, `match_players`/`match_teams`'s own seat/number uniqueness, the `ON DELETE CASCADE`
from `match_players`/`match_teams` to `matches`) was already adequate for every rule above.

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **463 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **15 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

This file alone run **five times** in isolation - 18/18 every time (after the test-3 fixture fix
above; before that fix, 2 of 3 runs failed on the Sessions-timing issue described above, not a
Matches defect). All fourteen `postgres*.test.js` files run together, repeated **fourteen times**
in total during this step's verification: **thirteen of fourteen runs were a clean 163/163**; one
run showed 3 failures that did not reproduce in nine further attempts immediately after - reported
honestly here as an observed, currently unreproduced flake rather than claimed as fully resolved.
After every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables.

Confirmed: MongoDB remains the application's only active database; `matches.service.js`, its
routes and controller are unchanged; no route or controller reads the new pilot; every MongoDB
test still uses its own throw-away database, untouched; no production data was changed; nothing
was deployed.

##### Unverified behaviour and remaining risks

- **The Sessions pilot's `endSession` timing issue** (described above) - **fixed as a targeted
  follow-up immediately after this step; see "Step 2.12 timestamp fix" below.**
- **The one, unreproduced multi-file-run flake** (163 vs 160/3 failing, once in fourteen attempts)
  was not root-caused - it did not recur despite focused retries, and no specific failing
  assertion was captured before it stopped reproducing. Flagged for attention if it recurs.
- **`listMatchesForSession`'s bill joins and `changeResult`** were not built (explicitly deferred
  above) - blocked on Bills' billing-report logic and the permissions system respectively, neither
  of which belongs inside a standalone Matches repository.
- **Login/cookie/middleware flow, and the matches routes/controller themselves, are untouched** -
  this step proves the data-layer rules only; wiring Matches into the actual app is Phase 3 work.
- **Player history (`playerHistory.service.js`) remains deferred** (step 2.13's own note) -
  this step's Matches pilot does not change that; a real Matches repository now exists, but the
  join against Bills (also required) is still out of scope here.
- **CafeOrder/StockMovement and Counter still have no PostgreSQL pilot** - completely untouched
  by Phase 2 so far.

#### Step 2.12 timestamp fix — targeted follow-up: `endSession`'s real, found bug — done

**Scope:** a targeted bug fix only, inside the already-committed Sessions pilot
(`server/services/sessions.pg.service.js`, step 2.12). Not Café Orders, not Phase 3, not a new
pilot. No production route, controller or MongoDB code touched; no schema change.

##### Root cause - with evidence

`endSession` computed `ended_at` with JS's own `new Date()`, while `started_at` came from the
`started_at` column's `now()` DEFAULT (set at `startSession`'s `INSERT`). PostgreSQL's `now()`
(and `CURRENT_TIMESTAMP`) is **pinned to transaction-start time**, not statement-execution time -
documented PostgreSQL behaviour, confirmed directly here with
`SELECT clock_timestamp(), now()` run repeatedly inside a transaction (the two values diverge as
soon as any time passes after `BEGIN`). A direct comparison of the Node process clock against
PostgreSQL's own `clock_timestamp()`, run ten times back-to-back, showed negligible skew (0-1ms)
in steady state - ruling out ordinary cross-process clock drift as the cause. The actual trigger
is a **frozen vs. live** mismatch: `started_at` is a value captured once, at transaction start,
and never re-evaluated; `ended_at` was a live JS clock reading taken afterward. Whenever the
system clock is adjusted (an NTP correction, a VM time-sync event) in the gap between the two, the
live reading can end up appearing *earlier* than the frozen one, even though real elapsed time
never went backward. **Reproduced deterministically**, not just inferred: inserting a session with
`started_at` set to `clock_timestamp() + interval '50ms'` (simulating exactly what a frozen value
looks like right after a small backward adjustment), then updating it with a plain live timestamp
for `ended_at`, raised the exact `23514` (`sessions_check`) violation this bug produces. A tight
100-iteration back-to-back start/end loop (no artificial clock manipulation) did **not** reproduce
it - consistent with the root cause being a rare, real clock-adjustment event, not routine
execution speed, matching step 2.14's own observation that this could not be reliably reproduced
on demand.

##### The fix

`endSession`'s `UPDATE` now sets `ended_at = GREATEST(clock_timestamp(), started_at)` and computes
`duration_seconds` from that same, already-clamped value in the same statement -
`EXTRACT(EPOCH FROM (GREATEST(clock_timestamp(), started_at) - started_at))::int`. `clock_timestamp()`
is PostgreSQL's **live** current time, re-evaluated on every call (unlike `now()`); the `GREATEST`
clamp guarantees `ended_at` can never be stored earlier than `started_at`, **for any gap, however
large** - not merely "unlikely to happen again." The `sessions_check` CHECK constraint itself was
**not weakened or removed**; the fix makes it provably impossible to violate from this code path
instead. `duration_seconds` is `0` (never negative) in the clamped case, matching the schema's own
`duration_seconds >= 0` CHECK. The now-unused JS-side `secondsBetween` import was removed from this
file; it is not used anywhere else in it.

Deliberately **not** changed: `startSession`'s own `started_at` (still the column's `now()`
default) - the fix only needed to make `ended_at` safe relative to whatever `started_at` holds,
which the `GREATEST` clamp does unconditionally; changing `startSession` too was unnecessary and
would have been a larger, less targeted change than the bug required.

##### Tests

Two new focused tests added to `server/tests/postgresSessions.test.js`:

- **"6a"**: 50 genuinely rapid, back-to-back start-then-end sequences (no delay) against the
  fixed code - every one confirms `durationSeconds >= 0` and `endedAt >= startedAt`.
- **"6b"**: the exact failure condition, built deterministically (not hoping for a rare clock
  event) - a session with `started_at` set 2 seconds into the "future" via raw SQL, then ended
  through the real `endSession` function. Before the fix this raised `23514` directly (confirmed
  while diagnosing the bug, outside the test file); after the fix it succeeds, with
  `durationSeconds` correctly clamped to `0`.

One existing test (`postgresSessions.test.js`'s own "8. listSessions...") needed a larger
`limit` - it was asserting that a session from early in the test run still appeared on page 1 of
a default-paginated list, which test 6a's own 50 new sessions (newer, so sorted first) pushed off
that page. This is a test-ordering side effect of adding new fixtures in the same file, not a
behaviour change in `listSessions` itself, and was not a hidden workaround for the actual bug.

##### Results

| Command | Result |
|---|---|
| `postgresSessions.test.js` alone, **5 times** | **14/14 every time** (was 12/14 passing with 2 failures before the pagination-limit fix above, unrelated to the timestamp bug itself) |
| `postgresMatches.test.js` alone, **3 times** (uses Sessions internally) | **18/18 every time** - no regression |
| All fifteen `postgres*.test.js` files together, **8 times** | **165/165 every time** - no deadlocks, no recurrence of step 2.14's own one-off multi-file-run flake |
| `npm.cmd test`, PostgreSQL configured | **465 tests, 1 unrelated pre-existing failure** (see below) - not 0, and not claimed as such |
| `npm.cmd test`, unconfigured | 306 passed, 0 failed, 15 skipped, **1 unrelated pre-existing failure** (see below) |
| `npm.cmd run test:browser` | 779 passed, **1 unrelated pre-existing failure** (see below) |

##### Two unrelated, pre-existing failures found during this step's own full-regression run -
##### reported honestly, not fixed (out of this task's explicit scope)

Both `npm.cmd test` runs (configured and unconfigured) and the browser suite showed exactly one
failure each, **neither caused by this fix**:

- `matchBilling.test.js`: *"one session, many match bills: ... (time once)"* - fails
  consistently (confirmed 4/4 in isolation, with **and** without PostgreSQL configured). This
  file has zero code dependency on `sessions.pg.service.js` or any PostgreSQL file (checked by
  grep). Pure MongoDB test.
- Browser suite, `sessions`: *"'Today' filter keeps both"* - fails consistently (3/3 retries).

**Root cause identified precisely for `matchBilling.test.js`, not merely suspected**: its own
`endSession(session, seconds)` test helper backdates the session's `startedAt` directly
(`new Date(Date.now() - seconds * 1000)`, here 50 minutes) to simulate "50 billed minutes
elapsed." The actual system clock when this run executed was `2026-10-12T19:1x:xxZ` UTC - already
`2026-10-13, 00:1x` in `Asia/Karachi` (`CLUB_TIMEZONE`, UTC+5). Subtracting 50 minutes from that
moment lands `startedAt` at roughly `2026-10-12, 23:2x` **club-local time - the previous calendar
day**. The test's own `today = dateInTimeZone(new Date(), "Asia/Karachi")` then queries
`/reports/tables?from=${today}&to=${today}` for *only* the 13th, which correctly finds nothing for
a session whose club-local start time was genuinely the 12th - hence the all-zero result. This is
a test-environment-timing coincidence (the test was written assuming it would never run within 50
minutes of a club-local midnight), with **zero connection to PostgreSQL, Sessions, or this fix** -
it would fail identically on the unmodified `347fbef` commit at this exact real-world moment. The
browser suite's `sessions` "'Today' filter keeps both" failure, observed at the same real-world
moment, is consistent with the same class of day-boundary issue, though its exact mechanism was
not traced statement-by-statement the way `matchBilling.test.js`'s was. **Neither was fixed**, per
this task's explicit boundary against unrelated changes; both are expected to pass again once
re-run safely clear of a club-local midnight boundary.

Confirmed: MongoDB remains the application's only active database; no production route,
controller or MongoDB service was touched; no production data was changed; nothing was deployed;
`startSession`'s table-claiming transaction, rollback guarantees, and table-release behaviour are
all unchanged and still pass every existing test.

#### Step 2.15 — CafeOrders/StockMovements pilot: the row-lock guarantee for tab reservations — done

**Scope chosen:** two standalone repositories, following the same `*.pg.service.js` pattern as
every earlier pilot. Neither is wired into any route; neither calls, nor is called by,
`server/services/cafeOrders.service.js`/`stock.service.js` (MongoDB), which stay the
application's only active path.

##### CafeOrders (`server/services/cafeOrders.pg.service.js`)

- **Implemented**: `addItem`, `updateItem`, `removeItem`, `listItems`, `openItemsForSession`,
  `openTabQuantities` - the same tab lifecycle `cafeOrders.service.js` enforces: a snapshot of
  table number / product name / category name / unit price taken at add time (never changed by a
  later price edit); `product_id = NULL` for typed-in items; quantity 1-99, description/consumer
  ≤60 characters (enforced in code - no matching CHECK constraint in the schema, same pattern
  earlier pilots use for their own uncommitted-to-schema rules); only `open` items can be changed
  or removed; removed items kept for history, excluded from `listItems`'s own read; the tab locks
  once a **whole-session** bill exists (`match_id IS NULL`), but a real match bill
  (`match_id NOT NULL`) does **not** close it - verified against a real `app.matches`/`app.bills`
  fixture, not merely asserted; inactive products can't be added.
- **The one genuinely different guarantee**: `cafeOrders.service.js`'s own free-stock check
  (physical stock minus what's already reserved on OTHER open tabs) is a plain read (an
  aggregate over open tab items) followed by a separate, unprotected insert - a real,
  acknowledged gap in that design (the actual, final guarantee is the PHYSICAL stock decrease at
  billing time, deferred here too). This pilot's `addItem`/`updateItem` (quantity-increase path)
  instead run inside one transaction that locks the **product row** first
  (`SELECT ... FOR UPDATE`): a second, genuinely concurrent reservation attempt for the SAME
  product blocks on that lock until the first transaction commits or rolls back, then recomputes
  free stock against the now-committed, up-to-date reserved total - never a stale read. **Proven
  with genuine concurrency** (6 simultaneous 1-unit reservations against a stock of 5 - exactly 5
  win), not assumed.

##### StockMovements (`server/services/stockMovements.pg.service.js`)

- **Reused, not re-implemented**: `products.pg.service.js`'s own `mapProductRow` (a sibling
  PostgreSQL pilot file - the same reuse `players.pg.service.js`'s `nameKeyOf` already
  established); `server/utils/time.js`'s `startOfDayInTimeZone`/`startOfNextDayInTimeZone` (pure,
  no mongoose) for `listMovements`'s club-local date filtering.
- **Implemented**: `restock`, `adjust` (adjustment ± or waste, always a reduction regardless of
  the input's sign), `recordInitialStock`, `listMovements`, and the atomic `increase`/`decrease`
  pair. Movement types, signed quantities, `balance_after`, the 0/1,000,000 stock boundaries, and
  "manual operations refused for untracked products" all match `stock.service.js` exactly.
- **Every stock mutation and its `stock_movements` row are written in ONE transaction** (not two
  separate, non-transactional writes like MongoDB's `Product.findOneAndUpdate` +
  `StockMovement.create()`): if the movement insert ever failed after the stock change succeeded,
  the whole transaction rolls back, undoing the stock change too - verified directly (test 9
  below), not assumed.
- **Overselling can't happen**: a decrease is one atomic conditional `UPDATE` with
  `stock_quantity >= quantity` in its own `WHERE` clause - proven with 10 genuinely concurrent
  requests racing to take 1 unit each from a stock of 5 (exactly 5 win), and `balance_after`
  confirmed, under that same concurrency, to be a true permutation of 4-3-2-1-0 with no
  duplicates or gaps - each movement really saw the stock *after* its own change, never a stale
  or duplicated value from a racing sibling.

##### Explicitly out of scope - recorded, not invented, with the deferred transaction boundary

- **`takeForBill`/`putBack`** (multi-product, all-or-nothing PHYSICAL stock deduction tied to an
  actual bill save) - needs to run inside `bills.pg.service.js`'s own transaction (the same one
  that inserts the bill, its line items and players), so that a bill is never saved with some of
  its café stock taken and some not. Belongs to Phase 3's Bills/Café integration, not a
  standalone CafeOrders/StockMovements pilot.
- **`claimForBill`/`releaseClaim`** (a bill's claim on open tab items, marking them `billed`
  before the bill itself is known to have saved) - same transaction boundary as above: claiming
  must commit or roll back together with the bill row itself.
- **`recordSale`/`restoreForCancelledBill`** (the `sale`/`sale_reversal` movements a bill's own
  creation/cancellation produces) - these write `stock_movements` rows with a real `bill_id`,
  which only exists once a bill has actually been saved; wiring them in here would mean
  reimplementing part of `bills.pg.service.js`'s own save/cancel flow as a side effect of this
  pilot, against this step's own instruction not to.
- **No café payer rules, pricing, or bill calculation logic was touched or reimplemented** -
  `bills.pg.service.js` itself was not changed.

##### What was verified - against the real local PostgreSQL

CafeOrders (15 tests): product-based and typed-in item creation with the correct snapshot;
free stock correctly shared/reduced across different sessions' open tabs; untracked products
always available; a later price change never retroactively changes an already-ordered item;
inactive products refused; only-open-items-change/remove enforced, removed items confirmed to
survive in the database (excluded only from `listItems`'s own read); quantity-update re-checks
free stock correctly (counting the item's own current quantity, not double-counting it);
whole-session-bill-closes-the-tab vs match-bill-does-not, against real `app.matches`/`app.bills`
fixtures; `openTabQuantities` aggregated correctly across sessions and products; the real
concurrency guarantee (6 concurrent reservations, a stock of 5, exactly 5 win); foreign-key
refusal for a non-existent product (mapped to the same 400 `cafeOrders.service.js` itself gives,
not a raw SQL error); transaction rollback (a failed second insert leaves no row behind, not even
the first one in the same transaction); isolation.

StockMovements (11 tests): restock/adjustment/waste with correct `balance_after`; waste always
stored as a negative quantity regardless of the input's sign; stock boundaries (never below 0,
never above 1,000,000, exactly-at-the-maximum accepted); manual operations refused for untracked
and for missing products; `recordInitialStock` only for tracked products with real starting
stock (confirmed `null` for zero-stock and for untracked products); `listMovements` filtering by
product/type/club-local date range and pagination; the real concurrency guarantee (10 concurrent
requests, a stock of 5, exactly 5 win, `balance_after` a true 4-3-2-1-0 permutation); a raw
foreign-key violation refused by the database itself; transaction rollback (a failed movement
insert leaves the stock change itself rolled back too); isolation.

No schema change was needed or made - the committed step 2.3 schema (`app.cafe_orders`,
`app.stock_movements`, both already linked to `app.bills` via the `ALTER TABLE` once that table
existed) was already adequate for every rule above.

**A real bug found and fixed during this step's own development** (not a database-integrity
issue - a parameter-type ambiguity in `increase`/`decrease`'s SQL): `stock_quantity <= $3 - $2`
failed with PostgreSQL's own `42725` ("operator is not unique... add explicit type casts") because
two untyped parameters either side of `-` leaves the server unable to infer a type. Fixed by
casting both sides explicitly (`$3::int - $2::int`) before any test was taken as passing.

##### Regression checks

| Command | With PostgreSQL configured (run twice) | Without (the ordinary state) |
|---|---|---|
| `npm.cmd test` | **491 passed, 0 failed, 0 skipped**, both times | 307 passed, 0 failed, **17 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline | unaffected either way |

Each new test file alone, **three times**: CafeOrders 15/15 every time; StockMovements 11/11
every time. All fifteen `postgres*.test.js` files run together, **three times** - 191/191 every
time, no deadlocks or races (the step 2.5 advisory-lock fix holds with a fifteenth file). After
every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables. No unrelated or intermittent failure was observed during this step's
verification.

Confirmed: MongoDB remains the application's only active database; `cafeOrders.service.js`,
`stock.service.js`, their routes and controllers are unchanged; `bills.pg.service.js` was not
touched; no production data was changed; nothing was deployed.

##### Unverified behaviour and remaining risks

- **Bill integration** (`takeForBill`, `claimForBill`/`releaseClaim`, `recordSale`/
  `restoreForCancelledBill`) was not built (explicitly deferred above, with its required
  transaction boundary documented) - a future step if Café Orders is ever fully cut over in
  Phase 3, once it can share `bills.pg.service.js`'s own transaction.
- **Login/cookie/middleware flow, and the café/products/stock routes/controllers themselves, are
  untouched** - this step proves the data-layer rules only; wiring Café Orders into the actual
  app is Phase 3 work.
- **Counter still has no PostgreSQL pilot** - the one remaining model completely untouched by
  Phase 2.

#### Step 2.16 — Counters pilot: the shared, reusable atomic sequence — done

**Scope chosen:** one small, standalone repository (`server/services/counters.pg.service.js`),
the last model in this schema with no PostgreSQL pilot at all. Not wired into any route; does not
call and is not called by `server/models/Counter.js` (MongoDB), which stays the application's
only active path.

##### Service responsibilities and atomic increment semantics

A single reusable function, `nextSequence(name, client)`, reproducing `models/Counter.js`'s own
`findOneAndUpdate({_id:name}, {$inc:{seq:1}}, {upsert:true})` exactly, against the real
`app.counters` table (`id text PRIMARY KEY, seq bigint NOT NULL DEFAULT 0` - built for this in
step 2.3; no schema change was needed or made):

```sql
INSERT INTO app.counters (id, seq) VALUES ($1, 1)
ON CONFLICT (id) DO UPDATE SET seq = app.counters.seq + 1
RETURNING seq
```

A brand-new name's first call returns `1`; every later call for the same name returns the next
integer; two different names are completely independent rows - all three verified directly, not
assumed. `seq` is a bigint column, which the `pg` driver always returns as a string (the same
documented reason `rowMappers.js`'s own `toMoney` converts money columns back); `nextSequence`
converts it with `Number(...)` and always returns a plain JS number - confirmed with
`typeof result === "number"` in the tests, never a string or a `BigInt`. Counter names are
validated (non-empty string, ≤200 characters - the schema's own `text` column has no length
limit, so this pilot's own bound is enforced in code, the same pattern every earlier pilot uses
for a rule the schema itself leaves unbounded) and refused with a clear `AppError`, not a raw SQL
error.

##### Transaction-scoped versus standalone behaviour - both of this codebase's real needs, by design

This codebase's two real MongoDB callers of `nextSequence` actually want **different**
guarantees, and both are preserved exactly:

- `bills.service.js`'s own call has **no rollback**: if `Bill.create()` fails afterwards, the
  sequence number is simply burned (a documented, accepted gap - bill numbers may have gaps,
  never duplicates). `nextSequence(name)` with no second argument reproduces this: it runs
  through the ordinary `query()` wrapper, commits immediately on its own, and is **not** undone
  by a later, unrelated transaction's failure - verified directly (test 6).
- `matches.pg.service.js`'s own inline counter SQL (step 2.14, **deliberately left unchanged by
  this step** - see "the decision to leave Matches unchanged" below) already runs inside its
  `startMatch` transaction, so a failure anywhere else in that same transaction rolls the
  increment back too. `nextSequence(name, client)` with a transaction-scoped second argument
  reproduces that same pattern for any future caller, without touching Matches' own
  already-working, already-tested code - verified directly (test 5): a forced later-statement
  failure in the same transaction rolls the counter's own row back to not existing at all.
- A client argument that doesn't look like a real transaction-scoped client (no `.query()`
  method) is rejected immediately with a `TypeError`, not silently treated as "no client" -
  this is a caller-code contract, not user input, so it is a plain thrown error, not an
  `AppError`.

##### The decision to leave the existing Matches pilot unchanged

`matches.pg.service.js`'s own `startMatch` already runs the identical
`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING seq` SQL inline, inside its own transaction,
for match numbering - step 2.14's own, already-committed, already-tested code. This step
explicitly did **not** refactor it to call the new shared service: doing so would touch an
earlier, working, committed pilot for a pure consistency improvement with no behavioural change,
which is a real (if small) regression risk for no functional gain. The new `counters.pg.service.js`
is available for any **future** caller (a bills.pg.service.js bill-numbering integration, or a
hypothetical next pilot) without that risk.

##### What was verified - against the real local PostgreSQL

1. A brand-new counter's first call returns `1`, as a plain JS number.
2. Repeated calls for the same name return consecutive values with no gaps.
3. Different counter names are completely independent of each other.
4. **Real concurrency**: 20 genuinely simultaneous calls for the identical name
   (`Promise.all`, no mocks) produce exactly the unique values `1` through `20` - confirmed with
   a `Set` size check that no value was ever handed out twice.
5. **Transaction-scoped rollback, the real guarantee**: inside one `withTransaction`, the
   increment runs through the transaction's own client, then a later statement in the same
   transaction fails (duplicate primary key) - the whole transaction rolls back, and the
   counter's row is confirmed to not exist at all afterward, not merely unchanged.
6. **Standalone commit survives an unrelated later failure**: a standalone increment commits
   immediately; a completely separate, later transaction then fails for an unrelated reason - the
   standalone increment is confirmed still committed, and the next call continues from where it
   left off (not from `1` again).
7. Invalid names (empty, whitespace-only, `null`, `undefined`, a number, over 200 characters) are
   all refused with a 400 `AppError`, before any row is created.
8. An invalid transaction-scoped client argument (missing `.query()`) is rejected immediately
   with a `TypeError`.
- **Isolation**: confirmed (no `mongoose`/`server/models/` anywhere in the pilot's full require
  tree, checked recursively).

No schema change was needed or made - the committed step 2.3 `app.counters` table was already
exactly adequate for every rule above.

##### Explicitly deferred - recorded, not invented

**Bill-number integration** (wiring `nextSequence` into `bills.pg.service.js`/`bills.service.js`
so a real bill number is generated automatically) remains deferred, exactly as step 2.6 itself
already documented ("not ported; callers supply one"). That integration needs to run inside
`bills.pg.service.js`'s own transaction (the same one that inserts the bill, its line items and
players), so a failed bill save never leaves a burned-but-unused number look any different from
today's accepted MongoDB gap - Phase 3 work, not a standalone Counters pilot's job. No production
route, controller, or `bills.pg.service.js`/`bills.service.js` code was touched.

##### Regression checks

| Command | Result |
|---|---|
| `node --test server/tests/postgresCounters.test.js` (3 consecutive runs) | **10/10 every time** |
| All sixteen `postgres*.test.js` files together (3 consecutive runs) | **201/201 every time** - no deadlocks or races (the step 2.5 advisory-lock fix holds with a sixteenth file) |
| `npm.cmd test`, PostgreSQL configured (2 consecutive runs) | **501 passed, 0 failed, 0 skipped**, both times |
| `npm.cmd test`, unconfigured (1 run) | 307 passed, 0 failed, **18 skipped** (cleanly) |
| `npm.cmd run test:browser` | **780 passed, 0 failed** (15 suites) - identical to every prior baseline |

After every run, the test database (`snooker_club_pro_test`) was confirmed left clean - no `app`
schema, no leftover tables. No unrelated or intermittent failure was observed during this step's
verification.

Confirmed: MongoDB remains the application's only active database; `models/Counter.js`, its two
real callers (`bills.service.js`, `matches.service.js`), and `matches.pg.service.js`'s own inline
counter SQL are all unchanged; no production data was changed; nothing was deployed.

##### Unverified behaviour and remaining risks

- **Bill-number integration** was not built (explicitly deferred above) - a future Phase 3 step,
  once `bills.pg.service.js` itself is ready to generate numbers inside its own save transaction.
- **Login/cookie/middleware flow, and every route/controller, remain untouched** - this step
  proves the data-layer primitive only.
- With this step, **every MongoDB model now has at least a standalone PostgreSQL pilot** -
  Phase 2's own stated goal. Whether to begin Phase 3 cutover planning next, or add further
  cross-service integration pilots first (bill numbering, café bill integration from step 2.15,
  player history from step 2.13, bill/match report joins from steps 2.12/2.14), is an open
  decision for the next approval, not assumed here.

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
- [x] Phase 2, Step 2.8 — Users + AuthSession pilot: real password-hash verification, last-admin transaction rollback, and the first real foreign keys to a real user row (closing step 2.7's gap) (384 server / 780 browser with PostgreSQL configured, 13 new tests, 0 skipped)
- [x] Phase 2, Step 2.9 — Bookings pilot: the real EXCLUDE overlap guarantee against a real service, proven with 6 genuinely concurrent requests for the identical slot (396 server / 780 browser with PostgreSQL configured, 12 new tests, 0 skipped); Railway's PostgreSQL version and `btree_gist` availability remain unconfirmed - no Railway project exists yet (manual steps recorded above)
- [x] Phase 2, Step 2.10 — Tables pilot: CRUD, uniqueness, status/session/booking restrictions, real FK compatibility with bookings, transaction rollback (409 server / 780 browser with PostgreSQL configured, 13 new tests, 0 skipped)
- [x] Phase 2, Step 2.11 — Customers pilot: search/pagination with real booking stats, archive-not-delete, FK-backed deletion restriction (421 server / 780 browser with PostgreSQL configured, 12 new tests, 0 skipped)
- [x] Phase 2, Step 2.12 — Sessions pilot: real one-transaction start/end, the sessions_one_open_per_table guarantee proven with genuine concurrency, FK compatibility (433 server / 780 browser with PostgreSQL configured, 12 new tests, 0 skipped)
- [x] Phase 2, Step 2.13 — Players pilot: duplicate-name rules (active vs inactive message), deactivate/reactivate, real concurrency proof, FK compatibility with match_players (445 server / 780 browser with PostgreSQL configured, 12 new tests, 0 skipped); player history explicitly deferred (no Matches pilot yet)
- [x] Phase 2, Step 2.14 — Matches pilot: the session-lock-before-create transaction, player/team rules, real concurrency proof (463 server / 780 browser with PostgreSQL configured, 18 new tests, 0 skipped); found (did not fix) a real Sessions-pilot timing bug; bill joins and changeResult explicitly deferred
- [x] Phase 2, Step 2.15 — CafeOrders/StockMovements pilot: tab lifecycle with a real product-row-lock guarantee against overselling reserved stock, atomic stock increase/decrease proven with genuine concurrency, transaction-paired movement history (491 server / 780 browser with PostgreSQL configured, 26 new tests, 0 skipped); bill integration (takeForBill, claimForBill/releaseClaim, recordSale/restoreForCancelledBill) explicitly deferred with its transaction boundary documented
- [x] Phase 2, Step 2.16 — Counters pilot: the shared atomic upsert-and-increment, both transaction-scoped and standalone modes proven with real concurrency and real rollback (501 server / 780 browser with PostgreSQL configured, 10 new tests, 0 skipped); bill-number integration explicitly deferred; matches.pg.service.js deliberately left unchanged. Every MongoDB model now has at least a standalone PostgreSQL pilot.
- [ ] Phase 3 cutover planning, or further cross-service integration pilots (bill numbering, café/bill integration, player history, bill/match report joins), per the next approval (not started; awaiting approval)
- [ ] Phase 3 — Services ported
- [ ] Phase 4 — Tests + Mongo import verified
- [ ] Phase 5 — Live on Railway + Vercel, verified
