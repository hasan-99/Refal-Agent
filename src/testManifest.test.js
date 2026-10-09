const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// The suite footgun, turned into a gate.
//
// `package.json#scripts.test` is a hand-maintained list of file paths, not a
// glob. A new test file is therefore SILENTLY EXCLUDED and the suite still
// reports green — the most dangerous possible failure mode for a test runner,
// because the number goes up and the coverage does not.
//
// This was recorded as a footgun during P1.1 after src/companyProfile.test.js
// had to be added by hand. The M1 close then found src/leadQualification.test.js
// had been sitting on disk, passing, and never running in CI for an unknown
// number of commits. A note in a plan file does not stop that; a failing test
// does.
//
// dashboard/ is not checked here: it runs `node --test`, which globs, so it
// cannot have this problem.

const REPO = path.join(__dirname, "..");

test("every src/*.test.js on disk is listed in package.json#scripts.test", () => {
  const script = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts.test;

  const onDisk = fs.readdirSync(__dirname)
    .filter((file) => /\.test\.m?js$/.test(file))
    .map((file) => `src/${file}`)
    .sort();

  // Match on the exact path token so that e.g. "src/ai.test.js" cannot be
  // considered covered by "src/aiPrivacy.test.js".
  const listed = new Set(script.split(/\s+/));
  const missing = onDisk.filter((file) => !listed.has(file));

  assert.deepEqual(missing, [],
    `these test files never run: ${missing.join(", ")}. Add them to package.json#scripts.test — the list is not a glob.`);
});

test("every scripts/*.test.js on disk is listed in package.json#scripts.test", () => {
  // The same blind spot, one directory over. FIX-27 added the src/ check and
  // stopped there, but scripts/ holds eight test files that are listed purely by
  // hand with nothing enforcing it. All eight happen to be listed today, which
  // is exactly the state src/ was in before leadQualification.test.js went
  // missing for an unknown number of commits.
  const script = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts.test;

  const onDisk = fs.readdirSync(path.join(REPO, "scripts"))
    .filter((file) => /\.test\.m?js$/.test(file))
    .map((file) => `scripts/${file}`)
    .sort();

  const listed = new Set(script.split(/\s+/));
  const missing = onDisk.filter((file) => !listed.has(file));

  assert.deepEqual(missing, [],
    `these test files never run: ${missing.join(", ")}. Add them to package.json#scripts.test — the list is not a glob.`);
});

test("the dashboard suite is reachable from a single named command", () => {
  // The same failure mode as leadQualification.test.js, one directory over.
  // dashboard/ has 18 test files and its own `node --test` script, which DOES
  // glob — but nothing invoked it, and there is no CI config in the repo, so
  // `npm test` at the root was the only gate anyone ran. A test nobody runs is
  // not coverage. `npm run test:all` is now the one command that gates both.
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;

  assert.ok(scripts["test:all"], "package.json has no test:all script");
  assert.match(scripts["test:all"], /--prefix dashboard test/,
    "test:all no longer runs the dashboard suite");

  // And the dashboard script must stay a glob, or adding a file there would
  // silently skip it exactly as it did at the root.
  const dashboard = JSON.parse(fs.readFileSync(path.join(REPO, "dashboard", "package.json"), "utf8")).scripts;
  assert.match(dashboard.test, /^node --test\s*$/,
    "dashboard/package.json#scripts.test stopped being a bare glob; list-based scripts silently skip new files");
});

test("package.json#scripts.test does not reference a test file that was deleted", () => {
  const script = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts.test;

  const referenced = script.split(/\s+/).filter((token) => /^(?:src|dashboard)\/.+\.test\.m?js$/.test(token));
  const stale = referenced.filter((file) => !fs.existsSync(path.join(REPO, file)));

  assert.deepEqual(stale, [], `scripts.test points at files that no longer exist: ${stale.join(", ")}`);
});
