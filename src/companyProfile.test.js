const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { profile, load, validate, describeCount, SUPPORTED_LANGUAGES } = require("./companyProfile");

function writeTempProfile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "refal-profile-")), "company-profile.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

function validProfile(overrides = {}) {
  return {
    legalName: "Refalco Group",
    brand: "REFAL",
    groupName: "Refalco Group",
    foundedYear: 2000,
    yearsExperience: 20,
    developmentProjects: 47,
    totalProjects: 400,
    jurisdiction: "Cyprus",
    timezone: "Europe/Nicosia",
    cities: ["Limassol"],
    departments: ["Corporate"],
    languages: ["ar", "en", "el"],
    ...overrides
  };
}

test("the shipped profile loads and carries REFAL's identity", () => {
  assert.equal(profile.brand, "REFAL");
  // Confirmed by BOSS 2026-10-08. The source documents only ever say "Refalco
  // Group"; the registered entity name came from him directly.
  assert.equal(profile.legalName, "Refalco Group Ltd");
  assert.equal(profile.groupName, "Refalco Group");
  assert.equal(profile.jurisdiction, "Cyprus");
  assert.equal(profile.timezone, "Europe/Nicosia");
  assert.deepEqual(profile.languages, SUPPORTED_LANGUAGES);
});

test("the four credibility numbers match the master brain", () => {
  assert.equal(profile.foundedYear, 2000);
  assert.equal(profile.yearsExperience, 20);
  assert.equal(profile.developmentProjects, 47);
  assert.equal(profile.totalProjects, 400);
});

test("the profile is frozen, so no caller can mutate REFAL's identity at runtime", () => {
  assert.equal(Object.isFrozen(profile), true);
  // A frozen object only THROWS on assignment in strict mode; CommonJS modules
  // are sloppy by default, so the guarantee to assert is that the write has no
  // effect, not that it raises.
  profile.brand = "something else";
  assert.equal(profile.brand, "REFAL");
  delete profile.groupName;
  assert.equal(profile.groupName, "Refalco Group");
});

test("'more than' figures render with a + and exact ones do not", () => {
  // The master brain says أكثر من 20 عاماً and أكثر من 400 مشروع, but states 47
  // development projects exactly. Rendering 400 flat would misstate the source.
  assert.equal(describeCount("yearsExperience"), "20+");
  assert.equal(describeCount("totalProjects"), "400+");
  assert.equal(describeCount("developmentProjects"), "47");
});

test("a missing profile is a startup error, not a silent downgrade", () => {
  assert.throws(() => load(path.join(os.tmpdir(), "refal-does-not-exist", "company-profile.json")),
    /company-profile: cannot read/);
});

test("a malformed profile fails loudly rather than loading partially", () => {
  assert.throws(() => load(writeTempProfile("{ not json")), /not valid JSON/);
});

test("every required field is enforced", () => {
  for (const key of ["legalName", "brand", "groupName", "jurisdiction", "timezone"]) {
    assert.throws(() => validate(validProfile({ [key]: "" })), new RegExp(`"${key}" must be a non-empty string`));
  }
  for (const key of ["foundedYear", "yearsExperience", "developmentProjects", "totalProjects"]) {
    assert.throws(() => validate(validProfile({ [key]: 0 })), new RegExp(`"${key}" must be a positive integer`));
  }
  for (const key of ["cities", "departments", "languages"]) {
    assert.throws(() => validate(validProfile({ [key]: [] })), new RegExp(`"${key}" must be a non-empty array`));
  }
});

test("the 'the business' placeholder cannot re-enter through the config", () => {
  // BLK-3 is the defect this phase removes; the config must not reintroduce it.
  assert.throws(() => validate(validProfile({ legalName: "the business" })),
    /still contains the "the business" placeholder/);
});

test("an unsupported language is rejected", () => {
  assert.throws(() => validate(validProfile({ languages: ["ar", "fr"] })), /unsupported language\(s\): fr/);
});

test("a founding year in the future is rejected", () => {
  const nextYear = new Date().getUTCFullYear() + 1;
  assert.throws(() => validate(validProfile({ foundedYear: nextYear })), /is in the future/);
});

test("the 'the business' placeholder is absent from the whole repository", () => {
  // P1.1's G2 gate grepped only `src/ dashboard/ config/ supabase/`, which is
  // what W1.1.3 listed. It passed, and the placeholder was still live in 13
  // other files — including scripts/evaluateRag.js, where `expectedSource:
  // "the business Services"` meant the RAG evaluator was scoring against a
  // source name that can never exist, and docs/refal-agent-system-map.html,
  // a stakeholder-facing document.
  //
  // A gate scoped to four directories proves nothing about the fifth. This
  // walks the repository.
  const fs = require("node:fs");
  const path = require("node:path");
  const REPO = path.join(__dirname, "..");
  const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "artifacts", "auth_info"]);

  // Files that document the defect. The literal IS the evidence there, so
  // removing it would destroy the record. Each entry is a deliberate claim.
  const ALLOWED = new Set([
    ".planning/REFAL-BRAIN-MASTER-PLAN.md",            // the plan quotes the defect
    "docs/brain/CONFLICT-REGISTER.md",                 // CR-009 is the defect
    "docs/brain/KNOWN-DEFECTS.md",                     // FIX-13 is the defect
    "docs/brain/SOURCE-ANALYSIS.md",
    "docs/brain/SURFACE-AND-GATE-INVENTORY.md",
    "docs/brain/ROADMAP-COMPARISON.html",
    "docs/brain/PLAN-PROGRESS.html",                   // generated from the plan
    "scripts/reproduceKnownDefects.js",                // reproduces it on purpose
    "src/companyProfile.js",                           // the validator rejects it
    "src/companyProfile.test.js"                       // this file
  ]);

  // The placeholder wearing a name's clothes: quoted as a value, or followed by
  // a capitalised word the way a brand name is ("the business Services").
  // No `i` flag, deliberately. The whole discriminator is that the word AFTER
  // the phrase is capitalised the way a brand name is, and a case-insensitive
  // `[A-Z]` matches every lowercase letter too, which turns the shape check back
  // into the substring check it was meant to replace. `[Tt]` carries the only
  // case-insensitivity that is actually wanted.
  const PLACEHOLDER_AS_A_NAME = /["'`]\s*[Tt]he business\b[^"'`]*["'`]|\b[Tt]he business\s+[A-Z]/u;

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.(?:js|mjs|ts|tsx|jsx|json|md|html|sql)$/.test(entry.name)) continue;
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(full, "utf8");

      // M3's corpus is 87 hand-written documents of ordinary business English,
      // and "the business" is an ordinary English phrase in it: "amended as the
      // business evolves", "which part of the business needs to be inside the
      // EU". Seventeen such sentences are correct prose and none of them is the
      // defect.
      //
      // The defect was a PLACEHOLDER standing in for the company NAME, and it
      // always looked like a name: `expectedSource: "the business Services"`,
      // or the bare phrase quoted as a value. So inside knowledge/ the gate
      // matches that SHAPE instead of the substring. Everywhere else, including
      // every prompt surface, every config file and every script, the ban stays
      // exactly as absolute as it was, because that is where the placeholder
      // actually lived and there is nothing to loosen for.
      //
      // This is narrower, not weaker: a file under knowledge/ carrying
      // `"the business"` as a value, or `the business Services` as a name, still
      // fails, and there is a test below that proves it.
      const corpusProse = rel.startsWith("knowledge/");
      const pattern = corpusProse ? PLACEHOLDER_AS_A_NAME : /the business/i;
      const hits = text.match(new RegExp(pattern.source, `${pattern.flags.replace(/g/u, "")}g`)) || [];
      if (hits.length) offenders.push(`${rel} (${hits.length}: ${hits.slice(0, 3).join(", ")})`);
    }
  };
  walk(REPO);

  assert.deepEqual(offenders, [],
    `the "the business" placeholder is back in:\n  ${offenders.join("\n  ")}\n`
    + "Replace it with the configured company name, or add the file to ALLOWED "
    + "if it exists to document the defect.");
});

test("the narrowed corpus rule still catches the placeholder wearing a name's clothes", () => {
  // Proof that scoping the previous test to a SHAPE inside knowledge/ did not
  // weaken it. Each of these is the defect; each of these must still fail.
  // No `i` flag, deliberately. The whole discriminator is that the word AFTER
  // the phrase is capitalised the way a brand name is, and a case-insensitive
  // `[A-Z]` matches every lowercase letter too, which turns the shape check back
  // into the substring check it was meant to replace. `[Tt]` carries the only
  // case-insensitivity that is actually wanted.
  const PLACEHOLDER_AS_A_NAME = /["'`]\s*[Tt]he business\b[^"'`]*["'`]|\b[Tt]he business\s+[A-Z]/u;

  for (const defect of [
    `expectedSource: "the business Services"`,
    `the business Services is the approved source`,
    `source_name: 'the business'`,
    "Contact the business Group for more detail.",
  ]) {
    assert.ok(PLACEHOLDER_AS_A_NAME.test(defect), `the placeholder slipped through: ${defect}`);
  }

  // And each of these is ordinary English that the corpus is entitled to use.
  for (const prose of [
    "Directors and shareholders are amended as the business evolves.",
    "which part of the business needs to be inside the EU",
    "the pace is slower than in the business cities",
    "What does the business actually do?",
  ]) {
    assert.ok(!PLACEHOLDER_AS_A_NAME.test(prose), `correct prose was rejected: ${prose}`);
  }
});
