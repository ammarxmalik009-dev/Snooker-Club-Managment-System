// THE ONE PLACE that decides who may do what.
// Routes say which permission they need (e.g. requirePermission("settings:manage"));
// the server checks it on every request. The browser only uses this list to hide
// buttons and menu items it can't use - that is convenience, not security.
//
//                     admin  staff  cashier
//  Dashboard            ✅     ✅      ✅
//  Tables               ✅     ✅      ✅
//  Sessions             ✅     ✅      ✅
//  Customers            ✅     ✅      ✅
//  Bookings             ✅     ✅      ✅
//  Billing (bills)      ✅     ✅      ✅   create, view, print
//  Cancel a bill        ✅     ❌      ✅   money-handling roles only
//  Payments: view       ✅     ✅      ✅
//  Payments: record     ✅     ❌      ✅   staff "view payments" only (see Phase 8 brief)
//  Settings: view       ✅     ✅      ✅   (rates are shown in the bill window)
//  Settings: change     ✅     ❌      ❌
//  User management      ✅     ❌      ❌
//  Backups (XML)        ✅     ❌      ❌   status, Backup Now, download
//  Reports (Phase 9)    ✅     ✅      ❌   business figures: owner + staff, not the cash desk
//  Café (Phase 10):
//   see products/stock  ✅     ✅      ✅   (to sell, everyone must see what's on sale)
//   sell (session tab)  ✅     ✅      ✅
//   categories/products ✅     ❌      ❌   names, prices, active/inactive
//   restock             ✅     ✅      ❌   goods received
//   adjust / waste      ✅     ❌      ❌   sensitive: corrections and write-offs
//   stock history       ✅     ✅      ❌
//  Players (Phase 11):
//   view players        ✅     ✅      ✅
//   register / edit     ✅     ✅      ❌
//   deactivate          ✅     ❌      ❌   never deleted, so history keeps its references
//  Matches (Phase 11.4):
//   view                ✅     ✅      ✅
//   start / edit players / complete / change result
//                       ✅     ✅      ✅   part of running the table and preparing the bill
//   cancel a match      ✅     ✅      ❌
//   change the result once the match's bill has payments
//                       ✅     ❌      ❌   financial history: admin only

const ALL = ["admin", "staff", "cashier"];
const ADMIN = ["admin"];

const PERMISSIONS = {
  "dashboard:view": ALL,
  "tables:view": ALL,
  "tables:manage": ALL,
  "sessions:view": ALL,
  "sessions:manage": ALL,
  "customers:view": ALL,
  "customers:manage": ALL,
  "bookings:view": ALL,
  "bookings:manage": ALL,
  "bills:view": ALL,
  "bills:create": ALL,
  "bills:cancel": ["admin", "cashier"],
  // Payments are part of a bill: they are seen with the bill (GET /bills/:id, "bills:view"). This entry
  // records that every role may see them; no endpoint checks it on its own (Phase 11.8 note).
  "payments:view": ALL,
  "payments:record": ["admin", "cashier"],
  "settings:view": ALL,
  "settings:manage": ADMIN,
  "users:manage": ADMIN,
  "backups:manage": ADMIN, // XML backups of the whole database: status, Backup Now, download
  "reports:view": ["admin", "staff"],
  // Phase 10: café products & inventory
  "cafe:view": ALL,
  "cafe:sell": ALL,
  "products:manage": ADMIN,
  "stock:restock": ["admin", "staff"],
  "stock:adjust": ADMIN,
  "stock:view": ["admin", "staff"],
  // Phase 11: registered players (separate from booking customers)
  "players:view": ALL,
  "players:manage": ["admin", "staff"], // register and edit
  "players:deactivate": ADMIN,          // deactivate / reactivate (never deleted)
  // Phase 11.4: matches inside a session
  "matches:view": ALL,
  "matches:manage": ALL,                 // start, edit players, complete, change an unpaid result
  "matches:cancel": ["admin", "staff"],
  "matches:correct-paid": ADMIN,         // change the result after the match's bill has payments
};

function roleHasPermission(role, permission) {
  const roles = PERMISSIONS[permission];
  if (!roles) throw new Error(`Unknown permission "${permission}"`); // a typo must never silently allow access
  return roles.includes(role);
}

function permissionsForRole(role) {
  return Object.keys(PERMISSIONS).filter((permission) => PERMISSIONS[permission].includes(role));
}

// Pages that only some roles may open (checked by the server before the page is sent)
const PAGE_PERMISSIONS = {
  "/pages/settings.html": "settings:manage",
  "/pages/users.html": "users:manage",
  "/pages/reports.html": "reports:view",
  "/pages/products.html": "cafe:view",
  "/pages/categories.html": "cafe:view",
  "/pages/players.html": "players:view",
};

module.exports = { PERMISSIONS, roleHasPermission, permissionsForRole, PAGE_PERMISSIONS };
