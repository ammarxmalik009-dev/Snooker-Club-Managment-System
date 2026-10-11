// Tests for the vendored Chart.js (deployment readiness, step 1.4). No database needed.
//  - client/vendor/chart.umd.min.js is an unchanged copy of the installed npm package (same version,
//    same bytes), with its license files - so Vercel, which serves client/ without node_modules, has it
//  - every local script and stylesheet a page links to is a real file under client/ (what Vercel serves)
//  - the Express app serves the same file from client/vendor (no special node_modules route any more)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../app");

const ROOT = path.join(__dirname, "..", "..");
const CLIENT = path.join(ROOT, "client");
const VENDORED = path.join(CLIENT, "vendor", "chart.umd.min.js");
const INSTALLED = path.join(ROOT, "node_modules", "chart.js", "dist", "chart.umd.min.js");

test("vendored Chart.js: same version and same bytes as the installed npm package", () => {
  const installedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "chart.js", "package.json"), "utf8")).version;
  const lockedVersion = require(path.join(ROOT, "package-lock.json")).packages["node_modules/chart.js"].version;
  assert.equal(installedVersion, lockedVersion, "node_modules matches package-lock.json (run npm install)");

  const vendored = fs.readFileSync(VENDORED);
  assert.ok(vendored.equals(fs.readFileSync(INSTALLED)),
    "client/vendor/chart.umd.min.js differs from node_modules/chart.js - copy it again (see client/vendor/README.md)");
  // the published copyright notice is kept at the top of the file
  assert.match(vendored.toString("utf8", 0, 300), new RegExp(`^/\\*!\\n \\* Chart\\.js v${installedVersion.replace(/\./g, "\\.")}\\n[\\s\\S]*Released under the MIT License`));
  assert.ok(vendored.toString("utf8").includes("@kurkle/color"), "the bundled @kurkle/color notice is kept");
});

test("vendored Chart.js: the MIT license files of Chart.js and @kurkle/color are next to it", () => {
  const licenses = [
    ["chart.js.LICENSE.md", path.join(ROOT, "node_modules", "chart.js", "LICENSE.md"), /Copyright \(c\) 2014-\d{4} Chart\.js Contributors/],
    ["kurkle-color.LICENSE.md", path.join(ROOT, "node_modules", "@kurkle", "color", "LICENSE.md"), /Copyright \(c\) 2018-\d{4} Jukka Kurkela/],
  ];
  for (const [file, source, copyright] of licenses) {
    const text = fs.readFileSync(path.join(CLIENT, "vendor", file), "utf8");
    assert.equal(text, fs.readFileSync(source, "utf8"), `${file} is the package's own license file`);
    assert.match(text, /^The MIT License \(MIT\)/, file);
    assert.match(text, copyright, file);
  }
});

test("pages: every local script and stylesheet is a file under client/ (Vercel serves client/ as the site root)", () => {
  const pages = fs.readdirSync(path.join(CLIENT, "pages")).filter((file) => file.endsWith(".html"));
  assert.ok(pages.length >= 12, "all pages found");
  const chartPages = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(CLIENT, "pages", page), "utf8");
    const links = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]);
    for (const link of links) {
      assert.ok(link.startsWith("/"), `${page}: "${link}" is a local absolute path (no CDN, no relative path)`);
      assert.ok(fs.statSync(path.join(CLIENT, link)).isFile(), `${page}: ${link} exists under client/`);
    }
    const chartTags = links.filter((link) => link.includes("chart"));
    if (chartTags.length) chartPages.push([page, chartTags]);
  }
  // Chart.js is loaded once, only on the reports page, from the vendored file
  assert.deepEqual(chartPages, [["reports.html", ["/vendor/chart.umd.min.js"]]]);
});

test("the Express app serves the vendored file from client/vendor as JavaScript", async () => {
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "server", "app.js"), "utf8"), /["']node_modules["']|\/vendor\//, "no special node_modules route");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/vendor/chart.umd.min.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^(text|application)\/javascript/);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(VENDORED)));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
