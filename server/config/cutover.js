// Phase 3 cutover selector (Group 1). Decides, per named route group, whether PostgreSQL or
// MongoDB is the AUTHORITATIVE database for that group's reads and writes right now.
//
// MongoDB and PostgreSQL cannot share one ordinary database transaction, so this is
// deliberately NOT a synchronous dual-write: exactly one database is authoritative for a given
// route group at any moment, chosen here, and the OTHER database is simply not written to by
// that route at all while this module says so (see each cutover adapter, e.g.
// server/services/settingsCutover.service.js, for how a route actually honours this).
//
// PG_CUTOVER_ROUTES is read FRESH from process.env on every call, not cached once at require
// time the way most of server/config/env.js's settings are - two deliberate reasons:
//   1. Tests can flip it between subtests in the same process without fighting Node's require
//      cache (a real bug this project hit before, in a PostgreSQL pilot test file: requiring a
//      module that reads an env var before the test had finished setting it up).
//   2. In production, rolling back a route group to MongoDB (or forward to PostgreSQL) is then
//      "change the env var and the next request already sees it" - no code change, no redeploy,
//      the fastest and least error-prone rollback path available (see docs/POSTGRES_MIGRATION.md's
//      Phase 3 Group 1 section for the full rollback procedure, which still recommends a
//      reconciliation check before flipping, not because the flip itself is unsafe).
//
// An UNKNOWN name in PG_CUTOVER_ROUTES (a typo, or a route group that doesn't exist yet) throws
// loudly on every call that checks it - the same "fail loudly, never silently" choice this
// project already makes elsewhere (server/config/db.pg.js's own getPool(), server/config/env.js's
// strict TRUST_PROXY/ALLOWED_ORIGINS parsing). A silently-ignored typo would otherwise look
// exactly like "still on MongoDB" while the person who set it believes PostgreSQL is live.

const KNOWN_ROUTE_GROUPS = Object.freeze(["settings"]);

function parseRouteGroups(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// True if `routeGroup` should be served from PostgreSQL right now. Throws if PG_CUTOVER_ROUTES
// names any route group this module doesn't recognise - never silently treats a typo as "off".
function isPgAuthoritative(routeGroup) {
  const groups = parseRouteGroups(process.env.PG_CUTOVER_ROUTES);
  const unknown = groups.filter((group) => !KNOWN_ROUTE_GROUPS.includes(group));
  if (unknown.length > 0) {
    throw new Error(
      `PG_CUTOVER_ROUTES names unknown route group(s): ${unknown.join(", ")}. ` +
        `Known route groups: ${KNOWN_ROUTE_GROUPS.join(", ") || "(none yet)"}.`
    );
  }
  return groups.includes(routeGroup);
}

module.exports = { isPgAuthoritative, KNOWN_ROUTE_GROUPS };
