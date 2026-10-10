// Every page loads several classic <script> files that share ONE global scope.
// If two of them declare the same top-level name (const/let/function/class), the page breaks.
// This test reads every page and checks that no name is declared twice. (No server needed.)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLIENT = path.join(__dirname, "..", "..", "client");

test("pages: every script exists and no two scripts on a page declare the same top-level name", () => {
  const pages = fs.readdirSync(path.join(CLIENT, "pages")).filter((file) => file.endsWith(".html"));
  assert.ok(pages.length >= 12, "all pages found");
  for (const page of pages) {
    const html = fs.readFileSync(path.join(CLIENT, "pages", page), "utf8");
    const scripts = [...html.matchAll(/<script src="\/js\/([^"]+)"/g)].map((m) => m[1]);
    const declaredIn = new Map();
    for (const script of scripts) {
      const file = path.join(CLIENT, "js", script);
      assert.ok(fs.existsSync(file), `${page}: ${script} exists`);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = match[1];
        assert.ok(!declaredIn.has(name), `${page}: "${name}" is declared in both ${declaredIn.get(name)} and ${script}`);
        declaredIn.set(name, script);
      }
    }
  }
});
