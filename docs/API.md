# Snooker Club Pro — API Reference

Base URL: `http://localhost:3000/api` (same address as the website).

Every response is JSON with the same shape:

```json
{ "success": true,  "message": "…", "data": … }
{ "success": false, "message": "…", "errors": [ { "field": "…", "message": "…" } ] }
```

`errors` only appears when specific fields are invalid.

**Query values (Phase 11.8):** every query parameter takes **one** value. A key given twice (`?page=1&page=2`) is refused with **400** `"page" can only be given once` (with an `errors` entry), before anything else is checked.

**Login required (Phase 8).** Every endpoint needs a login **except** `GET /api/health`,
`POST /api/auth/login`, `POST /api/auth/logout` and `GET /api/auth/me` (which answers 401 when logged out).
The browser handles the login cookie automatically. With `curl.exe`, log in once and keep the cookie in a file:

```powershell
curl.exe -c cookies.txt -H "Content-Type: application/json" -d '{\"username\":\"owner\",\"password\":\"YOUR-PASSWORD\"}' http://localhost:3000/api/auth/login
curl.exe -b cookies.txt http://localhost:3000/api/tables      # add -b cookies.txt to every example below
```

Delete `cookies.txt` when done: it is a live login.

| Status | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | invalid input (including a body that isn't valid JSON) |
| 401 | not logged in, or the login expired / was ended: `"Please log in to continue."` |
| 403 | logged in, but your role may not do this: `"You don't have permission to do this."` (also: a POST/PATCH/DELETE from another website) |
| 404 | endpoint or record not found (only checked **after** login and permission, never used to hide a 403) |
| 409 | conflict (duplicate value, busy table, overlapping booking) |
| 413 | request body too large (limit 100 KB) |
| 429 | too many failed logins: try again later |
| 500 | unexpected server error (details only in the server log) |
| 503 | database not available |

---

## Health

### `GET /api/health`

Checks that the server is running and the database is connected.

**200 OK**
```json
{
  "success": true,
  "message": "Server and database are healthy",
  "data": {
    "server": "running",
    "database": "connected",
    "version": "0.11.0",
    "uptimeSeconds": 42,
    "serverTime": "2026-10-02T10:15:00.000Z"
  }
}
```

**503 Service Unavailable**: the server runs, but MongoDB is not connected
```json
{
  "success": false,
  "message": "Database is not connected",
  "data": { "server": "running", "database": "disconnected", "…": "…" }
}
```

PowerShell:
```powershell
curl.exe http://localhost:3000/api/health
```

---

## Tables

**Money:** `hourlyRate` is always a **whole number of paisa**. Rs 600.50 is sent and returned as `60050`.
The web page converts what you type into paisa for you.

A table looks like this:
```json
{
  "id": "6abf8f92c598117694040fe2",
  "tableNumber": 3,
  "name": "VIP Table",
  "hourlyRate": 60000,
  "status": "available",
  "createdAt": "2026-10-02T11:03:46.881Z",
  "updatedAt": "2026-10-02T11:03:46.881Z"
}
```

| Field | Rules |
|---|---|
| `tableNumber` | required, whole number 1–999, **unique** |
| `name` | optional text, max 50 characters (spaces at the ends are removed) |
| `hourlyRate` | required, whole number of paisa, 0 – 10,000,000 (Rs 0 – Rs 100,000) |
| `status` | `available` (default) · `occupied` · `reserved` · `maintenance` |

### `GET /api/tables`
Lists tables, sorted by table number.

| Query | Example | Meaning |
|---|---|---|
| `status` | `?status=available` | only tables with this status |
| `search` | `?search=vip` or `?search=3` | name contains the text (any case), or the exact table number |

### `GET /api/tables/summary`
Counts per status (used by the dashboard).
```json
{ "success": true, "message": "Table summary fetched successfully",
  "data": { "total": 5, "available": 2, "occupied": 1, "reserved": 1, "maintenance": 1 } }
```

### `GET /api/tables/:id`
One table. `404` if it doesn't exist, `400` if the id is not a valid id.

### `POST /api/tables` → `201`
```json
{ "tableNumber": 3, "name": "VIP Table", "hourlyRate": 60000, "status": "available" }
```
Errors: `400` invalid fields (with an `errors` list), `409` table number already used.
```json
{ "success": false, "message": "Please correct the highlighted fields",
  "errors": [ { "field": "tableNumber", "message": "Table number is required" },
              { "field": "hourlyRate",  "message": "Hourly rate is required" } ] }
```

### `PATCH /api/tables/:id`
Send only the fields you want to change, e.g. `{ "status": "maintenance" }`.
Errors: `400` (no fields / invalid values), `404`, `409` (number taken by another table).

### `DELETE /api/tables/:id`
Deletes a table, **except** when (→ `409` with an explanation):
- its status is `occupied`
- it has an active session (checked from Phase 4)
- it has an upcoming `pending`/`confirmed` booking (checked from Phase 7)

### PowerShell examples
```powershell
$T = "http://localhost:3000/api/tables"

# Add
curl.exe -X POST $T -H "Content-Type: application/json" -d '{\"tableNumber\": 1, \"name\": \"VIP Table\", \"hourlyRate\": 60000}'

# List / filter / search / summary
curl.exe $T
curl.exe "$T?status=available"
curl.exe "$T?search=vip"
curl.exe "$T/summary"

# Edit (use the "id" from the list) / delete
curl.exe -X PATCH "$T/<id>" -H "Content-Type: application/json" -d '{\"status\": \"maintenance\"}'
curl.exe -X DELETE "$T/<id>"
```

### Rules shared with Sessions (Phase 4)
- `occupied` **cannot be set by hand** (`400 "A table becomes occupied automatically when a session starts"`).
  Starting a session sets it; ending the session sets the table back to `available`.
- While a session runs, `PATCH` may change `name`, `tableNumber` and `hourlyRate`, but not `status` (`409`).
- A table marked `occupied` *without* a running session (e.g. after a crash) can be set back to `available` by hand.

---

## Sessions

A session is one period of play on a table. Times are set by the **server clock** and stored in UTC;
date filters use the club's timezone (`CLUB_TIMEZONE`, default `Asia/Karachi`).

```json
{
  "id": "6abfa3059…",
  "table": "6abf8f92c…",
  "tableNumber": 1,
  "tableName": "VIP",
  "hourlyRateAtStart": 80000,
  "status": "completed",
  "isOpen": false,
  "startedAt": "2026-10-02T11:31:00.000Z",
  "endedAt": "2026-10-02T12:33:03.000Z",
  "durationSeconds": 3723,
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `tableNumber`, `tableName` and `hourlyRateAtStart` are **copies taken at the start**, so history stays correct
  if the table is renamed or re-priced later. `hourlyRateAtStart` is a record only: bills are priced from the rate list (Settings), never from the table's hourly rate.
- `status`: `active` (running) or `completed`. `durationSeconds` is calculated by the server when the session ends.

### `POST /api/sessions` → `201`: start
```json
{ "tableId": "6abf8f92c598117694040fe2" }
```
Only works on an **available** table. The table becomes `occupied`.

| Error | When |
|---|---|
| `400` | `tableId` missing or not a valid id |
| `404` | table not found |
| `409` | table is occupied / reserved / under maintenance, e.g. `"Table 2 is reserved. A session can only start on an available table."` |

Two people pressing Start at the same moment: exactly one session is created, the other gets `409`.

### `POST /api/sessions/:id/end` → `200`: end
Saves `endedAt` and `durationSeconds`, and sets the table back to `available`.
`409` if the session has already ended, `404` if it doesn't exist.

### `GET /api/sessions/active`
Running sessions (oldest first) plus the server's current time, used by the live timers.
```json
{ "success": true, "message": "Active sessions fetched successfully",
  "data": { "serverTime": "2026-10-02T12:34:22.800Z", "sessions": [ { "…": "…" } ] } }
```

### `GET /api/sessions`: history
| Query | Example | Meaning |
|---|---|---|
| `status` | `completed` / `active` | filter by status |
| `from`, `to` | `2026-10-02` | club-local days, **inclusive** (by start time) |
| `search` | `vip` or `3` | table name contains (any case), or exact table number |
| `page`, `limit` | `page=2&limit=20` | paging (limit 1–100, default 25) |

```json
{ "success": true, "message": "Sessions fetched successfully",
  "data": { "serverTime": "…", "sessions": [ … ], "total": 27, "page": 1, "limit": 20, "totalPages": 2 } }
```
`400` for invalid dates, `to` before `from`, or an unknown status.

### `GET /api/sessions/:id`
One session. `404` / `400` as usual.

### PowerShell examples
```powershell
$S = "http://localhost:3000/api/sessions"

# Start (use a table "id" from GET /api/tables)
curl.exe -X POST $S -H "Content-Type: application/json" -d '{\"tableId\": \"<table id>\"}'

# Running sessions / history for one day / search
curl.exe "$S/active"
curl.exe "$S?status=completed&from=2026-10-02&to=2026-10-02"
curl.exe "$S?search=vip"

# End (use the session "id")
curl.exe -X POST "$S/<session id>/end"
```

The history list (`GET /api/sessions`) also includes each session's bill since Phase 5:
`"bill": { "id", "billNumber", "status", "total", "amountPaid" }`, or `null` if it isn't billed yet.

---

## Café: categories, products, stock and session tabs (Phase 10)

Who may do what (`server/config/permissions.js`):

| Permission | Admin | Staff | Cashier | Endpoints |
|---|:-:|:-:|:-:|---|
| `cafe:view` | ✅ | ✅ | ✅ | `GET /categories…`, `GET /products…`, `GET /sessions/:id/cafe-items` |
| `cafe:sell` | ✅ | ✅ | ✅ | `POST/PATCH/DELETE /sessions/:id/cafe-items…` |
| `products:manage` | ✅ | ❌ | ❌ | `POST/PATCH/DELETE /categories…` and `/products…` |
| `stock:restock` | ✅ | ✅ | ❌ | `POST /products/:id/restock` |
| `stock:adjust` | ✅ | ❌ | ❌ | `POST /products/:id/adjust` |
| `stock:view` | ✅ | ✅ | ❌ | `GET /stock-movements`, `GET /products/:id/movements` |

### Categories: `/api/categories`

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/categories` | `?search=`. Each has `productCount` and `activeProductCount` |
| GET | `/api/categories/:id` | one category |
| POST | `/api/categories` → `201` | `{ "name": "Cold drinks" }`. 2–100 characters, spaces tidied; **unique without looking at capital letters**, otherwise 409 "Category name already exists" |
| PATCH | `/api/categories/:id` | `{ "name" }`. Renaming to another case of its own name is fine |
| DELETE | `/api/categories/:id` | 409 "Cannot delete this category because it has N product(s)…" while it has products |

### Products: `/api/products`

```json
{ "id": "…", "name": "Cola", "category": { "id": "…", "name": "Cold drinks" }, "price": 8000,
  "trackStock": true, "stockQuantity": 8, "lowStockLimit": 5, "isLowStock": false, "status": "active",
  "reservedQuantity": 2, "availableQuantity": 6, "createdBy": { "…" }, "updatedBy": { "…" } }
```

- `price`: paisa.
- `reservedQuantity`: how many are on open session tabs.
- `availableQuantity`: stock minus reserved, or `null` for products that don't count stock.
- `isLowStock`: `trackStock` and `stockQuantity ≤ lowStockLimit`.

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/products` | `?search&categoryId&status=active\|inactive\|all&lowStock=true&trackStock=true\|false` |
| GET | `/api/products/:id` | one product |
| POST | `/api/products` → `201` | `{ name, categoryId, price, trackStock?, stockQuantity?, lowStockLimit?, status? }`. Name 2–100 characters, **unique within its category** (capitals and spaces don't matter; 409). Price Rs 0–100,000. Stock is a whole number 0–1,000,000 (starting stock is recorded as an "initial" history line). Low-stock limit defaults to 5 |
| PATCH | `/api/products/:id` | any of `name, categoryId, price, trackStock, lowStockLimit, status`. **`stockQuantity` is refused** (400 "Stock can't be edited here. Use Restock or Adjust stock…") |
| DELETE | `/api/products/:id` | only for products that were never ordered, sold or restocked; otherwise 409 "…can't be deleted. Set it to inactive instead…" |
| POST | `/api/products/:id/restock` → `201` | `{ "quantity": 24, "reason": "optional" }` |
| POST | `/api/products/:id/adjust` → `201` | `{ "type": "adjustment", "quantity": -2, "reason": "Counted 22" }`, or `{ "type": "waste", "quantity": 3, "reason": "Broken" }`. A reason is required. 409 if stock would go below 0 |
| GET | `/api/products/:id/movements` | that product's stock history |

**Stock rules:**
- Stock only changes together with a **stock movement** record:
  - `initial`, `restock`, `sale`, `sale_reversal`, `adjustment`, `waste`
  - each records the change (+/−), `balanceAfter`, `reason`, the bill (for sales), and `createdBy`
- Every decrease is **one atomic database update** that only succeeds if enough stock is there at that moment. Overselling and negative stock are impossible, even with many people at once.
- Products with `trackStock: false` have no stock operations (409).

### Stock history: `GET /api/stock-movements`
Query: `productId`, `type`, `from`/`to` (club days), `page`, `limit`. Newest first.

### Session café tab: `/api/sessions/:sessionId/cafe-items`

Items ordered **during** a session. The tab can be changed until the session gets a bill for the **whole session** (409 after that). Match bills (Phase 11.5) don't close it: the session may have more matches, and open items go onto the next match bill (see "Match bills").

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/sessions/:id/cafe-items` | `{ session, billed, bill, items, openTotal, openCount }`. Items are `open` or `billed` (removed ones are kept in the database but not listed) |
| POST | `/api/sessions/:id/cafe-items` → `201` | `{ productId, quantity, consumer? }` or `{ description, unitPrice, quantity, consumer? }`. The name and price are **copied now**. The product must be active, and enough must be free (stock − items on other open tabs), otherwise 409 "Only 1 Cola available" / "Cola is out of stock" |
| PATCH | `/api/sessions/:id/cafe-items/:itemId` | `{ quantity?, consumer? }`, open items only |
| DELETE | `/api/sessions/:id/cafe-items/:itemId` | marks the item `removed` (kept for history), open items only |

Stock is **not** taken when an item is added to the tab. It is taken when the bill is created (see Bills).

`consumer` ("who had it") is optional text, up to **60** characters since Phase 11.6 (was 40), so a registered player's full name fits. When a match bill is made, it is matched to one of the match's players (capital letters don't matter). A registered player is then saved on the bill line with their reference (`consumerPlayer`); a walk-in by name only.

---

## Game modes (Phase 11.1, pricing 11.3)

### `GET /api/game-modes`
- **Who:** every logged-in role (`sessions:view`). 401 when logged out.
- **What:** every game mode from the central registry (`server/config/gameModes.js`), with today's rate.
- **Purpose:** pages build their mode lists, labels and rate fields from this answer, never from typed lists.

```json
[ { "key": "century", "label": "Century", "minPlayers": 2, "maxPlayers": null, "pricingType": "per_minute",
    "rateUnit": { "one": "minute", "many": "minutes" }, "defaultRate": 1000,
    "quantityLabel": { "one": "game", "many": "games" }, "resultType": "winner_loser", "teams": null,
    "enabled": true, "rate": 1000, "rateSet": true },
  { "key": "frame", "pricingType": "per_frame", "rateUnit": { "one": "frame", "many": "frames" }, "defaultRate": 25000, "rate": 25000, "...": "..." },
  { "key": "snooker_point", "label": "Snooker Point", "minPlayers": 3, "maxPlayers": 3, "pricingType": "fixed", "defaultRate": 35000,
    "enabled": false, "rate": 35000, "...": "..." },
  { "key": "four_player", "label": "4 Players", "minPlayers": 4, "maxPlayers": 4, "resultType": "teams", "pricingType": "fixed", "defaultRate": 50000,
    "teams": [ { "key": "A", "seats": [1, 2] }, { "key": "B", "seats": [3, 4] } ], "enabled": false, "rate": 50000, "...": "..." } ]
```

- `maxPlayers: null` means no limit.
- `pricingType`:
  - `per_minute`: billed minutes × rate (Century)
  - `per_frame`: frames × rate (Frame)
  - `fixed`: one rate per game (Snooker Point, 4 Players)
- `rate` is paisa per `rateUnit`, as it applies today (see Settings below). `rateSet: false` means an admin set it to Rs 0, so bills for that mode are refused.
- `enabled` means the mode can be used in the Create Bill window (`POST /api/bills`); today that is Century and Frame. Every mode can be billed from a completed match (`POST /api/matches/:id/bill`, Phase 11.5).
- `matchEnabled` (Phase 11.4) means matches of this mode can be started. All four modes are match-enabled.
- Bills only accept enabled modes. Stored keys never change, so old bills keep theirs.

---

## Players (Phase 11.2)

Registered players are **separate from booking customers**. Nothing links or creates one from the other, and no player is ever guessed from an old bill name or café text. Walk-in players (Phase 11.4) don't need to be registered.

| Method | Endpoint | Who | Notes |
|---|---|---|---|
| GET | `/api/players` | every role (`players:view`) | `?search` (name, or phone digits in any format), `status=active` (default) / `inactive` / `all`, `page`, `limit` → `{ players, total, page, limit, totalPages }`, sorted by name |
| GET | `/api/players/:id` | every role | one player |
| POST | `/api/players` → `201` | admin, staff (`players:manage`) | `{ "name": "Ali Khan", "phone": "0300-1234567", "notes": "…" }`. Phone and notes are optional |
| PATCH | `/api/players/:id` | admin, staff | any of `name`, `phone`, `notes` (others are kept). `isActive` is refused here: use the two endpoints below |
| POST | `/api/players/:id/deactivate` | admin (`players:deactivate`) | no longer offered for new games; history is kept. 409 if already inactive |
| POST | `/api/players/:id/reactivate` | admin | 409 if already active |

```json
{ "id": "…", "name": "Ali Khan", "phone": "0300-1234567", "notes": "Plays on Fridays", "isActive": true,
  "deactivatedAt": null, "createdBy": { "user": "…", "name": "…", "username": "…" }, "updatedBy": { "…": "…" },
  "createdAt": "…", "updatedAt": "…" }
```

**Rules:**
- **Name:** 2–60 characters, with extra spaces tidied (`"  Ali   Khan "` → `"Ali Khan"`).
- **Unique names:** registered names are unique **without looking at capital letters or spaces**, also against inactive players.
  - A duplicate gets 409 `A player called "Ali Khan" is already registered` (with "(inactive - reactivate them instead)" when the existing player is inactive).
  - The database's unique index also protects against two people registering the same name at the same moment.
- **Phone:** optional, 7–20 digits (spaces, `-` and a leading `+` allowed).
- **Notes:** optional, up to 200 characters.
- **No delete:** a player can't be deleted, only deactivated, so future matches and bills can always point back to them.
- **No stored statistics:** there are no counters such as games, wins, spending or outstanding. They are worked out from the match and bill records (see the history endpoints below).

### Player history (Phase 11.6)

```
Player → Match → Bill → Payment
Player → Café consumer → Bill
```

| Method | Endpoint | Who | Notes |
|---|---|---|---|
| GET | `/api/players/:id/matches` | every role (`players:view` + `matches:view`) | `?page`, `limit` (default 10, max 100) → `{ player, stats, matches, total, page, limit, totalPages }`, newest first |
| GET | `/api/players/:id/bills` | every role (`players:view` + `bills:view`) | `?status` (`open` = unpaid + partially paid, or one bill status), `page`, `limit` → `{ player, summary, bills, total, page, limit, totalPages }`, newest first |

- **Read-only.** 404 for an unknown player, 400 for a bad id or filter. An inactive player's history can still be read.
- **Found by reference only:** matches by `players.player`, bills by the bill's `players.player` (match bills, Phase 11.5).
  - Walk-ins have no reference, so they have no history.
  - Whole-session bills (the Create Bill window) and every bill made before Phase 11.5 keep free-text names only. They are **never** matched to a player by name, so they are not in anyone's history.

**`stats`** (matches): `{ total, completed, inProgress, cancelled, wins, losses }`, counted from the match records each time. Wins and losses count completed matches only.

**A match row:**
```json
{ "id": "…", "number": 3, "session": "…", "tableNumber": 2, "tableName": "Bravo", "gameMode": "four_player",
  "status": "completed", "startedAt": "…", "endedAt": "…", "nameInMatch": "Ali", "result": "winner", "team": 1,
  "winningTeam": 1, "losingTeam": 2,
  "teammates": [ { "name": "Mate", "registered": false, "result": "winner", "team": 1 } ],
  "opponents": [ { "name": "Ahmed", "registered": true, "result": "loser", "team": 2 }, { "name": "Zed", "...": "..." } ],
  "bill": { "id": "…", "billNumber": "B-20261007-0003", "status": "unpaid" } }
```
- `nameInMatch` is the copy saved in the match, so a later rename doesn't change it.
- `teammates` is empty outside 4 Players.
- `bill` is `null` until the match is billed.

**A bill row:**
```json
{ "id": "…", "billNumber": "B-20261007-0001", "createdAt": "…", "gameMode": "frame", "match": "…", "matchNumber": 1,
  "tableNumber": 1, "tableName": "Alpha", "payerRule": "loser", "cafePayerRule": "consumer", "status": "partially_paid",
  "total": 70000, "amountPaid": 10000, "balanceDue": 60000,
  "share": { "name": "Ali", "result": "winner", "team": null, "shareAmount": 15000, "paidAmount": 10000, "outstanding": 5000,
             "gameShare": 0, "cafeShare": 15000 },
  "cafeItems": [ { "description": "Tea", "quantity": 1, "amount": 15000 } ] }
```
- `total` / `amountPaid` / `balanceDue` are the **whole bill**.
- `share` is **this player's part**. `paidAmount` is what this player has paid: every payment adds to it in the same atomic update as the bill (see `POST /api/bills/:id/payments`).
- `cafeItems` are the café lines whose `consumerPlayer` is this player.

**`summary`** (over **all** the player's bills, not just the page):

| Field | Meaning |
|---|---|
| `bills` | bills that aren't cancelled |
| `cancelledBills` | cancelled bills |
| `totalShare` / `totalPaid` | the player's shares / payments on bills that aren't cancelled |
| `outstanding` | Σ (share − paid) on **unpaid and partially paid** bills. Paid bills give 0, and **cancelled bills give 0** (nothing is owed on them) |
| `openBills` | bills on which this player still owes something |

Example: a Rs 500 bill that the player pays alone, with Rs 300 paid → outstanding Rs 200. The two losers of a 4 Players match each owe their own Rs 250: one paying doesn't change the other's outstanding.

---

## Matches (Phase 11.4)

`Table → Session → Match → Players → Result`. A match always belongs to one session, and **a session can have any number of matches**. One frame is one match.
- **No clock and no price on a match:** the session is the clock. The bill copies the rate when it is created (see "Match bills" below).
- **`bill`:** the match's bill once one is made (Phase 11.5), otherwise `null`. The session's match list also returns `billInfo: { id, billNumber, status, total, amountPaid }` or `null`.

| Method | Endpoint | Who | Notes |
|---|---|---|---|
| GET | `/api/sessions/:sessionId/matches` | every role (`matches:view`) | the session's matches, `#1` first. 404 if the session doesn't exist |
| POST | `/api/sessions/:sessionId/matches` → `201` | every role (`matches:manage`) | start a match; the session must be **running** (409 otherwise) |
| GET | `/api/matches/:id` | every role | one match |
| PATCH | `/api/matches/:id` | every role (`matches:manage`) | `{ "players": [...], "gameMode"? }`: fix the players (and game type) while **in progress** |
| POST | `/api/matches/:id/complete` | every role (`matches:manage`) | `{ "winnerSeat": 2 }`, or for 4 Players `{ "winningTeam": 1 }` |
| POST | `/api/matches/:id/cancel` | admin, staff (`matches:cancel`) | `{ "reason"? }` (max 200 characters) |
| POST | `/api/matches/:id/result` | every role (`matches:manage`); admin only once the match's bill has payments (`matches:correct-paid`) | change the result of a **completed** match. Bills are never changed |

**Start request:**
```json
{ "gameMode": "four_player",
  "players": [ { "playerId": "6f1…", "team": 1 }, { "playerId": null, "name": "Guest", "team": 1 },
               { "playerId": null, "name": "Saad", "team": 2 }, { "playerId": "6f2…", "team": 2 } ] }
```
- `playerId` = a registered, **active** player. Their current name is copied into the match. An unknown id gets 400; a deactivated player gets 409.
- `playerId: null` + `name` = a walk-in (1–40 characters). No Player or Customer is created for them.
- `team` is only for 4 Players.

**Answer (a match):**
```json
{ "id": "…", "session": "…", "number": 3, "table": "…", "tableNumber": 1, "tableName": "VIP",
  "gameMode": "four_player", "status": "completed",
  "players": [ { "player": "6f1…", "name": "Ali", "seat": 1, "team": 1, "result": "winner", "score": null }, "…" ],
  "teams": [ { "number": 1, "name": "Team 1", "seats": [1, 2] }, { "number": 2, "name": "Team 2", "seats": [3, 4] } ],
  "winnerSeat": null, "winningTeam": 1, "losingTeam": 2,
  "startedAt": "…", "endedAt": "…", "resultRecordedAt": "…", "resultRecordedBy": { "…": "…" },
  "cancelledAt": null, "cancelledBy": null, "cancelReason": "", "bill": null,
  "createdBy": { "…": "…" }, "updatedBy": { "…": "…" }, "createdAt": "…", "updatedAt": "…" }
```

**Rules:**
- **Players per game type** (from the game-mode registry):
  - Century and Frame: 2 or more (a request may carry at most 20, as a size limit)
  - Snooker Point: exactly 3
  - 4 Players: exactly 4
  - Otherwise 400 `"Snooker Point needs exactly 3 players"`.
- **No duplicates in one match:** the same registered player twice gets 400 `"Ali is already in this match"`. The same name twice gets 400 `Each player needs a different name ("ali" is there twice)`. A player can play any number of different matches.
- **4 Players:** two teams of exactly two (`"Each team needs exactly 2 players (Team 1 has 3)"`). Team 1 gets seats 1–2 and Team 2 seats 3–4, whatever order the players were sent in. Other modes refuse `team`.
- **Result:**
  - `winnerSeat` must be one of the match's seats. The winner gets `result: "winner"` and everyone else `"loser"`.
  - 4 Players needs `winningTeam` (1 or 2). Its two players are winners, and `losingTeam` and its players are losers.
  - The wrong kind of result for the mode gets 400.
- **Lifecycle:** `in_progress` → `completed` or `cancelled`, nothing else. Anything else gets 409, e.g. `"Match #2 is cancelled, so it can't be completed"`. There is no reopening and no DELETE.
- **At the same moment:** complete, cancel, edit and change-result are single conditional updates, so when two people act at once exactly one succeeds and the other gets 409. Match numbers come from an atomic counter (no duplicate `#2`).
- **Ended session:** no new match (409), but its in-progress matches can still be completed or cancelled.

---

## Settings (rate list, time rule, tax)

### `GET /api/settings`
```json
{ "gameRates": { "century": 1000, "frame": 25000, "snooker_point": 35000, "four_player": 50000 },
  "centuryPrice": 0, "framePrice": 0,
  "minimumBillableMinutes": 15, "billingIncrementMinutes": 5,
  "taxEnabled": false, "taxRateBasisPoints": 0, "noShowGraceMinutes": 15, "currency": "PKR" }
```
- Prices are in **paisa**. `taxRateBasisPoints`: 1600 = 16%.
- **`gameRates` (Phase 11.3)** are the rates that apply **today**, one per game mode:
  - `century`: per **billed minute** (Rs 10 = `1000`)
  - `frame`: per frame
  - `snooker_point` and `four_player`: per game
  - Each one is, in order:
    1. the rate an admin saved;
    2. otherwise, for Frame only, the older `framePrice` when it is above 0;
    3. otherwise the default (Century Rs 10/min, Frame Rs 250, Snooker Point Rs 350, 4 Players Rs 500).
  - Settings saved before Phase 11.3 therefore keep working with no migration.
  - A rate of 0 switches that game type off: its bills are refused with 409.
- **Older fields:**
  - `framePrice` is kept in step with `gameRates.frame`.
  - `centuryPrice` (the old price per century **game**) is kept as stored but is **no longer used**. Century is charged per minute; its old per-game price is never turned into a per-minute rate.

### `PATCH /api/settings` (admin only)
- Send only what changes, e.g. `{ "gameRates": { "century": 1200 } }` (any of the four modes; the others are kept).
- Older clients may still send `framePrice`, which also sets `gameRates.frame`. Sending both with different values gets 400.
- `centuryPrice` is still accepted and stored, but has no effect on bills.
- Rates must be whole paisa, Rs 0 to Rs 100,000 (`"Century rate must be between Rs 0 and Rs 100,000"`). Unknown modes get 400.
- Changes affect **new** bills only, because every bill keeps a copy of the rate it was made with.
- **Backups:** `backupEnabled` (true/false), `backupIntervalHours` (whole number, 1 to 168, default 12), `backupKeepCount` (1 to 365, default 30).
  `GET` also returns the status fields `lastBackupAt`, `lastBackupFile`, `lastBackupAttemptAt` and `lastBackupError`. Only the backup service writes them; PATCH ignores them.

---

## Backups (XML, admin only)

### `GET /api/backups`
```json
{ "folder": "D:\\SnookerClubPro-Backups", "onSystemDrive": false,
  "enabled": true, "intervalHours": 12, "keepCount": 30,
  "lastBackupAt": "2026-10-10T16:00:00.000Z", "lastBackupFile": "snooker-backup-2026-10-10_21-00-00.xml",
  "lastBackupAttemptAt": "2026-10-10T16:00:00.000Z", "lastBackupError": null,
  "nextBackupAt": "2026-10-11T04:00:00.000Z", "running": false,
  "files": [{ "file": "snooker-backup-2026-10-10_21-00-00.xml", "size": 8078, "modifiedAt": "2026-10-10T16:00:00.120Z" }] }
```
- `nextBackupAt`: null when automatic backups are off. After a failed backup the next try is at least 15 minutes later.
- `files`: newest first. Both `snooker-backup-…` and `snooker-before-restore-…` files are listed.

### `POST /api/backups`
"Backup Now": makes a backup at once → `201` with `{ file, size, createdAt, counts }` (`counts` = records per collection).
- `409` while another backup is being made.
- `503` when the database isn't connected.
- Afterwards the oldest `snooker-backup-…` files beyond `backupKeepCount` are deleted.

### `GET /api/backups/:file`
Downloads one backup file. Only exact backup file names in the backup folder are accepted; anything else gets `404`.

---

## Bills

There are two kinds of bill. The server calculates both; the browser only sends what was played.
- **A bill for a whole session** (this section, `POST /api/bills`): one per **finished** session. This is how every bill before Phase 11.5 was made, and how sessions without matches are still billed. These bills have no `match`.
- **A bill for one match** (Phase 11.5, see "Match bills" below): one per **completed** match, so a session with matches has one bill per match.

The database refuses a second bill of either kind (unique index `{ session, match }`), and the server refuses to mix the two kinds in one session:
- 409 `"The session on Table 3 has matches. Bill each completed match from the Matches window."`
- 409 `"This session was billed as a whole (bill B-…), so its matches can't be billed separately."`

A session whose matches were all cancelled can still be billed as a whole.

### `POST /api/bills` → `201`
```json
{
  "sessionId": "6ac3…",
  "gameMode": "frame",
  "quantity": 2,
  "payerRule": "split",
  "players": [ { "name": "Ali" }, { "name": "Usman" }, { "name": "Bilal" } ],
  "cafeItems": [ { "description": "Tea", "quantity": 2, "unitPrice": 8000 } ]
}
```

| Field | Rules |
|---|---|
| `gameMode` | `century` (since Phase 11.3: billed minutes × the per-minute rate) or `frame` (frames × the frame rate) |
| `quantity` | games/frames played, 1–100. For Century it is recorded (reports count games) but does not change the price |
| `payerRule` | `loser`: the player with `"result": "loser"` pays all; `winner`: the player with `"result": "winner"` pays all; `split`: equal parts (shown as **"Both Pay"**; the stored value stays `split`. The UI labels are **Loser Pays / Winner Pays / Both Pay**, Phase 11.6) |
| `players` | 2–4, different names; `result` is `winner`, `loser` or null |
| `cafeItems` | optional, max 20 lines. Each line is a **product** `{ "productId", "quantity" }` (name, category and today's price come from the product; stock is checked) **or** a **typed-in** item `{ "description", "quantity", "unitPrice" }` (as before Phase 10). Either may add `"consumer"`: the name of the player who had it |
| `cafePayerRule` | optional (Phase 10): `loser`, `consumer` or `split`. Who pays the café part. **Left out: the café follows `payerRule`, exactly like before Phase 10** |
| `tabItems` | optional (Phase 10): `[ { "id", "consumer" } ]`, saying who had each item already on the session's café tab |

**Phase 10, café on the bill:**
- **What goes on the bill:** every *open* item on the session's café tab (`/api/sessions/:id/cafe-items`) is put on the bill automatically, plus the `cafeItems` above.
  - Café lines keep copies: `description`, `unitPrice`, `categoryName`, `product` (id), `consumer`, and `cafeOrder` (the tab item).
  - Changing a product, a price or a category later never changes the bill.
- **Who pays the café** (`cafePayerRule`):
  - `loser`: the player marked loser pays all café items (a loser must be marked)
  - `split`: equal parts
  - `consumer`: each player pays for the items they had. Every café line needs a `consumer` that is one of the bill's players; otherwise 400 "Consumer pays: choose which player had …".
  - **Tax:** the game part gets the tax the game alone would have; the café gets the rest. With `consumer`, the café tax is shared in proportion to what each player had, and odd paisa go to the first consumers.
  - **Shares:** each player's `shareAmount` = `gameShare` + `cafeShare`, and both parts are returned. If both rules are `split`, the whole total is split at once, exactly as before.
- **Stock:**
  - Taken when the bill is **created** (not at preview), with one atomic update per counted product (`stockQuantity ≥ needed`). All or nothing: if any product is short, 409 "Not enough stock: Cola has 0 left, this bill needs 1", and no stock, bill or bill number is used.
  - A "sale" history line is written per product.
  - Products that don't count stock (`trackStock: false`) are never short.
  - An inactive product can't be added in the bill window (409), but items already on the tab still bill.
- **Cancel** (`POST /api/bills/:id/cancel`, unpaid bills only, as before): the stock the bill took is put back, with "sale_reversal" history lines.

Response (shortened):
```json
{ "billNumber": "B-20261005-0001", "tableNumber": 1, "durationSeconds": 2830, "billedMinutes": 50,
  "gameMode": "frame", "quantity": 2, "unitPrice": 15000,
  "lineItems": [ { "type": "game", "description": "Frames", "quantity": 2, "unitPrice": 15000, "amount": 30000 },
                 { "type": "cafe", "description": "Tea", "quantity": 2, "unitPrice": 8000, "amount": 16000 } ],
  "subtotal": 46000, "taxEnabled": false, "taxRateBasisPoints": 0, "taxAmount": 0, "total": 46000,
  "players": [ { "name": "Ali", "result": null, "shareAmount": 15334, "paidAmount": 0 }, "…" ],
  "amountPaid": 0, "balanceDue": 46000, "status": "unpaid" }
```

- `billedMinutes` comes from the time rule (at least 15 min, then rounded up to 5-minute steps). It is recorded on every bill. For **Century** (`pricingType: "per_minute"`, since Phase 11.3) it **is** the price: billedMinutes × the per-minute rate. For Frame (`per_frame`) the price is frames × rate. Century bills made before Phase 11.3 (no `pricingType`) stay "games × price per game".
- Split remainders: leftover paisa go to the first players, so shares always add up to the total.

| Error | When |
|---|---|
| `400` | invalid input (with an `errors` list) |
| `404` | session not found |
| `409` | session still running / already billed / that game type's price is not set |

### `POST /api/bills/preview`
Same body as above. Returns the calculated bill **without saving it**; the bill window uses this for its live total.

### Match bills (Phase 11.5)

| Method | Endpoint | Who | Notes |
|---|---|---|---|
| POST | `/api/matches/:id/bill/preview` | `bills:create` (every role) | the calculated bill, not saved |
| POST | `/api/matches/:id/bill` → `201` | `bills:create` (every role) | creates the match's bill. The message is `"Bill B-… created for match #2"` |
| GET | `/api/matches/:id/bill` | `bills:view` (every role) | the match's bill with its payments (404 if it has none) |

**Request:**
```json
{ "payerRule": "loser", "cafePayerRule": "consumer", "includeCafeTab": true,
  "tabItems": [ { "id": "…", "consumer": "Ali" } ] }
```
- **Can't be sent:** `gameMode`, `quantity`, `players` and `sessionId` come from the match. Sending any of them gets 400 `"The game type, players and result come from the match and can't be changed on its bill"`.
- **`includeCafeTab`:** `false` leaves the session's open café tab for a later bill (default `true`).
  - **Phase 11.8:** only while another match of the session can still be billed: a completed match without a bill, or one still in progress. A cancelled or already billed match doesn't count, nor a second Century match (the session's time is charged once), nor a game type priced Rs 0.
  - On the **last** billable match, `includeCafeTab: false` with open tab items gets **409** "This is the last match of the session that can be billed, so the session's café tab (N items) must go on this bill." Nothing is billed and no stock is taken.
  - The preview returns `cafeTabMustStay: true` in that case, so the bill window keeps the box ticked and locked.
- **`cafeItems`:** may be sent as in `POST /api/bills`.

**What the bill gets:**
- `match` and `matchNumber`; for 4 Players also `winningTeam` and `losingTeam`.
- `gameMode` from the match, `quantity: 1`, and **today's** rate as `unitPrice` with `pricingType`.
- **Century:** the line is the session's billed minutes × the per-minute rate (`"Century minutes"`).
- **Frame / Snooker Point / 4 Players:** 1 × the rate (`"Frame"`, `"Snooker Point game"`, `"4 Players game"`).
- **Players:** the match's players and results, with `player` (the registered player's id; absent for walk-ins), `team` (4 Players) and name copies.
- **Café lines:** the consumer's `consumerPlayer` when they are registered.

**Who pays (also for older bills):**
- `loser` / `winner`: every player with that result pays an equal part. The two players of a 4 Players team share it, as do the two losers of a 3-player match.
- `split` ("Both Pay"): everyone pays an equal part. A record with the value `split_equally` (never written by this app) is read the same way: everyone pays.
- Odd paisa go to the first payers, so the shares always add up to the total. With one loser or winner (every whole-session bill) nothing changed.

**Refused with 409:**
- the match is not completed: `"Match #2 must be completed before it can be billed (it is still in progress)."`
- the match's session is still running
- the match already has a bill (the database also refuses it, so two cashiers at once get one bill and one 409). Phase 11.8: decided by the bill's own `match` reference; if the match's `bill` pointer was missing, it is repaired, and never a second bill
- the game type's rate is Rs 0
- the session was billed as a whole
- a café product is short (nothing is taken)
- a second Century bill in the same session: Century is charged by the session's time, so a session can have one Century bill (also enforced by a database index)

**Café tab and several bills:** the open tab items are claimed for the bill **before** it is saved, all or nothing. Two bills of the same session made at the same moment can never take the same item (the later one gets 409 and can simply be made again). Match bills don't close the session's tab; only a whole-session bill does.

**Afterwards:**
- Changing the match result (`POST /api/matches/:id/result`) **never** changes its bill. Once the bill has payments (partly or fully paid), only an admin may change the result (`matches:correct-paid`): staff and cashier get **403**.
- **The bill is the source of truth (Phase 11.8).** The match's bill is found by the bill's `match` reference, never only by the match's `bill` pointer (a convenience copy written just after the bill). So the paid-bill rule, "already has a bill", the match list, the session counts, the Matches report and player history are all right even if that pointer was never written; a missing pointer is repaired when found.
- Cancelling the bill leaves the match completed. Like every cancelled bill, it can't be made again.
- Payments work exactly as for every bill: `POST /api/bills/:id/payments` with the player's name.

**Session lists:** `GET /api/sessions` and the dashboard's recent sessions add `matches: { total, inProgress, completed, cancelled, billed }` (or `null`). `billed` = matches whose bill is **not cancelled** (Phase 11.8, the same meaning as the Matches report; counted from the bills). `bill` remains the bill for the whole session (match bills are not put there).

### `GET /api/bills`
History, newest first. Query: `status` (`unpaid`, `partially_paid`, `paid`, `cancelled`), `from`/`to` (club-local days),
`search` (bill no., table name/number, player name), `page`, `limit`.

### `GET /api/bills/:id`
One bill plus its `payments` list.

### `POST /api/bills/:id/payments` → `201`
```json
{ "amount": 15334, "method": "cash", "payerName": "Ali", "note": "optional" }
```

- `method`: `cash`, `card`, `jazzcash`, `easypaisa`, `bank_transfer` or `other`.
- The bill status updates itself: `unpaid` → `partially_paid` → `paid`.

| Error | When |
|---|---|
| `400` | bad amount/method, or a payer who isn't on the bill |
| `409` | more than the bill's balance (`"Payment of Rs 300.01 is more than the remaining balance of Rs 300.00"`), more than that player's remaining share, or the bill is already paid / cancelled |

Payments are checked and added in **one atomic database step**, so two cashiers can't overpay a bill together.

### `POST /api/bills/:id/cancel`
Body (optional): `{ "reason": "Wrong table" }`. Only bills **without payments** can be cancelled (`409` otherwise; refunds aren't supported yet).

### PowerShell examples
```powershell
$B = "http://localhost:3000/api"
curl.exe -X PATCH "$B/settings" -H "Content-Type: application/json" -d '{\"gameRates\": {\"century\": 1000, \"frame\": 15000}}'
curl.exe -X POST "$B/bills" -H "Content-Type: application/json" -d '{\"sessionId\": \"<session id>\", \"gameMode\": \"century\", \"quantity\": 1, \"payerRule\": \"loser\", \"players\": [{\"name\": \"Ali\", \"result\": \"winner\"}, {\"name\": \"Usman\", \"result\": \"loser\"}]}'
curl.exe "$B/bills?status=unpaid"
curl.exe -X POST "$B/bills/<bill id>/payments" -H "Content-Type: application/json" -d '{\"amount\": 30000, \"method\": \"cash\", \"payerName\": \"Usman\"}'
```

---

## Dashboard

### `GET /api/dashboard/summary`
Everything the dashboard shows, calculated on the server in **one** request.
Optional `?date=YYYY-MM-DD` shows another business day (default: today in `CLUB_TIMEZONE`).

```json
{
  "serverTime": "2026-10-05T12:16:00.000Z",
  "businessDay": { "date": "2026-10-05", "timeZone": "Asia/Karachi",
                   "start": "2026-10-04T19:00:00.000Z", "end": "2026-10-05T19:00:00.000Z" },
  "tables": { "total": 5, "available": 2, "occupied": 1, "reserved": 1, "maintenance": 1 },
  "activeSessionCount": 1,
  "today": {
    "billCount": 2, "paidCount": 1, "openCount": 1, "cancelledCount": 1,
    "totalBilled": 60000, "totalPaid": 40000, "totalOutstanding": 20000,
    "paymentsReceived": 40000, "paymentCount": 2
  },
  "activeSessions": [ "…same objects as GET /api/sessions/active…" ],
  "tableOverview": [ { "…table…": "…", "activeSession": { "id": "…", "startedAt": "…" } } ],
  "recentBills": [ { "id", "billNumber", "createdAt", "tableNumber", "tableName", "players": ["Ali", "Usman"],
                     "total", "amountPaid", "balanceDue", "status" } ],
  "recentSessions": [ { "…session…": "…", "bill": { "id", "billNumber", "status", "total", "amountPaid",
                                                    "gameMode", "quantity", "billedMinutes" },
                        "matches": { "total", "inProgress", "completed", "cancelled", "billed" } } ]
}
```

How "today" is counted (all money in paisa):

| Field | Meaning |
|---|---|
| `billCount`, `totalBilled` | bills **created** today, **cancelled bills excluded** (they are not revenue) |
| `totalPaid`, `totalOutstanding` | paid / still owed on those same bills (`outstanding = billed − paid`) |
| `paidCount`, `openCount` | of those bills: fully paid / unpaid + partially paid |
| `cancelledCount` | bills cancelled today (shown separately, not counted as revenue) |
| `paymentsReceived`, `paymentCount` | money that **came in** today, including payments for bills from earlier days |

"Today" is midnight to midnight in the club's timezone (Asia/Karachi), using the same helpers as the date filters.

### Bills list: new filter
`GET /api/bills?status=open` returns everything still to collect (`unpaid` + `partially_paid`).

---

## Customers

People who book tables. `phone` is optional and **not** unique (family members may share a number).

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/customers` | `?search=` (name, or phone digits: "0300 123" finds "0300-1234567"), `?includeArchived=true`, `page`, `limit`. Each customer has `bookingCount` and `lastBookingAt` |
| GET | `/api/customers/:id` | Customer + `stats` (bookings, completed, upcoming, noShows, cancelled) + `bookings` history (each with `sessionInfo` if checked in) |
| POST | `/api/customers` | `{ "name": "Ali Raza", "phone": "0300-1234567", "notes": "" }`: name 2–60, phone 7–20 digits (spaces, `-`, leading `+`) |
| PATCH | `/api/customers/:id` | any of name, phone, notes |
| DELETE | `/api/customers/:id` | No bookings → `{ "result": "deleted" }`. Has bookings → `{ "result": "archived" }` (hidden, history kept; can't get new bookings) |

---

## Bookings

Times are entered in **club time** and converted to UTC by the server (`CLUB_TIMEZONE`, Asia/Karachi).

| Status | Meaning |
|---|---|
| `pending` | booked |
| `confirmed` | confirmed with the customer |
| `completed` | checked in, a session was started (`session` links to it) |
| `cancelled` | cancelled (frees the slot) |
| `no_show` | not checked in `noShowGraceMinutes` (default 15) after the start, so set **automatically** |

Only `pending` and `confirmed` bookings hold a time slot. Table status is **not** changed by bookings (it stays manual).

### `POST /api/bookings` → `201`
```json
{ "tableId": "…", "customerId": "…", "date": "2026-10-07", "startTime": "18:30", "durationMinutes": 90,
  "notes": "Birthday", "status": "confirmed" }
```

- Instead of `customerId`, send `"newCustomer": { "name": "Bilal", "phone": "" }` to create the customer at the same time.
- `startTime` is in 15-minute steps; `durationMinutes` is 30–480, in 15-minute steps.
- The start can't be in the past and can be at most 60 days ahead.
- **No double bookings:** `409 "Table 1 is already booked 6:00 pm–7:30 pm (Ali Raza)"`. Touching slots (one ends 7:30, the next starts 7:30) are fine. Even simultaneous requests can't create two bookings for one slot.

### Other endpoints
| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/bookings` | `?date=` or `?from=&to=` (club days), `status` (any status or `active` = pending + confirmed), `tableId`, `customerId`, `search` (customer, phone, table), `page`, `limit`. A day is listed in time order |
| GET | `/api/bookings/availability?date=` | Every table with that day's bookings (not cancelled), for the day view. Includes bookings that cross midnight |
| GET | `/api/bookings/:id` | one booking |
| PATCH | `/api/bookings/:id` | change `tableId`, time (`date` + `startTime` + `durationMinutes` together) or `notes`: pending/confirmed only, same overlap rule |
| POST | `/api/bookings/:id/confirm` | pending → confirmed |
| POST | `/api/bookings/:id/cancel` | `{ "reason": "…" }` (optional) |
| POST | `/api/bookings/:id/check-in` | Customer arrived. Opens 30 min before the start. Starts a session on the booked table (table must be **available or reserved**), the booking becomes `completed`. Returns `{ booking, session }`. `409` if too early, already checked in, cancelled, no-show, or the table is occupied / under maintenance |

`PATCH /api/settings` also accepts `noShowGraceMinutes` (5–120).
`GET /api/dashboard/summary` also returns `today.bookingCount` and `upcomingBookings`.

---

## Login (Auth)

The login is an **httpOnly cookie** named `scp_session`:
- `SameSite=Strict`, `Secure` when `COOKIE_SECURE=true`, and it lasts `SESSION_TTL_HOURS`.
- It holds a random token. The database stores only a keyed hash (HMAC-SHA256) of it, so a database copy can't be used to log in.
- JavaScript can't read the cookie.

### `POST /api/auth/login` (public)
```json
{ "username": "owner", "password": "…" }
```
- **200** `"Welcome, Owner Name"`: sets the cookie. Returns `{ id, name, username, role, active, permissions }`.
- **401** `"Invalid username or password."`: the same text for a wrong password, an unknown user and a deactivated user.
- **429** `"Too many login attempts. Please wait N minute(s) and try again."`: after 5 failures for one username, or 20 from one IP, within 15 minutes.
- Usernames are not case-sensitive (`Owner` = `owner`).

### `POST /api/auth/logout` (public)
Ends the login in the database and clears the cookie. Always 200.

### `GET /api/auth/me`
- **200**: `{ id, name, username, role, active, permissions }` for the logged-in user. `passwordHash` is never returned by any endpoint.
- **401** when logged out.

---

## Users (admin only)

Every endpoint here needs the `users:manage` permission (admin). Staff and cashiers get **403**.
A user looks like:

```json
{ "id": "…", "name": "Sara Khan", "username": "sara", "role": "cashier", "active": true,
  "lastLoginAt": "2026-10-05T13:18:00.000Z", "createdAt": "…", "updatedAt": "…",
  "createdBy": { "user": "…", "name": "Owner Name", "username": "owner" }, "updatedBy": null }
```

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/users` | `?search=` (name or username), `role`, `active=true/false`. Returns `{ users, activeAdmins }` |
| GET | `/api/users/:id` | one user |
| POST | `/api/users` → `201` | `{ name, username, role, password }`. `409` if the username exists (any letter case) |
| PATCH | `/api/users/:id` | any of `name`, `role`, `active`. Deactivating ends all of that user's logins at once |
| POST | `/api/users/:id/password` | `{ password }`: an admin sets a new password. The user's other logins end |

**Rules:**
- Roles: `admin`, `staff`, `cashier`.
- Usernames: 3–30 characters, `a-z 0-9 . _ -`.
- Passwords: 10–128 characters with letters **and** numbers, not containing the username, and not one repeated character.
- **409** `"This is the last active admin. Make another user an admin first."`: the last active admin can't be deactivated or lose the admin role.
- **409** `"You can't deactivate your own account. Ask another admin."` and `"You can't remove your own admin role. Ask another admin."`

---

## Permissions per endpoint

Defined once in `server/config/permissions.js` and checked by `requirePermission(…)` on each route.

| Permission | Admin | Staff | Cashier | Endpoints |
|---|:-:|:-:|:-:|---|
| `dashboard:view` | ✅ | ✅ | ✅ | `GET /dashboard/summary` |
| `tables:view` / `tables:manage` | ✅ | ✅ | ✅ | `GET /tables…` / `POST, PATCH, DELETE /tables…` |
| `sessions:view` / `sessions:manage` | ✅ | ✅ | ✅ | `GET /sessions…` / start, end |
| `customers:view` / `customers:manage` | ✅ | ✅ | ✅ | `GET /customers…` / add, edit, delete |
| `bookings:view` / `bookings:manage` | ✅ | ✅ | ✅ | `GET /bookings…` / create, edit, confirm, cancel, check-in |
| `bills:view` | ✅ | ✅ | ✅ | `GET /bills`, `GET /bills/:id` (payments included) |
| `bills:view` (match bills) | ✅ | ✅ | ✅ | `GET /matches/:id/bill` |
| `bills:create` | ✅ | ✅ | ✅ | `POST /bills`, `POST /bills/preview`, `POST /matches/:id/bill`, `POST /matches/:id/bill/preview` |
| `payments:view` | ✅ | ✅ | ✅ | not checked by an endpoint of its own: payments are part of a bill and come with `GET /bills/:id` (`bills:view`) |
| `payments:record` | ✅ | ❌ | ✅ | `POST /bills/:id/payments` |
| `bills:cancel` | ✅ | ❌ | ✅ | `POST /bills/:id/cancel` |
| `settings:view` | ✅ | ✅ | ✅ | `GET /settings` (the bill window needs the rate list) |
| `sessions:view` (game modes) | ✅ | ✅ | ✅ | `GET /game-modes` |
| `settings:manage` | ✅ | ❌ | ❌ | `PATCH /settings` |
| `users:manage` | ✅ | ❌ | ❌ | everything under `/users` |
| `backups:manage` | ✅ | ❌ | ❌ | everything under `/backups` |
| `reports:view` | ✅ | ✅ | ❌ | everything under `/reports` (Phase 9) |
| `matches:view` / `matches:manage` | ✅ | ✅ | ✅ | `GET` match lists and matches / start, edit players, complete, change an unpaid result (Phase 11.4) |
| `matches:cancel` | ✅ | ✅ | ❌ | `POST /matches/:id/cancel` |
| `matches:correct-paid` | ✅ | ❌ | ❌ | `POST /matches/:id/result` when the match's bill has payments |
| `players:view` | ✅ | ✅ | ✅ | `GET /players…`; with `matches:view` `GET /players/:id/matches`, with `bills:view` `GET /players/:id/bills` (Phase 11.6, no new permission) |
| `players:manage` / `players:deactivate` | ✅ / ✅ | ✅ / ❌ | ❌ / ❌ | register and edit / deactivate and reactivate |
| Café: `cafe:view`, `cafe:sell`, `products:manage`, `stock:restock`, `stock:adjust`, `stock:view` | see "Café" above | | | categories, products, stock and session tabs |

**Pages** are checked by the server too (`PAGE_PERMISSIONS`): `/pages/settings.html` (`settings:manage`) and `/pages/users.html`
(`users:manage`) are refused for staff and cashiers, `/pages/reports.html` (`reports:view`) for cashiers; they are sent to the
dashboard with a message. `/pages/products.html`, `/pages/categories.html` (`cafe:view`) and `/pages/players.html` (`players:view`)
are open to every role. Logged-out visitors to any app page (all but `/pages/login.html`) are sent to the login page.

**Page addresses are checked in their canonical form (Phase 11.8):**
- The address is URL-decoded, `\` becomes `/`, dot segments and double slashes are resolved, and it is put in lower case.
- Any other spelling of a page (`/pages/users%2Ehtml`, `/pages//users.html`, `/pages/USERS.html`, `/css/../pages/users.html`…) is first sent to the canonical address (`302 /pages/users.html`), which then gets the normal login and role check.
- A name under `/pages/` that isn't a plain page name (`users.html.`, `users.html%00`…) gets 404. An address that can't be decoded gets 400.

## Who did it (audit fields)

New records save a **reference to the user plus a copy** `{ user, name, username }`, so the name stays readable even if the user is renamed later.
- Bills: `createdBy`, `cancelledBy`
- Payments: `receivedBy`
- Bookings: `createdBy`, `cancelledBy`, `checkedInBy`
- Sessions: `startedBy`, `endedBy`
- Settings: `updatedBy`
- Users: `createdBy`, `updatedBy`
- Matches (Phase 11.4): `createdBy`, `updatedBy`, `resultRecordedBy`, `cancelledBy`

Records made before Phase 8 have `null` here.

---

## Reports (Phase 9; Matches and Players: Phase 11.7)

All under `/api/reports`, **GET only**. They need a login (`401`) and the `reports:view` permission:
admin and staff yes, cashier **403**. Responses have `Cache-Control: no-store`.

### Period and filters (the same query on every report)

| Query | Meaning |
|---|---|
| `preset` | `today`, `yesterday`, `last7` (7 days incl. today, **default**), `last30`, `thisMonth` (1st to today), `prevMonth` |
| `from` + `to` | a custom period instead: club dates `YYYY-MM-DD`, both included, both required, at most **366 days** |
| `tableId` | one table |
| `gameMode` | any game type of the registry: `century`, `frame`, `snooker_point`, `four_player` (since Phase 11.7; before, only `century` / `frame` were accepted) |
| `method` | payment method: `cash`, `card`, `jazzcash`, `easypaisa`, `bank_transfer`, `other` |
| `billStatus` | `unpaid`, `partially_paid`, `paid`, `cancelled` |
| `bookingStatus` | `pending`, `confirmed`, `completed`, `cancelled`, `no_show` |

**Dates are club days in `CLUB_TIMEZONE` (Asia/Karachi):** `from=2026-10-01&to=2026-10-05` means
1 Oct 00:00:00 to 5 Oct 23:59:59.999 Karachi time = `2026-09-30T19:00:00Z` up to (not including) `2026-10-05T19:00:00Z`.
The server works out presets from its own clock, never the browser's. Every report returns the period it used:

```json
"range": { "preset": "custom", "from": "2026-10-01", "to": "2026-10-05", "days": 5, "timeZone": "Asia/Karachi",
           "start": "2026-09-30T19:00:00.000Z", "end": "2026-10-05T19:00:00.000Z" }
```

Every report also returns `hasData` (`false` = nothing in the period: show an empty message, not a chart of zeros).
Money is always whole **paisa**. Percentages have one decimal, or are `null` when they can't be calculated
(e.g. nothing billed). Not every filter applies to every report: unused ones are ignored. Each report below lists the ones it uses.

### Endpoints

| Endpoint | Returns | Filters used |
|---|---|---|
| `GET /reports/options` | Choices for the page: `tables`, `gameModes`, `paymentMethods`, `billStatuses`, `bookingStatuses`, `presets`, `today` (club date), `maxRangeDays` | — |
| `GET /reports/revenue` | `summary` { billCount, paidCount, partiallyPaidCount, unpaidCount, openCount, cancelledCount, totalBilled, totalPaid, totalOutstanding, collectedPercent, paymentsReceived, paymentCount } and `days` [{ date, billCount, cancelledCount, billed, paid, outstanding, received, paymentCount }]: one row for **every** day of the period | table, game type, bill status (payment figures: table, game type, method) |
| `GET /reports/payments` | `methods` [{ method, count, amount, sharePercent }] (all six methods), `totals` { count, amount }, `forEarlierBills` { count, amount } | method, table, game type |
| `GET /reports/games` | `games` [{ gameMode, billCount, cancelledCount, quantity, gameRevenue, cafeRevenue, taxAmount, totalBilled, totalPaid, averageBill }]: only game types with bills in the period | table, game type, bill status |
| `GET /reports/matches` | Phase 11.7. Matches that **started** in the period, each with its bill. `summary` { total, completed, inProgress, cancelled, billed, billCancelled, notBilled, registeredSlots, walkInSlots, registeredPercent, billTotal, billPaid, billOutstanding, averageBill }, `games` [same fields per game type: **all four** registry types, or only the filtered one; zeros are real], `matches` [{ id, number, startedAt, endedAt, tableNumber, tableName, gameMode, status, players [{ name, registered, team, result }], playersText, winningTeam, resultText, cancelReason, bill: { id, billNumber, status, total, amountPaid, balanceDue } or null }], `pagination`, `moneyNote`. `sort` = `newest` (default), `oldest`; `page`, `limit` (≤ 100, default 25) | table, game type |
| `GET /reports/players` | Phase 11.7. One row per **registered** player active in the period: `players` [{ playerId, name (current), isActive, matches, wins, losses, winPercent, bills, cancelledBills, openBills, billed, paid, outstanding }], `walkIns` (same fields, one line for every walk-in), `totals` { players, billed, paid, outstanding }, `pagination`, `limitation`. `sort` = `matches` (default), `wins`, `billed`, `outstanding`, `name`; `page`, `limit` (≤ 100, default 25) | table, game type |
| `GET /reports/tables` | `tables` [{ tableId, tableNumber, tableName, deleted, sessionCount, completedCount, activeCount, unbilledCount, billCount, playedSeconds, averageSessionSeconds, billedMinutes, revenue, occupiedSeconds, availableSeconds, utilizationPercent }], `totals`, `sessionCounting` { label: "Sessions", attributedTo: "startDate", description, definition }, `utilization` { label: "Observed Utilization", isEstimate: true, description, numerator, denominator, definition, dayAllocation, attributedTo: "timeWithinEachDay", measuredFrom, measuredUntil }. `utilizationPercent` is the **Observed Utilization** (field name kept for compatibility). `sort` = `revenue` (default), `sessions`, `billedTime`, `tableNumber`. Since Phase 11.5 a session can have several bills (one per match): `billCount` and `revenue` count **every** non-cancelled bill, while `billedMinutes` counts each session's billed time **once** | table |
| `GET /reports/bookings` | `statusFilter` (null = all statuses), `totalBookings`, `counts` { total, pending, confirmed, completed, cancelled, no_show, checkedIn, decided }, `ratesAvailable`, `rates` { checkInPercent, noShowPercent, cancellationPercent }, `ratesNote`, `days` [one row per day with a count per status] | table, booking status (summary, days **and** CSV) |
| `GET /reports/customers` | `stats` { newCustomers, customersWithBookings, customersCheckedIn, repeatCustomers }, `topByBookings`, `topBySessions` (10 each: name, bookings, checkedIn, noShows, cancelled, sessions, playedSeconds, lastVisit), `limitation` | period only |
| `GET /reports/outstanding` | `bills` [{ id, billNumber, createdAt, tableNumber, tableName, gameMode, players, total, amountPaid, balanceDue, status }], `totals` { count, totalBilled, totalPaid, totalOutstanding, unpaidCount, partiallyPaidCount }, `pagination`. `sort` = `oldest` (default), `newest`, `balance`; `all=true` = every date; `page`, `limit` (≤ 100, default 25) | table, game type, bill status |
| `GET /reports/outstanding/print` | **Every** matching outstanding bill for printing: no pages, same `bills` row shape and `totals` as above, plus `maxRows` (2000). Same query as `/outstanding` without `page` / `limit`. Above **2,000** bills: **400** "There are too many outstanding bills to print at once (more than 2,000). Narrow the period or the filters, or use CSV export." The list is never cut short | table, game type, bill status |
| `GET /reports/export/:report` | **CSV file** (`text/csv`, download). `:report` = `revenue`, `payments`, `games`, `matches`, `players`, `tables`, `bookings`, `outstanding`. Same query as the report (plus `sort` / `all`) | as the report |

### Definitions

- **Revenue** = the saved `total` of bills **created** in the period, **cancelled bills excluded** (they are only
  counted in `cancelledCount`). Old bills keep the price they were made with; changing Settings never changes a report.
- **Paid / outstanding (revenue)** = `amountPaid` / `total − amountPaid` of those same bills, as of now.
- **Received / payments** = real `payments` records by the time they were **received** (`paidAt`), for bills of any
  date. `forEarlierBills` = the part paid for bills created before the period.
  Cancelled bills never have payments (only unpaid bills can be cancelled).
- **Collected %** = totalPaid ÷ totalBilled.
- **Game types** = grouped by the `gameMode` stored on each bill. `quantity` = games (century) or frames (frame).
  `gameRevenue` = the bill's game line; `cafeRevenue` = its café lines; `averageBill` = totalBilled ÷ billCount.
- **Table performance** = sessions that **started** in the period. `playedSeconds` = durations of the finished ones.
  - **Sessions (`sessionCount`) are attributed to the session's START date:** each session is counted once, on the
    club day it started, even if it ended the next day. A session that started before the period is not counted,
    though its time inside the period is part of Observed Utilization. The response's `sessionCounting`
    { label, attributedTo: "startDate", description, definition } says so.
  - **Observed Utilization allocates played time to every calendar day the session touched**
    (`utilization.attributedTo: "timeWithinEachDay"`, `utilization.dayAllocation`), clipped to the selected period.
    So a 23:00–01:00 session gives Sessions = 1 / 1 h on the first day, and Sessions = 0 / 1 h on the next day.
    The two columns deliberately measure different things. Over a range that contains every session completely,
    total used time = total played time, and every session is counted exactly once.
  - A **deleted** table appears if a session started in the period **or** a session that started earlier ran into it,
    so its used time is never lost from the totals.
  `revenue` / `billedMinutes` = their bills' saved totals and billed minutes (cancelled bills excluded).
  The table's hourly rate is **not** used.
- **Observed Utilization (an estimate)** = `utilizationPercent` = `occupiedSeconds ÷ availableSeconds` × 100, one decimal.
  *"Percentage of the selected period represented by recorded table use. This is an estimate because club opening hours and maintenance/closure time are not stored."*
  1. **Numerator** (`occupiedSeconds`): recorded session time on the table **inside** the period. Each session runs from `startedAt` to `endedAt`, cut off at the period's first and last moment.
  2. **Denominator** (`availableSeconds`): the period's elapsed clock time on that table, from `max(period start, table added)` to `min(period end, now)`.
  3. **Period:** the selected club days, From 00:00 to the day after To at 00:00 (exclusive). `measuredFrom` and `measuredUntil` give the exact window.
  4. **Timezone:** `CLUB_TIMEZONE` (Asia/Karachi) for the day edges. Times are stored and compared in UTC.
  5. **Sessions across midnight:** split by the clock. 23:00–01:00 gives 1 h to each day. (The "sessions" count, by contrast, puts a session on the day it **started**.)
  6. **Tables added during the period:** measured only from when they were added. A table added after the period has `availableSeconds: 0` and `utilizationPercent: null`.
  7. **Deleted tables:** their sessions and `occupiedSeconds` stay in the report and the totals, but `utilizationPercent` is `null`, because the add date is gone. Other tables are not affected.
  8. **Running (active) sessions:** count up to **now**. A period that is not over is measured only up to now. A period that hasn't started gives `null` for every table.
  9. **Played time, not billed time:** it uses the real recorded session time, not the billed minutes (which include the 15-minute minimum and 5-minute rounding), and not the table's hourly rate.
  10. **Why it is only an estimate:** opening hours, table schedules and maintenance/closure periods are not stored. So every hour of the period counts as available. This is not an assumption that the club is open all day; it is the only denominator the data supports. The figure is therefore **lower** than a utilization based on opening hours would be. Bookings are not used.
- **Bookings** = bookings whose **start** is in the period (the automatic no-show rule runs first).
  - "Checked in" = `completed`, because checking in starts the session and completes the booking.
  - **All statuses** (no `bookingStatus`): `ratesAvailable: true`, and every count and rate is calculated:
    - eligible bookings (`decided`) = completed + cancelled + no-show, i.e. bookings whose outcome is known
    - check-in rate = completed ÷ eligible
    - no-show rate = no_show ÷ eligible
    - cancellation rate = cancelled ÷ eligible
    - Pending and confirmed bookings are **not** eligible: they haven't happened yet. A past one becomes a no-show automatically after the grace minutes. A booking cancelled in advance counts as cancelled.
    - Rates are `null` when there are no eligible bookings.
  - **One status selected** (`bookingStatus=no_show`, for example):
    - `totalBookings`, `counts`, `days` and the CSV contain **only** that status.
    - `ratesAvailable: false`, all three `rates` are `null`, and `ratesNote` = "Rates are shown only when All statuses is selected." A rate of one status divided by itself would always be a meaningless 100% (or 0%).
- **Customers:**
  - New = customer records **created** in the period.
  - The other figures come from bookings starting in the period. Repeat = 2+ check-ins in the period.
  - Sessions count only through a booking's `session` link.
  - **No customer revenue:** bills keep free-text player names and are not linked to customers. Names are never matched by guessing.
- **Matches** (Phase 11.7) = Match records whose `startedAt` is in the period (a match belongs to the club day it **started**, like a session).
  - Each match is shown with its own bill (`Match.bill`), whatever day the bill was made. So `billTotal` / `billPaid` are the money of **these matches' bills**. Revenue, by contrast, counts bills by the day they were **created**.
  - `billed` = completed matches whose bill isn't cancelled. `billCancelled` = completed matches whose bill was cancelled (a cancelled bill is never money and isn't made again). `notBilled` = completed matches with no bill.
  - `registeredSlots` / `walkInSlots` = player places in matches that weren't cancelled. `registeredPercent` = registered ÷ all places.
  - `resultText`: "Winner: Ali", "Winning team: Team 2 (Ahmed & Zed)", "Cancelled" or "In progress".
  - **Only real matches:** bills made in the Create Bill window and older bills have no match, and none is invented for them.
- **Players** (Phase 11.7) = registered players, found by their reference only (`Match.players.player`, `Bill.players.player`). It uses the **same calculation** as the player's own history (`GET /api/players/:id/bills` and `/matches`, Phase 11.6, shared code in `playerHistory.service.js`).
  - `matches`, `wins`, `losses`: **completed** matches that **started** in the period. `winPercent` = wins ÷ (wins + losses).
  - `bills`, `billed`, `paid`, `outstanding`: **match bills created** in the period (like Revenue and Outstanding), using the player's **own** entry on each bill (`shareAmount`, `paidAmount`).
    - outstanding = share − paid on unpaid / partly paid bills.
    - A paid bill owes 0, and so does a cancelled bill (`cancelledBills` counts those).
    - A team-mate's part is never the player's.
  - So, over one long period, a player's row equals their history totals.
  - `walkIns`: everyone without a reference, together on one line. Walk-ins are never turned into players.
  - Names are matched by **nothing**: bills from the Create Bill window and older bills keep free-text names only, so they are not counted per player (`limitation`).
  - `totals` adds money only. Match and bill counts would double-count when two registered players share a match or bill.
- **Game types in filters:** every registry type can be chosen. `options.gameModes` lists all four, plus any other type stored on old bills.
- **Outstanding** = bills with status `unpaid` / `partially_paid`; remaining = `total − amountPaid`, the same as the bill's own `balanceDue`.
  - The screen shows pages of 25.
  - **Printing:** the page asks `/outstanding/print` for every matching bill first, using the same filters and the same query the CSV export uses. It then prints all of them with the count and the total outstanding. If that request fails or the 2,000 limit is reached, **nothing is printed**, and the page shows the error instead.
  - **CSV:** unchanged, with a limit of 50,000 rows.

### CSV export

- **Format:** UTF-8 with a byte-order mark (Excel shows Urdu or accented names correctly). One header row; Windows line ends.
- **Values:** money in rupees with 2 decimals (`1200.50`), times in club time (`2026-10-05 18:30`).
- **Escaping:** values with commas, quotes or line breaks are quoted (quotes doubled). Text starting with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet never runs it as a formula.
- **Never exported:** phone numbers, notes, passwords, tokens.
- **Limit:** at most 50,000 rows per file; above that you get 400 "Choose a shorter period".

### How the figures are calculated (performance)

- Every figure is a **MongoDB aggregation** (`$match` on an indexed date → `$group`). Only the totals come back to the server, never all the bills.
- `$facet` produces the summary and the daily rows from **one** pass over the matching bills.
- Payments are joined to their bill with `$lookup` on `_id`; sessions to their bills on the `{session, match}` index (Phase 11.5 replaced the unique `session` index); matches to their bill on `_id` (`Match.bill`). These are single indexed lookups (no N+1 queries).
- Customer names for the top lists, and current player names for the Players report, come in **one** query each.
- **Indexes used:**
  - `bills {createdAt}`, `bills {status, createdAt}`
  - `payments {paidAt}`
  - `sessions {status, startedAt}`, `sessions {status, endedAt}` (new in Phase 9)
  - `bookings {status, startAt}`
  - `customers {createdAt}` (new in Phase 9)
  - `matches {gameMode, startedAt}` (from Phase 11.4; the Matches / Players reports ask for `gameMode` `$in` every registry type, so the period uses it). **No new index in Phase 11.7.**
- An automatic test checks with `explain()` that these queries use an index (IXSCAN), not a full scan.
