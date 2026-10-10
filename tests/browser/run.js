// Browser tests: runs every suite (tests/browser/suites/*.html) in a real headless browser
// (Microsoft Edge or Google Chrome) against the real app with a throw-away database.
//
//   npm run test:browser                 all suites
//   npm run test:browser -- cafe reports some suites, in this order
//
// Each suite page logs in through the real login, does real clicks, and writes "PASS ..." /
// "FAIL ..." lines into <pre id="out">, which this script reads with --dump-dom.
// Isolation: every suite gets a brand-new browser profile, and every suite starts with /_reset.
// MongoDB must be running (npm run db). Exit code 1 if anything failed.
//
// Environment: BROWSER_PATH (the browser to use), BROWSER_TEST_PORT, BROWSER_TEST_DB_URI,
//              BROWSER_TEST_BUDGET_MS (virtual time per suite, default 400000)

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");

const SUITES_DIR = path.join(__dirname, "suites");
const PORT = Number(process.env.BROWSER_TEST_PORT || 3998);
const DB_URI = process.env.BROWSER_TEST_DB_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_uitest";
const BUDGET = Number(process.env.BROWSER_TEST_BUDGET_MS || 400000);

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error("No Edge/Chrome found. Set BROWSER_PATH to your browser's program file.");
  return found;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, BROWSER_TEST_PORT: String(PORT), BROWSER_TEST_DB_URI: DB_URI },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("BROWSER-TEST-SERVER READY")) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => reject(new Error(`Test server stopped (code ${code}):\n${output}`)));
  });
}

function decodeHtml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function runSuite(browser, name) {
  // A short path in the system temp folder (Windows has a path-length limit; profiles have deep folders)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scp-bt-"));
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    `--virtual-time-budget=${BUDGET}`, "--window-size=1400,1000", "--dump-dom", `http://127.0.0.1:${PORT}/_harness/${name}`];
  return new Promise((resolve) => {
    execFile(browser, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (error, stdout) => {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* best effort */ }
      const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout || "");
      const lines = match ? decodeHtml(match[1]).split("\n").map((l) => l.trim()).filter(Boolean) : [];
      const passed = lines.filter((l) => l.startsWith("PASS")).length;
      const failed = lines.filter((l) => l.startsWith("FAIL"));
      if (!match || lines[0] === "running") failed.push(`FAIL suite did not finish${error ? `: ${error.message}` : ""}`);
      resolve({ name, passed, failed });
    });
  });
}

(async () => {
  const all = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
  const wanted = process.argv.slice(2);
  const suites = wanted.length ? wanted : all;
  const unknown = suites.filter((s) => !all.includes(s));
  if (unknown.length) throw new Error(`Unknown suite(s): ${unknown.join(", ")}. Available: ${all.join(", ")}`);

  const browser = findBrowser();
  console.log(`Browser: ${browser}\nSuites: ${suites.join(", ")}\n`);
  const server = await startServer();
  const results = [];
  try {
    for (const name of suites) {
      const started = Date.now();
      const result = await runSuite(browser, name);
      results.push(result);
      console.log(`${result.failed.length ? "✖" : "✔"} ${name}: ${result.passed} passed, ${result.failed.length} failed (${Math.round((Date.now() - started) / 1000)}s)`);
      for (const line of result.failed) console.log(`    ${line}`);
    }
  } finally {
    server.kill();
    // Leave nothing behind: drop the throw-away database - only if its name says it is a test
    // database (Phase 11.8: the same rule as the test server and the server tests)
    await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 5000 }).then(() => {
      if (!/test/i.test(mongoose.connection.name)) throw new Error(`Not deleting "${mongoose.connection.name}": no "test" in its name`);
      return mongoose.connection.dropDatabase();
    }).catch((error) => console.error(`Test database not dropped: ${error.message}`));
    await mongoose.disconnect().catch(() => {});
  }
  const passed = results.reduce((sum, r) => sum + r.passed, 0);
  const failed = results.reduce((sum, r) => sum + r.failed.length, 0);
  console.log(`\nTOTAL ${passed} passed, ${failed} failed in ${results.length} suites`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
