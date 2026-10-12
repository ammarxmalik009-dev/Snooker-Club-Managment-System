// Tests for client/vercel.json and client/404.html (deployment readiness, step 1.6). No database,
// no server needed - these check the FILES that will be deployed to Vercel, which this project's
// own server never reads (client/vercel.json is Vercel's own configuration format).
//
// What these tests can and cannot prove:
//  - CAN prove: the JSON is valid and has the fields Vercel's rewrites/redirects/headers need,
//    the API rewrite is a real cross-origin proxy (never resolved to a local file or 404), every
//    link on 404.html points to a real file, and every existing page/asset is still a real file
//    under client/ (so a correct client/vercel.json wouldn't accidentally hide any of them).
//  - CANNOT prove: that Vercel's live routing, rewrite or headers behave exactly as configured -
//    only an actual deployment can show that (see docs/POSTGRES_MIGRATION.md, step 1.6).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLIENT = path.join(__dirname, "..", "..", "client");
const CONFIG_PATH = path.join(CLIENT, "vercel.json");
const NOT_FOUND_PATH = path.join(CLIENT, "404.html");

let config;

test("client/vercel.json is valid JSON with the fields Vercel's rewrites/redirects/headers need", () => {
  const text = fs.readFileSync(CONFIG_PATH, "utf8");
  assert.doesNotThrow(() => { config = JSON.parse(text); }, "must be valid JSON");
  assert.equal(typeof config, "object");
  assert.equal(config.cleanUrls, false, "pages are linked with their .html extension everywhere - Vercel must not strip it");
  assert.ok(Array.isArray(config.rewrites) && config.rewrites.length >= 1);
  assert.ok(Array.isArray(config.redirects) && config.redirects.length >= 1);
  assert.ok(Array.isArray(config.headers) && config.headers.length >= 1);
  for (const rule of [...config.rewrites, ...config.redirects]) {
    assert.ok(typeof rule.source === "string" && rule.source.startsWith("/"), JSON.stringify(rule));
  }
});

test("API requests are proxied to the real backend, never resolved to a local file or the 404 page", () => {
  const apiRewrite = config.rewrites.find((r) => r.source === "/api/:path*");
  assert.ok(apiRewrite, "a rewrite for /api/:path* must exist (this is how the browser reaches Railway - see docs/POSTGRES_MIGRATION.md)");
  // An absolute https:// destination is a cross-origin PROXY: Vercel forwards the request to that
  // server and returns whatever it answers (success or error) - it never falls through to serving
  // a local static file or client/404.html for an /api/... address. A relative destination
  // (e.g. "/404.html" or "/pages/x.html") would be the bug this test exists to catch.
  assert.match(apiRewrite.destination, /^https:\/\/.+\/api\/:path\*$/, apiRewrite.destination);
  assert.doesNotMatch(apiRewrite.destination, /404\.html|\/pages\//, apiRewrite.destination);

  // No other rule in the file sends an /api/... address anywhere else
  for (const rule of [...config.rewrites, ...config.redirects]) {
    if (rule === apiRewrite) continue;
    assert.doesNotMatch(rule.source, /^\/api\b/, `unexpected extra rule for an /api address: ${JSON.stringify(rule)}`);
  }

  // The placeholder must still look like one: this is not a real backend address this test
  // should ever "validate" as correct, and a forgotten placeholder must fail loudly when deployed
  // (an unresolvable hostname), never silently point at someone else's real server.
  assert.match(apiRewrite.destination, /<[A-Z0-9_]+>/, "the backend URL is a placeholder until the real Railway address is known");
});

test("the home page redirects to the dashboard, matching the existing Express behavior (server/app.js)", () => {
  const home = config.redirects.find((r) => r.source === "/");
  assert.ok(home, "a redirect for \"/\" must exist");
  assert.equal(home.destination, "/pages/dashboard.html");
  assert.equal(home.permanent, false, "a temporary (302) redirect, like res.redirect() does today - never cached as permanent");
});

test("security headers apply to every response, matching the keys Express/helmet already sends locally", () => {
  const rule = config.headers.find((h) => h.source === "/(.*)");
  assert.ok(rule, "a headers rule covering every path must exist");
  const keys = rule.headers.map((h) => h.key);
  // These are the exact header names helmet() adds today (server/app.js) - confirmed by starting
  // the real app and reading its response headers. Vercel serves client/ with NONE of them unless
  // this file adds them: without this, every static file on Vercel would carry no security headers
  // at all, unlike the same page served by this Express app.
  for (const key of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Strict-Transport-Security"]) {
    assert.ok(keys.includes(key), key);
  }
  const csp = rule.headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, "matches the server's own CSP, which turns this directive off (see server/app.js)");
  assert.match(csp, /script-src 'self'/, "scripts only from this site - no inline script, no CDN");
});

test("client/404.html: a clear message, in the existing visual style, with a working way back - no script, no fake login", () => {
  const html = fs.readFileSync(NOT_FOUND_PATH, "utf8");
  assert.match(html, /<title>[^<]*404|not found[^<]*<\/title>/i);
  assert.match(html, /404/);
  assert.match(html, /not found|doesn't exist|does not exist/i);
  assert.doesNotMatch(html, /<script/i, "no JavaScript - the page must work even if the backend or login can't be reached");

  // Uses the real design system (not a one-off style), like every other page under client/
  for (const sheet of ["/css/theme.css", "/css/layout.css", "/css/components.css"]) {
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${sheet.replace(/\//g, "\\/")}">`));
  }

  // Every link on the page is a real file under client/ (reusing the pattern server/tests/vendor.test.js
  // already uses for every other page) - and it is NOT a page that assumes the visitor is logged in
  // without checking (dashboard.html runs the Step 1.5 guard itself, so this is safe either way).
  const links = [...html.matchAll(/\shref="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 1, "at least one way back");
  for (const link of links) {
    assert.ok(link.startsWith("/"), `"${link}" is a local absolute path`);
    assert.ok(fs.statSync(path.join(CLIENT, link)).isFile(), `${link} exists under client/`);
  }

  // Never a fabricated club figure, and never an actual club/session/environment detail
  assert.doesNotMatch(html, /\bRs\.?\s?\d|localhost|127\.0\.0\.1|MONGODB_URI|AUTH_SECRET|DATABASE_URL|process\.env/i);
});

test("every file client/404.html and client/vercel.json's redirect point to is real (sanity: the page can actually recover)", () => {
  assert.ok(fs.statSync(path.join(CLIENT, "pages", "dashboard.html")).isFile());
});
