# Snooker Club Pro — Architecture (as built, Phase 11 · v0.11.0)

This document explains **how the whole system is organised**. Come back to it whenever you wonder
"where does this code belong?" or "why is it done this way?".

> **History:** it started in Phase 1 as the *plan*, written before any code. In Phase 11.8 every section
> was brought in line with the app **as built**. Where the build deliberately differs from the original
> plan (pause/resume, discounts, customer logins, JWT, a separate `inventory` page), the section says so.
> Sections 4.4–4.9 describe the Phase 11 additions in detail.

---

## 1. The big picture

```
 Browser (HTML + CSS + JavaScript)
        │  fetch("/api/tables")  ──►  JSON
        ▼
 ┌──────────────────────── Express server (Node.js) ────────────────────────┐
 │                                                                          │
 │  /            → sends the frontend files from client/                    │
 │  /api/...     → routes → middleware → controllers → services → models    │
 │                                                                          │
 └──────────────────────────────────────┬───────────────────────────────────┘
                                        ▼
                               MongoDB (local database)
```

**One Express server does two jobs:**

1. It sends the website files (`client/`) to the browser.
2. It answers API requests under `/api/...` with JSON.

Because the website and the API come from the **same address** (e.g. `http://localhost:3000`):

- there are no CORS problems (unlike two separate servers), and
- login cookies work simply and safely.

### How a request travels through the backend

```
Request ─► Route ─► Middleware ─► Controller ─► Service ─► Model ─► MongoDB
                    (login? role?   (read request,  (business   (shape of
                     valid input?)   send response)  rules)       the data)
```

| Layer | Job | Example |
|---|---|---|
| **Route** | Connects a URL + method to a controller | `POST /api/sessions` → `sessionController.start` |
| **Middleware** | Checks done before the controller runs | Is the user logged in? Is the input valid? |
| **Controller** | Reads the request, calls a service, sends the JSON response | Takes `tableId` from the body, returns the new session |
| **Service** | The **business rules** | "A table can only have one active session", "calculate the bill" |
| **Model** | Describes a MongoDB collection and its validation | `Session` has `table`, `startedAt`, `status`… |

> **Rule of thumb:** if you are writing an `if` about snooker-club rules, it belongs in a **service**.
> Controllers stay short and boring.

---

## 2. Folder structure

```
Snooker-Club-Pro/
├── server/                     ← everything that runs in Node.js
│   ├── server.js               starts the app: connect to MongoDB (+ index sync), then listen on a port
│   ├── app.js                  builds the Express app: helmet, JSON, cookies, /api, pageGuard, static files, errors
│   ├── config/
│   │   ├── env.js              reads settings from .env (port, database URL, AUTH_SECRET, cookie, timezone)
│   │   ├── db.js               connects Mongoose; safe start-up messages (never the full MONGODB_URI)
│   │   ├── permissions.js      THE role table (admin / staff / cashier) + page permissions
│   │   └── gameModes.js        THE game-mode registry (Century, Frame, Snooker Point, 4 Players)
│   ├── models/                 one file per collection (Table, Session, Match, Player, Bill, Payment, CafeOrder …)
│   ├── routes/                 one file per module + index.js that joins them (login required after /auth)
│   ├── controllers/            one file per module, thin
│   ├── services/               business rules: billing (+ billing.calculator.js), matches, café, stock,
│   │                           bookings, reports, player history, auth, users
│   ├── middleware/             auth.js (loadUser, requireAuth, requirePermission, pageGuard, sameOriginOnly),
│   │                           validate.js, errorHandler.js, notFound.js
│   ├── validators/             input rules per module (express-validator)
│   ├── utils/                  AppError, money.js, time.js, csv.js, password.js, response.js
│   ├── scripts/                startDatabase.js (npm run db), createAdmin.js, resetAdminPassword.js, prompt.js
│   └── tests/                  automatic API + unit tests (node:test), one throw-away database each
│
├── client/                     ← everything the browser downloads
│   ├── pages/                  login, dashboard, tables, sessions, billing, bookings, customers,
│   │                           players, products, categories, reports, users, settings (.html)
│   ├── css/                    theme.css (colours), layout.css (sidebar, grid), components.css
│   ├── js/core/                shared: api.js, ui.js, format.js, layout.js (sidebar, roles),
│   │                           billing.js (Create Bill window), matches.js (Matches window),
│   │                           cafe.js (café tab), sessions.js
│   └── js/pages/               one script per page
│                               (Chart.js: a copy of the npm file in client/vendor/, see its README)
│
├── tests/browser/              browser tests: run.js, server.js (test server), suites/*.html
├── docs/                       ARCHITECTURE.md (this file), API.md (every endpoint)
├── .env.example                example settings (copied to .env, which is never shared)
├── package.json                packages + scripts (db, create-admin, reset-admin-password, dev, start, test, test:browser)
└── README.md
```

*(The Phase 1 plan had `client/index.html` as the login page, an `inventory.html` page, `requireRole.js`
and `asyncHandler`. As built: the login page is `pages/login.html`, inventory is the Products and Categories
pages, roles are one `requirePermission` with `config/permissions.js`, and Express 5 handles async errors itself.)*

---

## 3. Modules

The exact rights are in `server/config/permissions.js` (and the README's role table).

| Module | What it does | Who can use it |
|---|---|---|
| **Dashboard** | Today's figures, tables, running sessions (live timers), recent bills and sessions, today's bookings | Everyone |
| **Tables** | Add, edit and delete tables, status, search and filter | Everyone |
| **Sessions** | Start on a free table, live timer, end (server clock), café tab, Matches, history | Everyone |
| **Matches** (Phase 11.4) | Many matches per session; registered or walk-in players; result; one bill per completed match | Everyone (cancel: admin, staff; paid result correction: admin) |
| **Billing & Payments** | Create Bill window (whole session, Century/Frame) and match bills (all four types), who pays, café, tax, part payments, receipts | Create and view: everyone. Payments and cancelling: admin, cashier |
| **Customers & Bookings** | Customers (for bookings), reservations without overlaps, check-in, automatic no-show | Everyone |
| **Players** (Phase 11.2/11.6) | Registered players, history, outstanding | View: everyone. Register/edit: admin, staff. Deactivate: admin |
| **Café products & inventory** (Phase 10) | Categories, products, stock movements, session café tab, café on bills | Sell: everyone. Restock: admin, staff. Products, adjust: admin |
| **Reports** (Phase 9/11.7) | Revenue, payments, game types, matches, players, tables, bookings, customers, outstanding; CSV; print | Admin, staff |
| **Users & Auth** | Login, users, roles | Everyone logs in; admin manages users |
| **Settings** | Rate list (four game types), time rule, tax, no-show minutes | Change: admin. View rates: everyone (the bill windows need them) |

*(Not built, on purpose: pausing a session, discounts, customer logins / self-booking, and a leaderboard
module. The club's currency and timezone are fixed in the app, the server's day rules follow `CLUB_TIMEZONE`.)*

---

## 4. Database design (MongoDB collections)

MongoDB stores **documents** (like JSON objects) in **collections** (like tables in SQL).
Every document gets an automatic `_id`. With Mongoose `timestamps: true`, each one also gets
`createdAt` and `updatedAt` automatically.

A **reference** (`ref`) stores another document's `_id`, like a foreign key.
Example: a session stores `table: <id of Table 3>` instead of copying the whole table.

### 4.1 Collections (as built)

The models in `server/models/` are the exact definition. Money is always whole **paisa** (§5.1).

| Collection | What it holds | Key fields |
|---|---|---|
| `users` | People who can log in | `name`, `username` (unique, lower case), `passwordHash` (scrypt, `select: false`), `role` (`admin` · `staff` · `cashier`), `active`, `passwordChangedAt`, audit |
| `authsessions` | Logins | `tokenHash` (HMAC of the cookie token), `user`, `expiresAt` (TTL index) |
| `tables` | The snooker tables | `tableNumber` (unique), `name`, `hourlyRate` (stored, not used for billing), `status` |
| `sessions` | Time played on a table | `table` + copies (`tableNumber`, `tableName`, `hourlyRateAtStart`), `startedAt` / `endedAt` (server clock), `durationSeconds`, `status` (`active` · `completed`), `isOpen`, `booking` (check-in), audit |
| `matches` (11.4) | Games inside a session | `session`, `number`, table copies, `gameMode`, `players[] { player (ref or null = walk-in), name copy, seat, team, result }`, `teams`, `status`, result fields, `bill` (pointer, see 4.6/4.9) |
| `players` (11.2) | Registered players | `name` (unique ignoring case), `phone`, `notes`, `isActive`; never deleted |
| `bills` | What is owed | `billNumber` (unique, `B-YYYYMMDD-NNNN`), `session` (+ `match`, `matchNumber` for match bills), table/session copies, `gameMode`, `quantity`, `unitPrice` + `pricingType` (rate snapshot), `billedMinutes`, `lineItems[]` (game + café, with copies), tax, `total`, `payerRule`, `cafePayerRule`, `players[] { name, player?, team?, result, shareAmount, paidAmount, gameShare?, cafeShare? }`, `amountPaid`, `status` (`unpaid` · `partially_paid` · `paid` · `cancelled`), audit |
| `payments` | Money received | `bill`, `amount`, `method` (cash, card, JazzCash, Easypaisa, bank transfer, other), `payerName`, `paidAt`, `receivedBy` |
| `cafeorders` (10) | A session's café tab | `session`, product copy (`description`, `unitPrice`, `categoryName`), `quantity`, `consumer`, `status` (`open` · `billed` · `removed`), `bill` |
| `categories`, `products`, `stockmovements` (10) | Café inventory | names unique per scope, `price`, `trackStock`, `stockQuantity` (only changed through movements), movement history |
| `customers`, `bookings` (7) | Reservations | customer `name`, `phone`, `notes`, `isActive` (false = archived); booking `table`, `startAt` / `endAt` (no overlaps), `status` (`pending` · `confirmed` · `completed` · `cancelled` · `no_show`), copies |
| `settings` | One document | `gameRates` (per game type), legacy `framePrice` / `centuryPrice`, `currency`, time rule (`minimumBillableMinutes`, `billingIncrementMinutes`), tax, `noShowGraceMinutes`, audit |
| `counters` | Atomic sequence numbers | bill numbers per day, match numbers per session |

> **Why bills *and* payments?** One bill can be paid in parts (Rs 500 cash now, Rs 300 card later).
> The bill holds what is owed (and each player's share); each payment is one amount received.

### 4.2 How the collections connect

```
customers ──< bookings ──(check-in)──► sessions ──< matches ──< players[] ──► players (registered)
                 │                        │  │          │
              tables ◄────────────────────┘  │          └── bill (one per completed match) ─┐
                                             ├── cafeorders (tab) ──► products ◄── stockmovements
                                             └── bill (whole session, no matches) ───────────┤
                                                                                              ▼
                                                                          bills ──< payments
users ──< authsessions                    (audit copies of the user on most records)
```

### 4.3 References vs. copies (snapshots)

- **References** are used for things that must stay connected, like a session's table or a bill's customer.
  If a customer's phone number changes, every booking automatically shows the new number.
- **Copies (snapshots)** are used where **history must not change**:
  - A session stores `hourlyRateAtStart`. If the admin raises the rate tomorrow, yesterday's bill stays correct.
  - A café tab item and a café bill line store the product's name, category and price at that moment.
  - A match and a bill store each player's name, so a later rename never changes history.
  - A bill stores its game rate (`unitPrice`), its billed minutes and, since Phase 11.3, its `pricingType`.
    - Century bills are `per_minute`: billed minutes × rate.
    - Older bills have no `pricingType`: quantity × rate.
    - Bills are never re-priced.

### 4.4 Game-mode registry and rates (Phase 11.1 / 11.3)

- `server/config/gameModes.js` is the only place that describes the game modes:
  - key, label, player limits, whether the mode is enabled
  - `pricingType` (`per_minute`, `per_frame` or `fixed`), `rateUnit` and `defaultRate`
- The rates live in `Settings.gameRates.<mode>` (paisa), which admins edit.
  - These fields have **no schema defaults**: a missing value means "never set".
  - `rateFromSettings()` then falls back to the old `framePrice` (Frame only), and then to the registry default.
  - Settings saved before Phase 11.3 work with no migration.
- Century uses the same `billableMinutes()` time rule (minimum + rounding step from Settings) that every bill records. There is no second time system.
- **Two flags per mode:**
  - `enabled`: the mode can be used in today's Create Bill window (Century, Frame).
  - `matchEnabled`: the mode can be played as a match (all four, since Phase 11.4).

### 4.5 Matches (Phase 11.4)

```
Table ──< Session ──< Match ──< players[] ── result ── Bill (one per match, Phase 11.5) ──< Payment
```

- **One session, many matches:** a `Match` always references one session, and the session has many. Matches are numbered per session with the atomic `Counter`, and a unique index on `{session, number}` backs this up.
  - One frame is one match; there is no "frames inside a match".
  - Nothing assumes one session = one match.
- **The session is the clock and the bill is the price:** a match has no timer and no rate. The match's bill takes the session's billed minutes and copies the rate when it is created (the Phase 11.3 rule).
- **Players** are an embedded list. Each entry has `player` (a reference to a registered Player, or `null` for a walk-in), a `name` copy, `seat`, `team` (4 Players only), `result` and an unused `score`.
  - The copy keeps history readable after a rename or deactivation.
  - Walk-ins never create Player or Customer records.
- **Teams (4 Players):** the registry's `teams` (Team 1 = seats 1–2, Team 2 = seats 3–4) fill the match's `teams`.
- **Result:** `winnerSeat`, or `winningTeam` / `losingTeam`, plus each player's `winner` / `loser`.
- **Lifecycle:** `in_progress → completed | cancelled`.
  - Every change is one conditional `findOneAndUpdate` on the expected status and `updatedAt`, so racing requests can't both win.
  - Matches are never deleted.
- **Result changes and bills:** a result change never edits a bill. Once the match's bill has payments, a result change needs `matches:correct-paid` (admin).

### 4.6 Billing: whole sessions and matches (Phase 11.5)

- **Two kinds of bill, one model:**
  - A bill for a **whole session** (the Create Bill window, and every bill made before 11.5) has **no** `match`.
  - A bill for a **match** has `match` and `matchNumber` (plus `winningTeam` / `losingTeam` for 4 Players), and its players carry `player` (registered) and `team`.
  - Old bills were not migrated, and no fake matches were created for them.
- **Database guarantees:**
  - The old unique `{session}` index became unique `{session, match}`: one whole-session bill per session (match = null) and one bill per match. `syncIndexes()` at startup swaps the index; existing data already fits it.
  - A partial unique index allows only one Century (`per_minute`) match bill per session, so the session's time is charged once.
- **Never mixed:** the service refuses a whole-session bill for a session with (non-cancelled) matches, and match bills for a session billed as a whole.
- **Same machinery for both kinds:** `prepareMatchBill()` reuses the calculator, the café resolver, today's rate (`currentRate()`), the session's billed minutes and `saveBill()`. Game type, quantity (1) and players with results come from the match.
- **Café tab with several bills:** `saveBill()` claims the session's open tab items for the bill **before** inserting it (one conditional `updateMany`), and only then takes stock. If the claim is incomplete or the insert fails, the items are released and the stock is put back, so nothing is half done and no item is on two bills. Match bills don't lock the tab; only a whole-session bill does.
- **Payer rules for any number of players:** `splitShares()` shares the amount equally between all players with the paying result. Leftover paisa go to the first payers. One loser or winner gives exactly the old result.
- **Reports:** the tables report sums every non-cancelled bill of a session and counts the session's billed minutes once (the maximum over its bills). Revenue, games, payments and outstanding were already bill-based.
- **Player history (Phase 11.6, see 4.7):** wins, losses, bills and outstanding are derived from the `players.player` references. No counters are stored.
- **Match indexes** (Phase 11.4):
  - `{session, number}` (unique)
  - `{session, status}`
  - `{players.player, startedAt}`
  - `{gameMode, startedAt}`
- **UI:** `client/js/core/matches.js` holds the shared Matches dialog, opened from session rows, table cards and session history, like the café tab.
- **The bill is the source of truth (Phase 11.8, see 4.9):** `Match.bill` is a convenience pointer written right after the bill; every decision looks the bill up by `Bill.match`.

### 4.7 Player history and café consumers (Phase 11.6)

```
Player ──< Match.players[].player ──> Match ── Bill.players[].player ──> Bill ──< Payment
Player ──< Bill.lineItems[].consumerPlayer (café consumer) ──> Bill
```

- **No new collection, no counters.**
  - `services/playerHistory.service.js` reads Match and Bill only, and never writes.
  - Statistics (`total`, `completed`, `wins`, `losses`…) and the bill summary are aggregations over the player's records, worked out on every request.
- **Outstanding** comes from the bill's own `players[]` entry: `shareAmount − paidAmount` on `unpaid` / `partially_paid` bills, and 0 on paid and cancelled bills.
  - `paidAmount` is raised by `payments.service` in the same atomic update as the bill's `amountPaid`, so there is no second payment system and nothing to reconcile.
  - It is the player's **own** share. A team-mate's debt on the same bill isn't theirs.
- **Linking is by reference only:** `Match.players[].player`, `Bill.players[].player` and `Bill.lineItems[].consumerPlayer` (all set since Phase 11.5).
  - Names are copies (snapshots): a rename never touches history.
  - Old and whole-session bills have no references and are **not** matched by name, so they aren't in any player's history. Nothing was migrated or rewritten.
- **Café consumer:**
  - The tab's free-text `consumer` (now up to 60 characters, the longest registered name) is matched to the match's players when the bill is made.
  - A registered player gets `consumerPlayer`; a walk-in keeps the name only.
  - Match player names are unique within a match, so the name match is unambiguous.
- **Index:** `bills_by_registered_player` on Bill: `{ "players.player": 1, createdAt: -1 }`, partial (only bills with a player reference). Matches already had `{ "players.player": 1, startedAt: -1 }`. `syncIndexes()` at startup creates it.
- **API:** `GET /api/players/:id/matches` and `GET /api/players/:id/bills`.
  - They need the existing `players:view` plus `matches:view` / `bills:view`.
  - No permission was added or changed.
- **Payer rule wording:** the UI says *Loser Pays / Winner Pays / Both Pay* (and *Consumer Pays*). The stored value is still `split`. A value `split_equally` (never written) would be read as Both Pay: everyone pays.
- **UI:** the Players page has a **History** button per player that opens a details dialog. It shows totals, match history and billing history, each paged 10 at a time.
  - Since 11.7, `/pages/players.html?player=<id>` opens that dialog directly (a link from the Players report).

### 4.8 Match and player reports (Phase 11.7)

- **Two Reports sections,** `GET /api/reports/matches` and `GET /api/reports/players`.
  - Built like every Phase 9 report: same period resolver (Karachi club days, presets, 366-day limit), same filters, `$facet` aggregations, CSV through `/export/:report` and `utils/csv.js`, and per-section print.
  - They sit under the same `reports:view` router: admin and staff, cashier 403. No permission changed.
- **Date rules:**
  - A match belongs to the day it **started**, like a session.
  - The Matches report shows each match with its bill whatever day the bill was made.
  - The Players report's money uses match bills **created** in the period, like Revenue and Outstanding.
- **One calculation for player money and statistics.**
  - `playerHistory.service.js` exports `matchStatsStages()` and `billSummaryStages()`: a `$unwind` of `players` and a `$group` by `players.player`.
  - The player history uses them for one player (all time); the Players report uses them for everyone in a period.
  - Walk-ins group under `null` and are shown as one line.
  - So the two can't disagree: the player's **own** `shareAmount − paidAmount` on open bills, and 0 on cancelled bills.
- **No invented data:** bills without a match (Create Bill window, pre-11.5) are never given a match or linked to a player by name. The reports only read.
- **Game types:** the reports filter accepts every registry type (`ALL_GAME_MODE_KEYS`). Before, only the bill window's enabled types were accepted, though match bills of all four exist since 11.5. `options.gameModes` lists all four.
- **Indexes: none added.**
  - Matches by period use the existing `{gameMode, startedAt}` index (the query asks for `gameMode $in` every type, the same trick sessions and bookings use).
  - The bill of each match is a `$lookup` by the bill's own `session` + `match` (the unique `{session, match}` index; Phase 11.8, before: `Match.bill` → `_id`).
  - Player money starts from bills `{createdAt}`.
  - `explain()` tests check the period queries.
- **Screen vs CSV:** Matches and Players show 25 rows per page (server-side `skip/limit` for matches; for players, the page of the sorted list). CSV has every row (50,000 cap). Print prints the page shown, and the page says so.

### 4.9 Final checks: integrity and hardening (Phase 11.8)

- **A match's bill is found by the bill.** `Bill.match` (one bill per match, unique `{session, match}` index) is the source of truth. `Match.bill` is only a pointer written after the bill is saved; if a crash ever skipped that write:
  - the result-change rule still sees a paid bill (`matches.service` `findMatchBill`: partly or fully paid → admin only);
  - "already has a bill" still refuses a second bill;
  - the Matches window, session counts, the Matches report and player history still show the bill;
  - the pointer is repaired when found (`repairBillPointer`, only where it is empty, without touching `updatedAt`). Bills are never changed.
- **"Billed per match"** (`matchSummaryForSessions`) counts the session's match bills that are **not cancelled**, from the bills: the same meaning as the Matches report.
- **Café tab on the last billable match:** `prepareMatchBill()` refuses `includeCafeTab: false` (409) when the tab has open items and no other match can still be billed (`anotherBillableMatch()`: a completed match without a bill or one in progress; not a cancelled or billed one, a second Century, or a Rs 0 game type). The preview returns `cafeTabMustStay`, and the window locks the box. Stock rules are unchanged (taken atomically on the bill that takes the tab).
- **Page guard on canonical paths:** `pageGuard` decodes and normalises the address (lower case, `\` → `/`, dot segments, double slashes). Other spellings are redirected to the canonical one before any rule; names that aren't plain page names get 404. So `/pages/users%2Ehtml` can't skip the login or the role check.
- **Single query values:** `singleQueryValues` (routes/index.js) answers 400 when a query key is given twice, instead of letting a list reach a query.
- **Start-up messages** (`config/db.js`): "can't connect" (hint: `npm run db`) and "connected, but the index sync failed" are reported separately. The database address is printed without credentials or options.
- **Index:** `open_sessions_by_start` on Session: `{startedAt: 1}`, partial `{isOpen: true}`. "Sessions running now" (Tables, Dashboard) no longer reads every session ever played.
- **Test safety:** every server test, the browser test server and the browser runner drop a database only if its name contains "test" (`server/tests/helpers/testDb.js`).
- **Admin password reset:** `npm run reset-admin-password` (`scripts/resetAdminPassword.js` → `users.service.resetAdminPassword`). It only resets an existing, active admin, uses the normal password rules and hashing, never prints the password, and ends all of that admin's logins. Prompts are shared with create-admin (`scripts/prompt.js`).

---

## 5. Important rules (and how they are enforced)

### 5.1 Money: whole numbers only

All money is stored as a **whole number in the smallest unit** (paisa / cents):

| Shown to user | Stored in database |
|---|---|
| Rs 120.00 | `12000` |
| Rs 120.50 | `12050` |

Why? Computers can't store some decimals exactly. In JavaScript, `0.1 + 0.2` is `0.30000000000000004`.
Whole numbers never have this problem. One helper, `format.js` / `money.js`, converts for display.

### 5.2 Time: the server's clock decides

- All times are saved in **UTC** by the server. The browser's clock is never used for billing,
  because it could be wrong or changed.
- The club's **timezone** (`CLUB_TIMEZONE` in `.env`, Asia/Karachi) decides what "a day" is, e.g. for "today's revenue" and reports.
- The **live timer** you see on screen is only a display: it counts from the `startedAt` the server sent.
  The session's time is fixed on the server when you press **End Session**, and the bill is calculated on the server from it.

### 5.3 Only one active session per table

Two layers of protection:

1. The **service** checks "does this table already have an open session?" before starting a new one.
2. The **database** has a *unique partial index* on `table` for sessions where `isOpen: true`.
   Even if two staff members press **Start** at the same moment, MongoDB accepts only one.
   The other gets a clear 409 error.

### 5.4 Billing calculation

```
billed minutes = played minutes rounded UP to billingIncrementMinutes, at least minimumBillableMinutes
game line      = Century:        billed minutes × per-minute rate        (pricingType "per_minute")
                 Frame:          frames × per-frame rate                 ("per_frame"; a match bill = 1 frame)
                 Snooker Point,
                 4 Players:      1 × the game's rate                     ("fixed"; match bills only)
subtotal       = game line + café lines (each café line = quantity × the price copied when ordered)
total          = subtotal + tax (tax off by default; basis points, rounded half-up to a paisa)
shares         = split by who pays (Loser Pays / Winner Pays / Both Pay), café optionally by its own rule
                 (Loser Pays / Consumer Pays / Both Pay); leftover paisa go to the first payers
```

The rate comes from the **rate list in Settings** and is copied into the bill (never the table's hourly rate).
The maths lives in **pure functions** (`services/billing.calculator.js`): numbers in, numbers out, no database.
That makes it easy to test automatically with Node's built-in test runner. *(The Phase 1 plan had an hourly
table rate, paused time and discounts; none of those were built.)*

### 5.5 No overlapping bookings

Two bookings on the same table overlap when:

```
newStart < existingEnd  AND  newEnd > existingStart
```

Only `pending` and `confirmed` bookings count. Cancelled or no-show bookings free the slot.
The service checks this before saving.

> Note: a local MongoDB without a "replica set" can't lock two collections at once (no transactions).
> The tiny chance of two bookings saved at the same millisecond is acceptable for a club. It can be
> closed later by running MongoDB as a single-node replica set.

### 5.6 Stock can't go negative

When something is sold, stock is reduced with **one atomic database command**: "subtract 2 only if
stock is at least 2". If two sales happen at once, the second one fails cleanly.

### 5.7 Safe deletes

| Thing | Rule |
|---|---|
| Table with an active session or future booking | Can't be deleted (409). Set it to *maintenance* or retire it instead |
| Customer with history | Hidden (`isActive: false`), never really deleted |
| Product with sales | Set inactive instead of deleting |

---

## 6. Security (as built in Phase 8)

The Phase 1 plan said bcrypt + JWT + express-rate-limit. Phase 8 kept the **goals** but used
simpler tools with no extra dependencies (only `cookie-parser` was added):

| Topic | How |
|---|---|
| Passwords | Hashed with Node's built-in **scrypt** (N=16384, r=8, p=1, random 16-byte salt per password), stored as `scrypt$N$r$p$salt$hash`, compared in constant time. `passwordHash` is `select: false` and removed from all JSON |
| Login | A random 32-byte token in an `httpOnly`, `SameSite=Strict` cookie (`Secure` with `COOKIE_SECURE=true`). The `authsessions` collection stores only `HMAC-SHA256(AUTH_SECRET, token)`, with a TTL index, so expired logins are deleted by MongoDB. **Why not JWT?** A server-side session can be ended at once: logout, deactivation and password reset all work immediately, which JWTs can't do without a blocklist |
| Every request | `loadUser`: cookie → session → user, who must still be **active**. A deactivated user's sessions are deleted |
| Roles | One permission table, `server/config/permissions.js`. Routes use `requireAuth` (401) and `requirePermission("bills:cancel")` (403). Pages are guarded on the server too (`pageGuard` + `PAGE_PERMISSIONS`: settings, users, reports, products, categories, players), on the **canonical** path since Phase 11.8 (encoded spellings can't skip it) |
| Query input | Phase 11.8: a query key given twice → 400 (`singleQueryValues`) |
| Forgotten admin password | Phase 11.8: `npm run reset-admin-password` on the club PC. Only an existing active admin, hidden input, normal rules, all their logins end |
| Brute force | In-memory counter (`services/loginThrottle.js`): 5 failures per username or 20 per IP in 15 min → 15-min lock (429). Unknown usernames take the same time as known ones (fake hash check) and get the same message |
| Cross-site requests | `SameSite=Strict` cookie, plus `sameOriginOnly`: a POST, PATCH or DELETE whose `Origin` is another site → 403 |
| Headers | `helmet` adds standard security headers (incl. a Content-Security-Policy with no inline scripts) |
| Input | Every request body is validated (`express-validator`) **and** Mongoose validates again. Login input is capped (password ≤ 200 chars) before hashing |
| Secrets | `AUTH_SECRET` and the database URL live in `.env`, which is never committed. `.env.example` has only placeholders. Production refuses to start without a real secret |
| First admin | `npm run create-admin`: asks for the password without showing it and never prints it. Refuses if an active admin exists. Nothing is hard-coded |
| Account safety | The last active admin can't be deactivated or demoted (checked after saving, and rolled back if two requests raced). Admins can't deactivate or demote themselves |
| Audit | Records keep `{ user, name, username }` of who created, cancelled, received or changed them (see `docs/API.md`) |
| Errors | One central error handler; users get friendly messages, technical details stay in the server log (only 5xx errors are logged, never request bodies) |

### Request path with login

```text
Browser ──► helmet ─► express.json ─► cookieParser ─► pageGuard (HTML pages) ─► static files
                                                   └► /api: health (public) ─► sameOriginOnly ─► loadUser
                                                        ─► /auth (login, logout, me)
                                                        ─► requireAuth (401) ─► route ─► requirePermission (403)
                                                        ─► validate ─► controller ─► service ─► model ─► MongoDB
```

### Café products & inventory (Phase 10)

```text
products.html / categories.html / café tab (core/cafe.js) / Create Bill window (core/billing.js)
  ─► /api/categories, /api/products, /api/products/:id/restock|adjust, /api/stock-movements,
     /api/sessions/:sessionId/cafe-items
  ─► requireAuth ─► requirePermission(cafe:view | cafe:sell | products:manage | stock:restock | stock:adjust | stock:view)
  ─► validators/cafe.validators.js ─► controllers/cafe.controller.js
  ─► services: categories, products, stock, cafeOrders  (+ bills.service for billing)
  ─► models: Category, Product, StockMovement, CafeOrder  (+ optional new fields on Bill)
```

- **Rebuilt from Malik-Snooker-Club Modules 3–4.** The business rules are reused (name lengths, unique names, low-stock limit 5, no deleting used records, stock only through transactions). The code is new Node/MongoDB code; no Flask/SQLite code was copied.
- **Stock can't be oversold:** `stock.service` is the only code that changes `stockQuantity`, always with an atomic conditional update (`{ stockQuantity: { $gte: n } }` + `$inc`) and a `StockMovement` record. Bill creation takes all counted products **all or nothing** (and undoes it if saving the bill fails). Cancelling an unpaid bill puts back exactly what its "sale" movements took.
- **The café tab** (`CafeOrder`) records items during a session with copied name and price. Adding checks the *free* stock (stock − open tabs); the bill makes the final atomic check.
- **The billing calculator stays backward compatible:** without `cafePayerRule` the calculation is the old code path, line for line. With it, the game part follows `payerRule` and the café part follows `cafePayerRule`. The tax is split so the parts always add up to the total.
- **History never changes:** bill lines keep copies (name, price, category name, consumer). Products and categories can be renamed or re-priced freely.
- **Tests:** `server/tests/cafe.test.js` (API and maths) and `tests/browser/suites/cafe.html` (the pages). All browser tests now live in the repository and run with `npm run test:browser`.

### Reports (Phase 9)

```text
reports.html ─► GET /api/reports/<report>?preset=…|from=…&to=…&filters
              ─► requireAuth (401) ─► requirePermission("reports:view") (403 for cashiers)
              ─► validators/reports.validators.js (period, filters, sort)
              ─► controllers/reports.controller.js ─► services/reports.service.js
                    resolveRange(): preset or From/To -> exact UTC window of Karachi club days
                    one MongoDB aggregation per report ($match on an indexed date -> $facet/$group)
              ─► JSON numbers (paisa)   or   CSV file (/export/:report)
```

- **One calculation, shared:** the dashboard's "today" bill and payment totals now call the same
  `summarizeBills` / `summarizePayments` functions as the Reports page, so the two can never disagree.
- **Historical truth:** reports only read what each bill **saved** (total, amountPaid, gameMode, billedMinutes,
  table snapshot). Nothing is re-priced with current Settings.
- **The browser only displays:** the page never adds up rows. Charts and cards show the server's numbers.
  Each section loads on its own: a failing report shows an error and Retry, keeps its last good figures
  (marked as old), and doesn't affect the other sections.
- **One booking selection:** the bookings summary, its daily rows and its CSV all use the same `bookingMatch()`
  query, so a status filter can't make them disagree. Rates are returned only for "all statuses" (`ratesAvailable`).
- **One wording for Observed Utilization:** its label and explanation come from the API (`utilization.label`,
  `description`), so the page, the CSV header and the docs say the same thing.
- **Complete outstanding print:** `allOutstandingBills()` is the one query for "every matching outstanding bill".
  The CSV export (max 50,000) and `/outstanding/print` (max 2,000) both use it. The screen keeps its pages of 25.
- **Two day rules in Table performance, both explicit in the API:** Sessions by start date (`sessionCounting`),
  Observed Utilization by the time inside each day (`utilization.dayAllocation`).
- Report definitions, the Observed Utilization formula and the customer-data limitation are in `docs/API.md` ("Reports").

---

## 7. API conventions

All endpoints start with `/api/`. They use normal REST methods:

| Method | Meaning | Example |
|---|---|---|
| GET | read | `GET /api/tables?status=available` |
| POST | create / action | `POST /api/sessions` (start), `POST /api/sessions/:id/end` |
| PATCH | change some fields | `PATCH /api/tables/:id` |
| DELETE | remove | `DELETE /api/tables/:id` |

Every response has the same shape:

```json
{ "success": true,  "message": "Session started", "data": { } }
{ "success": false, "message": "Table 3 already has an active session" }
{ "success": false, "message": "…", "errors": [ { "field": "tableNumber", "message": "Table number is required" } ] }
```

| Status | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | invalid input |
| 401 | not logged in |
| 403 | logged in, but your role isn't allowed |
| 404 | not found |
| 409 | conflict (duplicate, double booking, table busy) |
| 500 | unexpected server error |

Full endpoint documentation goes in `docs/API.md`, phase by phase.

---

## 8. UI plan

- **Dark premium theme:** black background, charcoal cards, emerald-green accents. All colours live as variables in `theme.css`.
- **Sidebar navigation**, which collapses to a menu button on phones.
- **Shared components** (written once in `js/core/ui.js`): toast notifications, confirm dialogs, loading spinners, empty states, friendly error messages.
- **Responsive:** works on desktop, tablet and phone.

---

## 9. Development phases

Each phase ended with a **testing checklist**; the next phase started only after confirmation. All phases are done.

| # | Phase | Main result |
|---|---|---|
| 1 | **Architecture** *(this document)* | ✅ Plan, structure, database design (updated to the build in 11.8) |
| 2 | Setup & foundation | ✅ Portable MongoDB (`npm run db`), Express server, error handling, dark UI shell with sidebar |
| 3 | Table management | ✅ Table CRUD API + page, status, search/filter |
| 4 | Sessions | ✅ Start/end on the server clock, live timer, one open session per table, history (no pause/resume) |
| 5 | Billing & payments | ✅ Rate list, who pays, tax, part payments, receipts, cancel unpaid bills, billing tests (no discounts) |
| 6 | Dashboard | ✅ Live cards, running sessions, recent bills, sessions and bookings |
| 7 | Bookings & customers | ✅ Reservations without overlaps, check-in, automatic no-show, customer profiles and history |
| 8 | Authentication & roles | ✅ Login, users page, admin/staff/cashier permissions, audit fields (customer self-booking was dropped: customers are for bookings only) |
| 9 | Reports & charts | ✅ Revenue (chart + daily), payments by method, game types, table performance + Observed Utilization (estimate), bookings (status filter applies to totals, days and CSV; rates only for all statuses), customers, outstanding bills; Karachi date presets; CSV export; print |
| 10 | Café products & inventory | ✅ Categories, products (price, count stock or made to order), stock movements, session café tab, café items on bills with a café payer rule (loser / consumer / split), stock taken on billing and returned on cancel; browser tests moved into `tests/browser/` |
| 11 | Players & matches | 11.1 game-mode registry ✅, 11.2 players ✅, 11.3 game prices ✅, 11.4 matches (session → matches → players → result) ✅, 11.5 billing from matches (one bill per match) ✅, 11.6 café consumers & player history/outstanding ✅, 11.7 Matches & Players reports ✅, 11.8 final checks (bill as source of truth, café tab on the last match, page guard, start-up messages, admin password reset, test safety, docs) ✅ — **Phase 11 complete** |

### npm packages (each added in the phase that needs it)

| Package | Used for | Phase |
|---|---|---|
| `express` | web server and API | 2 |
| `mongoose` | talking to MongoDB, schemas, validation | 2 |
| `dotenv` | reading `.env` | 2 |
| `helmet` | security headers | 2 |
| `nodemon` *(dev)* | restart the server automatically when you save a file | 2 |
| `express-validator` | checking request input | 3 |
| `cookie-parser` | reading the login cookie (hashing, tokens and rate limiting use Node's built-in `crypto`; see section 6) | 8 |
| `chart.js` | the revenue chart. An unchanged copy of the npm file is kept in `client/vendor/chart.umd.min.js` (with its MIT licenses), served at `/vendor/chart.umd.min.js` locally and on Vercel, so it is a local file (the security policy allows only this site's scripts) | 9 |
