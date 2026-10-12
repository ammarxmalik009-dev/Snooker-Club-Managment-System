-- Step 2.3: the first PostgreSQL schema, mapped from the 16 existing Mongoose models
-- (server/models/*.js). Full field-by-field rationale is in docs/POSTGRES_MIGRATION.md
-- ("Step 2.3 - schema mapping"); this file only has the SQL and the comments a reader
-- of the SQL itself needs (why a column/constraint looks the way it does).
--
-- Not yet done by this migration (see docs/POSTGRES_MIGRATION.md): no data is imported
-- (Phase 4's importMongoBackup.js), no application code reads these tables (Phase 3).
--
-- Table creation order here is purely to satisfy foreign-key dependencies (it is NOT the
-- Phase 3 service-porting order). Two pairs of tables refer to each other (sessions<->bookings,
-- matches<->bills), which plain SQL can't create in one statement each - both are created with
-- the circular column present but un-constrained, then linked with ALTER TABLE once both exist.
--
-- Conventions used throughout (matching the existing app, see Bill.js/money and ARCHITECTURE.md
-- Section 5.1):
--   - id uuid primary key, default gen_random_uuid() - built into PostgreSQL 13+, no extension
--     needed. Returned to the browser as a string by the Phase 3 row-mapper layer, the same way
--     cleanJson.js turns Mongo's _id into "id" today.
--   - money columns are bigint, a whole number of paisa - exactly like Mongo's `money` schema
--     type (Number, validate: Number.isInteger) today. No new precision rules.
--   - created_at/updated_at timestamptz, matching Mongoose's `{ timestamps: true }`.
--   - "who did it" (Mongoose's embedded actorSchema: { user, name, username }) becomes three
--     plain columns per field: <prefix>_user_id (FK to users, nullable), <prefix>_name,
--     <prefix>_username - a flattened copy, for the exact same reason Mongo embeds it (history
--     reads correctly even if the account is later renamed or deactivated).
--   - every Mongoose `enum` becomes a CHECK constraint on a text column, not a native Postgres
--     ENUM type - so a new legal value can be added later with one ALTER TABLE, the same ease
--     with which this project's own enums already grew (e.g. config/gameModes.js's PRICING_TYPES
--     keeps "per_game" forever for old bills, alongside newer values).
--
-- No BEGIN/COMMIT here: the migration runner (server/db/migrate.js) wraps every file in its
-- own transaction automatically, so a failure partway through this file rolls back everything
-- in it and nothing is recorded as applied.

-- ========== Users & logins (User.js, AuthSession.js) ==========

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL, -- never SELECT * on this table - keep this column out of ordinary reads (Mongoose: select: false)
  role text NOT NULL CHECK (role IN ('admin', 'staff', 'cashier')),
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_by_user_id uuid REFERENCES app.users(id),
  created_by_name text,
  created_by_username text,
  updated_by_user_id uuid REFERENCES app.users(id),
  updated_by_name text,
  updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON app.users (username);
CREATE INDEX users_role_active_idx ON app.users (role, active);

-- AuthSession.js has a TTL index (MongoDB deletes expired sessions by itself). PostgreSQL has no
-- equivalent - an expired row simply stays until something deletes it. Open question for Phase 3:
-- a periodic `DELETE FROM app.auth_sessions WHERE expires_at < now()` job (see docs).
CREATE TABLE app.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_sessions_token_hash_key ON app.auth_sessions (token_hash);
CREATE INDEX auth_sessions_user_idx ON app.auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON app.auth_sessions (expires_at);

-- ========== Club tables, customers (Table.js, Customer.js) ==========

CREATE TABLE app.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number integer NOT NULL CHECK (table_number BETWEEN 1 AND 999),
  name text NOT NULL DEFAULT '',
  hourly_rate bigint NOT NULL CHECK (hourly_rate >= 0 AND hourly_rate <= 10000000),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tables_table_number_key ON app.tables (table_number);
CREATE INDEX tables_status_idx ON app.tables (status);

-- phone_digits (Customer.js: filled by a pre-validate hook from `phone`) is NOT a generated
-- column here - Phase 3's row-mapper computes it before every insert/update, the same place
-- every other piece of app logic currently in Mongoose "pre" hooks will move to.
CREATE TABLE app.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  phone_digits text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_idx ON app.customers (name);
CREATE INDEX customers_phone_digits_idx ON app.customers (phone_digits);
CREATE INDEX customers_active_name_idx ON app.customers (is_active, name);
CREATE INDEX customers_created_at_idx ON app.customers (created_at);

-- ========== Café: categories, products (Category.js, Product.js) ==========

CREATE TABLE app.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL, -- trimmed/lower-cased copy of name (Category.js nameKeyOf); computed by the row-mapper, not a generated column, so the exact same JS function stays the single source of truth
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  updated_by_user_id uuid REFERENCES app.users(id), updated_by_name text, updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_key_key ON app.categories (name_key);

CREATE TABLE app.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL,
  category_id uuid NOT NULL REFERENCES app.categories(id),
  price bigint NOT NULL CHECK (price >= 0 AND price <= 10000000),
  track_stock boolean NOT NULL DEFAULT true,
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0 AND stock_quantity <= 1000000),
  low_stock_limit integer NOT NULL DEFAULT 5 CHECK (low_stock_limit >= 0 AND low_stock_limit <= 1000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  updated_by_user_id uuid REFERENCES app.users(id), updated_by_name text, updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Same name twice in ONE category is refused; the same name in two different categories is fine (Product.js)
CREATE UNIQUE INDEX products_category_namekey_key ON app.products (category_id, name_key);
CREATE INDEX products_status_namekey_idx ON app.products (status, name_key);
-- isLowStock (Product.js virtual) is not stored: it is simply `track_stock AND stock_quantity <= low_stock_limit`,
-- computed wherever it's needed (a query or the row-mapper), same as Mongoose's virtual getter does today.

-- ========== Registered players (Player.js) ==========

CREATE TABLE app.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL,
  phone text NOT NULL DEFAULT '',
  phone_digits text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  updated_by_user_id uuid REFERENCES app.users(id), updated_by_name text, updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX players_name_key_key ON app.players (name_key);
CREATE INDEX players_active_namekey_idx ON app.players (is_active, name_key);
CREATE INDEX players_phone_digits_idx ON app.players (phone_digits);

-- ========== Sessions & bookings (Session.js, Booking.js) - mutually referencing ==========

-- booking_id has no REFERENCES yet: app.bookings doesn't exist until just below, and bookings
-- itself refers back to sessions. Linked by ALTER TABLE once both tables exist (see below).
CREATE TABLE app.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES app.tables(id),
  table_number integer NOT NULL,       -- snapshot at session start (Session.js comment: table may be renamed/re-priced later)
  table_name text NOT NULL DEFAULT '',
  hourly_rate_at_start bigint NOT NULL CHECK (hourly_rate_at_start >= 0),
  booking_id uuid,                     -- set only when started by checking in a booking (Phase 7)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  is_open boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  started_by_user_id uuid REFERENCES app.users(id), started_by_name text, started_by_username text,
  ended_by_user_id uuid REFERENCES app.users(id), ended_by_name text, ended_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- At most one OPEN session per table - a straight, direct match for Session.js's own
-- "one_open_session_per_table" partial unique index; PostgreSQL supports partial unique
-- indexes natively, no extension needed.
CREATE UNIQUE INDEX sessions_one_open_per_table ON app.sessions (table_id) WHERE is_open;
CREATE INDEX sessions_open_by_start_idx ON app.sessions (started_at) WHERE is_open;
CREATE INDEX sessions_status_started_idx ON app.sessions (status, started_at DESC);
CREATE INDEX sessions_status_ended_idx ON app.sessions (status, ended_at DESC);

CREATE TABLE app.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES app.customers(id),
  table_id uuid NOT NULL REFERENCES app.tables(id),
  customer_name text NOT NULL,
  customer_phone text NOT NULL DEFAULT '',
  table_number integer NOT NULL,
  table_name text NOT NULL DEFAULT '',
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  notes text NOT NULL DEFAULT '',
  session_id uuid REFERENCES app.sessions(id),
  checked_in_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  no_show_at timestamptz,
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  cancelled_by_user_id uuid REFERENCES app.users(id), cancelled_by_name text, cancelled_by_username text,
  checked_in_by_user_id uuid REFERENCES app.users(id), checked_in_by_name text, checked_in_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX bookings_table_time_idx ON app.bookings (table_id, start_at, end_at);
CREATE INDEX bookings_status_start_idx ON app.bookings (status, start_at);
CREATE INDEX bookings_customer_start_idx ON app.bookings (customer_id, start_at DESC);

-- Booking overlap (Booking.js / bookings.service.js's findClash + "insert, re-check, loser
-- self-deletes" dance - see docs/POSTGRES_MIGRATION.md step 2.1/2.3): a genuine database-level
-- guarantee, which MongoDB cannot offer (no range-exclusion constraint there). Needs the
-- btree_gist extension for a GiST index on a uuid column - CONFIRMED available AND working on
-- this local PostgreSQL 18.6 (tested directly: overlapping insert correctly rejected with
-- "conflicting key value violates exclusion constraint"). Railway's availability is NOT yet
-- confirmed - if this extension is unavailable there, this migration will fail LOUDLY on
-- deploy (never silently), which is the safe outcome; the documented fallback is a
-- SELECT ... FOR UPDATE-serialized check in the Phase 3 service layer instead.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE app.bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (table_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (status IN ('pending', 'confirmed'));

ALTER TABLE app.sessions ADD CONSTRAINT sessions_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES app.bookings(id);

-- ========== Café orders & stock movements (CafeOrder.js, StockMovement.js) ==========
-- Created here (bill_id un-constrained) because both need app.bills, which is created further
-- down; linked by ALTER TABLE once app.bills exists.

CREATE TABLE app.cafe_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES app.sessions(id),
  table_number integer NOT NULL,
  product_id uuid REFERENCES app.products(id), -- null = a typed-in one-off item
  description text NOT NULL,
  category_name text NOT NULL DEFAULT '',
  unit_price bigint NOT NULL CHECK (unit_price >= 0 AND unit_price <= 10000000),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  consumer text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'billed', 'removed')),
  bill_id uuid,
  billed_at timestamptz,
  removed_at timestamptz,
  added_by_user_id uuid REFERENCES app.users(id), added_by_name text, added_by_username text,
  removed_by_user_id uuid REFERENCES app.users(id), removed_by_name text, removed_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cafe_orders_session_status_idx ON app.cafe_orders (session_id, status, created_at);
CREATE INDEX cafe_orders_product_status_idx ON app.cafe_orders (product_id, status);

CREATE TABLE app.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES app.products(id),
  product_name text NOT NULL,
  type text NOT NULL CHECK (type IN ('initial', 'restock', 'sale', 'sale_reversal', 'adjustment', 'waste')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL DEFAULT '',
  bill_id uuid,
  bill_number text NOT NULL DEFAULT '',
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  created_at timestamptz NOT NULL DEFAULT now() -- no updated_at: StockMovement.js only timestamps createdAt (a movement is never edited)
);
CREATE INDEX stock_movements_product_created_idx ON app.stock_movements (product_id, created_at DESC);
CREATE INDEX stock_movements_created_idx ON app.stock_movements (created_at DESC);

-- ========== Matches (Match.js) - mutually referencing with bills ==========

CREATE TABLE app.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES app.sessions(id),
  number integer NOT NULL CHECK (number >= 1),
  table_id uuid NOT NULL REFERENCES app.tables(id), -- snapshot reference, like session's own table_id
  table_number integer NOT NULL,
  table_name text NOT NULL DEFAULT '',
  game_mode text NOT NULL CHECK (game_mode IN ('century', 'frame', 'snooker_point', 'four_player')),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  winner_seat integer,
  winning_team integer CHECK (winning_team IN (1, 2)),
  losing_team integer CHECK (losing_team IN (1, 2)),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  result_recorded_at timestamptz,
  result_recorded_by_user_id uuid REFERENCES app.users(id), result_recorded_by_name text, result_recorded_by_username text,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES app.users(id), cancelled_by_name text, cancelled_by_username text,
  cancel_reason text NOT NULL DEFAULT '',
  bill_id uuid, -- a convenience pointer only; app.bills.match_id is the source of truth (Match.js comment) - linked below
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  updated_by_user_id uuid REFERENCES app.users(id), updated_by_name text, updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX matches_session_number_key ON app.matches (session_id, number);
CREATE INDEX matches_session_status_idx ON app.matches (session_id, status);
CREATE INDEX matches_gamemode_started_idx ON app.matches (game_mode, started_at DESC);

CREATE TABLE app.match_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES app.matches(id) ON DELETE CASCADE,
  position integer NOT NULL, -- preserves the array's original order (SQL rows have no inherent order)
  player_id uuid REFERENCES app.players(id), -- null = walk-in
  name text NOT NULL,
  seat integer NOT NULL CHECK (seat >= 1),
  team integer CHECK (team IN (1, 2)),
  result text CHECK (result IN ('winner', 'loser')),
  score integer
);
CREATE UNIQUE INDEX match_players_match_seat_key ON app.match_players (match_id, seat);
-- Player history / reports ("which matches did this player play, newest first?") joins this to
-- matches.started_at - there is no started_at copy here, by design (Phase 3 query, not a new column).
CREATE INDEX match_players_player_idx ON app.match_players (player_id) WHERE player_id IS NOT NULL;

CREATE TABLE app.match_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES app.matches(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number IN (1, 2)),
  name text NOT NULL,
  seats integer[] NOT NULL -- always exactly 2 seats today (four_player only); a native array, not another child table, since it is never queried on its own
);
CREATE UNIQUE INDEX match_teams_match_number_key ON app.match_teams (match_id, number);

-- ========== Bills, their line items and players (Bill.js) ==========

CREATE TABLE app.bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number text NOT NULL,
  session_id uuid NOT NULL REFERENCES app.sessions(id),
  table_id uuid REFERENCES app.tables(id),
  table_number integer NOT NULL,
  table_name text NOT NULL DEFAULT '',
  session_started_at timestamptz NOT NULL,
  session_ended_at timestamptz NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds >= 0),
  billed_minutes integer NOT NULL CHECK (billed_minutes >= 0),
  game_mode text NOT NULL CHECK (game_mode IN ('century', 'frame', 'snooker_point', 'four_player')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  pricing_type text CHECK (pricing_type IN ('per_game', 'per_minute', 'per_frame', 'fixed')), -- absent on bills made before Phase 11.3
  match_id uuid REFERENCES app.matches(id), -- absent = a whole-session bill (pre-Phase 11.5, or the Create Bill window)
  match_number integer,
  winning_team integer CHECK (winning_team IN (1, 2)),
  losing_team integer CHECK (losing_team IN (1, 2)),
  subtotal bigint NOT NULL CHECK (subtotal >= 0),
  tax_enabled boolean NOT NULL DEFAULT false,
  tax_rate_basis_points integer NOT NULL DEFAULT 0 CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  tax_amount bigint NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total bigint NOT NULL CHECK (total >= 0),
  payer_rule text NOT NULL CHECK (payer_rule IN ('loser', 'winner', 'split')),
  cafe_payer_rule text CHECK (cafe_payer_rule IN ('loser', 'consumer', 'split')), -- null = follows payer_rule (every pre-Phase-10 bill)
  amount_paid bigint NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partially_paid', 'paid', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  created_by_user_id uuid REFERENCES app.users(id), created_by_name text, created_by_username text,
  cancelled_by_user_id uuid REFERENCES app.users(id), cancelled_by_name text, cancelled_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Bill.js's "balanceDue" virtual, reproduced exactly as a generated column (PostgreSQL computes
  -- and stores it automatically - always in sync, same formula, never out of step):
  balance_due bigint GENERATED ALWAYS AS (CASE WHEN status = 'cancelled' THEN 0 ELSE total - amount_paid END) STORED
);
CREATE UNIQUE INDEX bills_bill_number_key ON app.bills (bill_number);
-- Bill.js's single compound unique index { session, match } cannot be copied as one plain SQL
-- UNIQUE constraint: standard SQL treats every NULL as distinct from every other NULL, so
-- UNIQUE(session_id, match_id) would let the SAME session have many match_id=NULL bills - the
-- opposite of the rule. Two partial unique indexes reproduce Mongo's actual behaviour exactly
-- (tested directly: a second session-only bill for the same session is correctly rejected):
CREATE UNIQUE INDEX bills_one_per_session_no_match ON app.bills (session_id) WHERE match_id IS NULL;
CREATE UNIQUE INDEX bills_one_per_session_and_match ON app.bills (session_id, match_id) WHERE match_id IS NOT NULL;
-- Century is charged by the SESSION's time, so only one per-minute match bill per session (Bill.js comment)
CREATE UNIQUE INDEX bills_one_century_per_session ON app.bills (session_id) WHERE match_id IS NOT NULL AND pricing_type = 'per_minute';
CREATE INDEX bills_by_match_idx ON app.bills (match_id) WHERE match_id IS NOT NULL;
CREATE INDEX bills_created_at_idx ON app.bills (created_at DESC);
CREATE INDEX bills_status_created_idx ON app.bills (status, created_at DESC);

CREATE TABLE app.bill_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES app.bills(id) ON DELETE CASCADE,
  position integer NOT NULL,
  type text NOT NULL CHECK (type IN ('game', 'cafe')),
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 1),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  amount bigint NOT NULL CHECK (amount >= 0),
  product_id uuid REFERENCES app.products(id),       -- null = a typed-in item (café lines only)
  category_name text,
  consumer text,                                     -- which player had it ("consumer pays")
  consumer_player_id uuid REFERENCES app.players(id),
  cafe_order_id uuid REFERENCES app.cafe_orders(id)   -- came from the session tab; app.cafe_orders already exists at this point
);
CREATE UNIQUE INDEX bill_line_items_bill_position_key ON app.bill_line_items (bill_id, position);

CREATE TABLE app.bill_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES app.bills(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  result text CHECK (result IN ('winner', 'loser')),
  player_id uuid REFERENCES app.players(id), -- absent = walk-in (Create Bill window or an unregistered match player)
  team integer,
  share_amount bigint NOT NULL CHECK (share_amount >= 0),
  paid_amount bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  game_share bigint,
  cafe_share bigint
);
CREATE UNIQUE INDEX bill_players_bill_position_key ON app.bill_players (bill_id, position);
-- Player history / outstanding balances: "this registered player's bills" (Bill.js's
-- "bills_by_registered_player" partial index) - joined with app.bills for created_at ordering.
CREATE INDEX bill_players_player_idx ON app.bill_players (player_id) WHERE player_id IS NOT NULL;

-- Now that app.bills exists, link the two tables that were created pointing at it:
ALTER TABLE app.matches ADD CONSTRAINT matches_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES app.bills(id);
ALTER TABLE app.cafe_orders ADD CONSTRAINT cafe_orders_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES app.bills(id);
ALTER TABLE app.stock_movements ADD CONSTRAINT stock_movements_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES app.bills(id);

-- ========== Payments (Payment.js) ==========

CREATE TABLE app.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES app.bills(id),
  amount bigint NOT NULL CHECK (amount >= 1),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'jazzcash', 'easypaisa', 'bank_transfer', 'other')),
  payer_name text NOT NULL,
  note text NOT NULL DEFAULT '',
  paid_at timestamptz NOT NULL DEFAULT now(),
  received_by_user_id uuid REFERENCES app.users(id), received_by_name text, received_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_bill_paidat_idx ON app.payments (bill_id, paid_at);
CREATE INDEX payments_paidat_idx ON app.payments (paid_at DESC);

-- ========== Settings & counters (Setting.js, Counter.js) ==========

-- gameRates (Setting.js: one optional rate per game-mode key, "no schema default on purpose -
-- NULL means never set") is flattened to one nullable column per mode, rather than a JSON blob -
-- these are a small, fixed, named set the application code already addresses by name
-- (config/gameModes.js), so plain columns stay simple to query and to add a CHECK to later.
CREATE TABLE app.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL DEFAULT 'club',
  rate_century bigint CHECK (rate_century IS NULL OR (rate_century >= 0 AND rate_century <= 10000000)),
  rate_frame bigint CHECK (rate_frame IS NULL OR (rate_frame >= 0 AND rate_frame <= 10000000)),
  rate_snooker_point bigint CHECK (rate_snooker_point IS NULL OR (rate_snooker_point >= 0 AND rate_snooker_point <= 10000000)),
  rate_four_player bigint CHECK (rate_four_player IS NULL OR (rate_four_player >= 0 AND rate_four_player <= 10000000)),
  century_price bigint NOT NULL DEFAULT 0,
  frame_price bigint NOT NULL DEFAULT 0,
  minimum_billable_minutes integer NOT NULL DEFAULT 15 CHECK (minimum_billable_minutes BETWEEN 1 AND 240),
  billing_increment_minutes integer NOT NULL DEFAULT 5 CHECK (billing_increment_minutes BETWEEN 1 AND 60),
  tax_enabled boolean NOT NULL DEFAULT false,
  tax_rate_basis_points integer NOT NULL DEFAULT 0 CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  no_show_grace_minutes integer NOT NULL DEFAULT 15 CHECK (no_show_grace_minutes BETWEEN 5 AND 120),
  currency text NOT NULL DEFAULT 'PKR',
  backup_enabled boolean NOT NULL DEFAULT true,
  backup_interval_hours integer NOT NULL DEFAULT 12 CHECK (backup_interval_hours BETWEEN 1 AND 168),
  backup_keep_count integer NOT NULL DEFAULT 30 CHECK (backup_keep_count BETWEEN 1 AND 365),
  last_backup_at timestamptz,
  last_backup_file text,
  last_backup_attempt_at timestamptz,
  last_backup_error text,
  updated_by_user_id uuid REFERENCES app.users(id), updated_by_name text, updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settings_key_key ON app.settings (key);

-- Counter.js: { _id: name, seq }. Kept as a plain table (not a SQL SEQUENCE object) because the
-- app needs one counter PER NAME (e.g. "bill-2026-10-05"), created on demand - a single
-- `INSERT ... ON CONFLICT (id) DO UPDATE SET seq = seq + 1 RETURNING seq` reproduces
-- findOneAndUpdate's atomic upsert-and-increment exactly, race-free, in Phase 3.
CREATE TABLE app.counters (
  id text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0
);
