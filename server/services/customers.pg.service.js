// Customers - PostgreSQL pilot (Phase 2, step 2.11). Standalone: not wired into any route, does
// not call and is not called by server/services/customers.service.js (MongoDB), which stays the
// application's only active path.
//
// app.customers has no actor columns at all (models/Customer.js never recorded who created or
// changed a customer either) and no uniqueness on phone - models/Customer.js's own comment says
// so explicitly ("Phone is optional and NOT unique (family members may share one number)"), so
// this pilot deliberately does not add a unique check that would contradict the existing rule.
//
// Length rules (name 2-60, phone <=20, notes <=200 - customers.service.js's own Mongoose schema)
// have no matching CHECK constraint in the schema (step 2.3), so they are enforced here in the
// service, the same way Tables' step 2.10 status enum is validated in code rather than relying on
// a raw constraint-violation error to leak through.
//
// Out of scope, explicitly (not invented): getCustomerWithHistory (customers.service.js's full
// profile view - booking history joined with session info, a report-like read, not a repository
// operation) and pagination's own booking-stats aggregation beyond what listCustomers needs.
// Recorded as a remaining risk in docs/POSTGRES_MIGRATION.md, not silently skipped.

const { query } = require("../config/db.pg");
const { toId } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

function phoneDigitsOf(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function mapCustomerRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    name: row.name,
    phone: row.phone,
    phoneDigits: row.phone_digits,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Same length rules as customers.service.js's Mongoose schema - checked here because the schema
// (step 2.3) has no matching CHECK constraint for any of these.
function validateFields({ name, phone, notes }, { nameRequired = true } = {}) {
  if (nameRequired || name !== undefined) {
    const trimmed = String(name ?? "").trim();
    if (trimmed.length < 2 || trimmed.length > 60) {
      throw new AppError("Name must be between 2 and 60 characters", 400, [
        { field: "name", message: "Name must be between 2 and 60 characters" },
      ]);
    }
  }
  if (phone !== undefined && String(phone).length > 20) {
    throw new AppError("Phone must be at most 20 characters", 400, [{ field: "phone", message: "Phone must be at most 20 characters" }]);
  }
  if (notes !== undefined && String(notes).length > 200) {
    throw new AppError("Notes must be at most 200 characters", 400, [{ field: "notes", message: "Notes must be at most 200 characters" }]);
  }
}

async function getCustomerById(id) {
  const result = await query("SELECT * FROM app.customers WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Customer not found", 404);
  return mapCustomerRow(result.rows[0]);
}

async function createCustomer({ name, phone = "", notes = "", isActive = true }) {
  validateFields({ name, phone, notes });
  const trimmedName = String(name).trim();
  const result = await query(
    `INSERT INTO app.customers (name, phone, phone_digits, notes, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [trimmedName, phone, phoneDigitsOf(phone), notes, isActive]
  );
  return mapCustomerRow(result.rows[0]);
}

async function updateCustomer(id, changes) {
  await getCustomerById(id); // 404 before anything else, same as customers.service.js
  validateFields(changes, { nameRequired: false });

  const setClauses = [];
  const values = [];
  const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };
  if (changes.name !== undefined) setColumn("name", String(changes.name).trim());
  if (changes.phone !== undefined) {
    setColumn("phone", changes.phone);
    values.push(phoneDigitsOf(changes.phone));
    setClauses.push(`phone_digits = $${values.length}`);
  }
  if (changes.notes !== undefined) setColumn("notes", changes.notes);
  if (changes.isActive !== undefined) setColumn("is_active", changes.isActive);
  if (setClauses.length === 0) return getCustomerById(id);
  setClauses.push("updated_at = now()");
  values.push(id);

  const result = await query(`UPDATE app.customers SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  return mapCustomerRow(result.rows[0]);
}

// Search by name (any part, any case) or by phone digits ("0300 123" finds "0300-1234567") -
// the same two conditions customers.service.js's own searchFilter checks.
function searchConditions(search, values) {
  const conditions = [];
  values.push(`%${search}%`);
  conditions.push(`name ILIKE $${values.length}`);
  const digits = phoneDigitsOf(search);
  if (digits.length >= 3) {
    values.push(`%${digits}%`);
    conditions.push(`phone_digits ILIKE $${values.length}`);
  }
  return `(${conditions.join(" OR ")})`;
}

// Same shape as customers.service.js's listCustomers: archived customers hidden unless asked
// for, search, pagination, and a booking count + last booking date per customer on the page -
// computed here with a real SQL aggregate against app.bookings (step 2.9's own table) instead of
// Mongo's separate aggregation pipeline.
async function listCustomers({ search, includeArchived = false, page = 1, limit = 25 } = {}) {
  const conditions = [];
  const values = [];
  if (!includeArchived) conditions.push("is_active = true");
  if (search) conditions.push(searchConditions(search, values));
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT count(*)::int AS n FROM app.customers ${where}`, values);
  const total = countResult.rows[0].n;

  const pageValues = [...values, limit, (page - 1) * limit];
  const rowsResult = await query(
    `SELECT * FROM app.customers ${where} ORDER BY name ASC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues
  );

  const customerIds = rowsResult.rows.map((row) => row.id);
  const statsById = new Map();
  if (customerIds.length > 0) {
    const statsResult = await query(
      `SELECT customer_id, count(*)::int AS booking_count, max(start_at) AS last_booking_at
       FROM app.bookings WHERE customer_id = ANY($1::uuid[]) GROUP BY customer_id`,
      [customerIds]
    );
    for (const row of statsResult.rows) statsById.set(row.customer_id, { bookingCount: row.booking_count, lastBookingAt: row.last_booking_at });
  }

  return {
    customers: rowsResult.rows.map((row) => {
      const stats = statsById.get(row.id);
      return { ...mapCustomerRow(row), bookingCount: stats ? stats.bookingCount : 0, lastBookingAt: stats ? stats.lastBookingAt : null };
    }),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function hasBookings(customerId) {
  const result = await query("SELECT count(*)::int AS n FROM app.bookings WHERE customer_id = $1", [customerId]);
  return result.rows[0].n > 0;
}

// No bookings -> really deleted. Has bookings -> archived (is_active = false), so booking
// history stays complete - the exact rule customers.service.js's own deleteCustomer enforces.
// The real foreign key (app.bookings.customer_id REFERENCES app.customers(id), no ON DELETE
// CASCADE, step 2.3) backs this up at the database level too: even bypassing this check, a raw
// DELETE against a customer with real bookings is refused outright (23503).
async function deleteCustomer(id) {
  const customer = await getCustomerById(id);
  if (!(await hasBookings(id))) {
    await query("DELETE FROM app.customers WHERE id = $1", [id]);
    return { result: "deleted", customer };
  }
  const archived = await updateCustomer(id, { isActive: false });
  return { result: "archived", customer: archived };
}

module.exports = {
  getCustomerById, createCustomer, updateCustomer, listCustomers, deleteCustomer, hasBookings, mapCustomerRow,
};
