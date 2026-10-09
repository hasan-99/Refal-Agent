const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  PROMPT_VERSION, CHANGE_HISTORY, MANDATORY_BLOCKS, BLOCKS,
  buildBrainPrompt, bookingOfferBlock
} = require("./brainPrompt");

// W1.7.9 — drift test.
//
// Three runtime surfaces answer as REFAL: the customer path (src/ai.js), the
// operator dashboard (dashboard/server.js), and the edge function. Before P1.7
// each carried its own hand-maintained copy of the rules, and they drifted —
// BLK-5 and BLK-6 were both "a rule that is right on one surface and wrong on
// another". That is not a wording problem: it means the operator and the
// customer can be told different things about the same policy.
//
// This test fails the build when a surface stops carrying the mandatory set.

const REPO = path.join(__dirname, "..");

test("every mandatory block is defined and produces real content", () => {
  for (const name of MANDATORY_BLOCKS) {
    const block = BLOCKS[name];
    assert.equal(typeof block, "function", `missing mandatory block: ${name}`);
    const lines = block();
    assert.ok(Array.isArray(lines) && lines.length > 0, `${name} produced no lines`);
    for (const line of lines) {
      assert.ok(typeof line === "string" && line.trim().length > 30, `${name} has a thin line: ${line}`);
    }
  }
});

test("the customer and operator variants carry the SAME mandatory rules", () => {
  const customer = buildBrainPrompt({ variant: "customer" }).join("\n");
  const operator = buildBrainPrompt({ variant: "operator" }).join("\n");

  for (const name of MANDATORY_BLOCKS) {
    if (name === "identity") continue; // framing differs by design; asserted below
    for (const line of BLOCKS[name]()) {
      assert.ok(customer.includes(line), `customer prompt is missing ${name}: ${line.slice(0, 50)}`);
      assert.ok(operator.includes(line), `operator prompt is missing ${name}: ${line.slice(0, 50)}`);
    }
  }
});

test("both variants state REFAL's identity and keep facts evidence-gated", () => {
  for (const variant of ["customer", "operator"]) {
    const prompt = buildBrainPrompt({ variant }).join("\n");
    assert.match(prompt, /REFAL/, `${variant} prompt does not name REFAL`);
    assert.match(prompt, /Refalco Group/, `${variant} prompt does not name the group`);
    assert.match(prompt, /approved/i, `${variant} prompt does not gate facts on approved evidence`);
    // BLK-3 must never come back on either surface.
    assert.doesNotMatch(prompt, /No company identity or services are preconfigured/,
      `${variant} prompt reintroduced BLK-3`);
  }
});

test("W1.7.6: BLK-5's blanket cross-sell ban is gone, replaced by a conditional rule", () => {
  const prompt = buildBrainPrompt({ variant: "customer" }).join("\n");
  // The old absolute prohibition must not be present...
  assert.doesNotMatch(prompt, /Do not volunteer unrelated prices, packages, services/i);
  // ...and the conditional replacement must be.
  assert.match(prompt, /ONE relevant cross-sell hook when its trigger fires/);
});

test("W1.7.7: BLK-6's blanket call ban is gone, replaced by a tier-aware rule", () => {
  // Tiers are the four the system actually emits (see leadTemperature.js).
  // COLD means an EXPLICIT DECLINE here, not "not warm yet", so it gets the
  // strongest instruction of all — stronger than the no-signal default.
  assert.match(bookingOfferBlock("cold").join(" "), /declined contact.*do not ask again/is);
  // Unclassified / unknown: no offer yet, but the door is open.
  assert.match(bookingOfferBlock("unclassified").join(" "), /Do not offer a call or meeting at this stage/);
  assert.match(bookingOfferBlock("").join(" "), /Do not offer a call or meeting at this stage/);
  // Warm: flexible.
  assert.match(bookingOfferBlock("warm").join(" "), /flexibly/);
  // Hot: move to booking with consent.
  assert.match(bookingOfferBlock("hot").join(" "), /move to booking, with their consent/);

  // All four tiers must give genuinely different instructions.
  const tiers = ["cold", "unclassified", "warm", "hot"].map((tier) => bookingOfferBlock(tier).join(" "));
  assert.equal(new Set(tiers).size, 4, "tiers must not collapse to the same instruction");
});

test("the booking tiers match the vocabulary leadTemperature actually emits", () => {
  // Guards against reintroducing invented tiers like "informational" or "hnw",
  // which looked reasonable but could never be produced by the classifier.
  const { LEAD_TIERS } = require("./leadTemperature");
  assert.deepEqual(Object.values(LEAD_TIERS).sort(), ["cold", "hot", "unclassified", "warm"]);
  for (const tier of Object.values(LEAD_TIERS)) {
    assert.ok(bookingOfferBlock(tier).join(" ").length > 20, `no instruction for tier ${tier}`);
  }
});

test("the prompt stays COMPACT — stable rules only, no reference content", () => {
  // CX 5A. Reference content belongs in retrieval. A prompt that grows per
  // customer or per price is a prompt that cannot be versioned or rolled back.
  const prompt = buildBrainPrompt({ variant: "customer" });
  // The ceiling is a ratchet, not an aspiration: it is set just above the
  // current size so the prompt cannot grow unnoticed. "Compact" here means no
  // per-customer or per-price REFERENCE content — that is what the assertions
  // below actually enforce. Raising this number should require a reason.
  assert.ok(prompt.length <= 60, `prompt has ${prompt.length} lines; keep it compact`);

  const joined = prompt.join("\n");
  // The four credibility numbers are FACTS and must reach customers through
  // evidence-gated knowledge, never through the prompt (P1.1 gate G3).
  assert.doesNotMatch(joined, /\b(?:2000|47|400)\b/, "a credibility number leaked into the prompt");
  // No prices in the prompt either.
  assert.doesNotMatch(joined, /\b\d{3,}\s*(?:EUR|€|USD)/i, "a price leaked into the prompt");
});

test("W1.7.8: the prompt is versioned and the history is ordered and complete", () => {
  assert.match(PROMPT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(CHANGE_HISTORY.length >= 1);
  assert.equal(CHANGE_HISTORY[0].version, PROMPT_VERSION,
    "the newest change-history entry must match PROMPT_VERSION");
  for (const entry of CHANGE_HISTORY) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.summary.length > 30, `change entry ${entry.version} needs a real summary`);
    assert.ok(entry.phase, `change entry ${entry.version} needs an owning phase`);
  }
});

test("the runtime surfaces CALL the shared prompt builder, not merely import it", () => {
  // The original version of this test only checked that `require(...)` was
  // present. That was too weak and it lied: brainPrompt was imported by both
  // surfaces while each still built its prompt from its own inline array, and
  // the test passed anyway. Importing a module proves nothing about using it.
  //
  // This now asserts an actual CALL, and separately that the inline array those
  // calls replaced has not grown back.
  const surfaces = [
    ["src/ai.js", /\.\.\.buildBrainPrompt\(/],
    ["dashboard/server.js", /\.\.\.buildOperatorPrompt\(|\.\.\.buildBrainPrompt\(/]
  ];
  for (const [file, callPattern] of surfaces) {
    const source = fs.readFileSync(path.join(REPO, file), "utf8");
    assert.match(source, /require\(["'][^"']*brainPrompt(?:\.js)?["']\)/, `${file} no longer imports the shared brain prompt`);
    assert.match(source, callPattern, `${file} imports the shared prompt but never calls it — that is drift, not reuse`);
  }
});

test("the shared blocks are the ONLY source of the mandatory rules on each surface", () => {
  // A surface must not re-declare a mandatory rule as its own literal. If it
  // does, the shared block and the local copy can diverge and the build will
  // still be green — which is precisely how BLK-5 and BLK-6 survived.
  const owned = [
    ...BLOCKS.compliance(),
    ...BLOCKS.precedence(),
    ...BLOCKS.antiPatterns()
  ];
  for (const file of ["src/ai.js", "dashboard/server.js"]) {
    const source = fs.readFileSync(path.join(REPO, file), "utf8");
    for (const rule of owned) {
      // Compare on a distinctive fragment: whole-line matching is brittle
      // against formatting, but a 45-character slice is specific enough.
      const fragment = rule.slice(0, 45);
      assert.ok(!source.includes(fragment),
        `${file} re-declares a shared rule instead of using the block: "${fragment}..."`);
    }
  }
});

test("W1.7.4: the edge function BUILDS its prompt from the shared mirror", async () => {
  // The edge function is the third runtime surface. It is Deno/TypeScript and
  // cannot require() a CommonJS module, so it imports a generated ESM mirror —
  // the same pattern the repo already uses for responsePolicy.mjs.
  //
  // The first pass of P1.7 skipped the mirror and asserted parity on index.ts's
  // source text instead. That was not parity: the surface kept its own inline
  // rule array, and BLK-5 and BLK-6 both survived there after being fixed on
  // the other two surfaces. Source-text matching cannot catch a rule that is
  // merely WORDED differently, which is how the drift happened in the first
  // place.
  const edge = fs.readFileSync(
    path.join(REPO, "supabase/functions/rafa-agent-api/index.ts"), "utf8");

  assert.match(edge, /from "\.\/brainPrompt\.mjs"/,
    "the edge function no longer imports the shared prompt mirror");
  assert.match(edge, /\.\.\.buildOperatorPrompt\(/,
    "the edge function imports the mirror but never calls it — that is drift, not reuse");
  assert.doesNotMatch(edge, /"You are a business assistant operating inside the dashboard\. No company identity or services are preconfigured/,
    "the edge function reintroduced BLK-3");

  const mirror = await import(
    pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs")).href);
  const built = mirror.buildBrainPrompt({ variant: "operator" }).join("\n");
  assert.match(built, /You are REFAL's assistant operating inside the dashboard for Refalco Group/,
    "the edge prompt does not state REFAL's identity");
  assert.match(built, /Company FACTS require retrieved approved knowledge/,
    "the edge prompt stopped gating facts on approved evidence");
});

test("W1.7.4: the generated mirror has not drifted from src/brainPrompt.js", async () => {
  // The real no-drift guarantee. Source-text greps compare wording; this
  // compares the ASSEMBLED prompt, line for line, for every lead tier. If
  // anyone edits one rule in the CommonJS module and forgets to regenerate,
  // this fails rather than the three surfaces quietly disagreeing again.
  const mirror = await import(
    pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs")).href);

  assert.equal(mirror.PROMPT_VERSION, PROMPT_VERSION, "the mirror is pinned to an older prompt version");
  assert.deepEqual([...mirror.MANDATORY_BLOCKS], [...MANDATORY_BLOCKS]);

  for (const tier of ["", "cold", "unclassified", "warm", "hot"]) {
    assert.deepEqual(
      mirror.buildBrainPrompt({ variant: "operator", leadTier: tier }),
      buildBrainPrompt({ variant: "operator", leadTier: tier }),
      `the edge mirror disagrees with src/brainPrompt.js at tier "${tier}" — run node scripts/generateEdgeBrainPrompt.js`);
  }

  // The committed file must also be byte-identical to what the generator emits,
  // so a hand-edit cannot sneak in even if it happens to produce equal output.
  const check = spawnSync(process.execPath, ["scripts/generateEdgeBrainPrompt.js", "--check"], { cwd: REPO });
  assert.equal(check.status, 0, `generator --check failed: ${check.stderr}`);
});

test("W1.7.4: the mirror refuses the customer variant rather than faking it", async () => {
  // personaRoles and humourEngine are not mirrored — they are per-turn and
  // customer-path only. A mirror that silently returned a persona-less customer
  // prompt would be the worst possible failure mode: plausible output, missing
  // voice. It throws instead.
  const mirror = await import(
    pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs")).href);
  assert.throws(() => mirror.buildBrainPrompt({ variant: "customer" }), /operator variant only/);
});

test("W1.7.7: BLK-6's blanket ban is absent from the ASSEMBLED prompt, not just the block", () => {
  // The earlier W1.7.7 test checked bookingOfferBlock() in isolation and
  // passed, while the operational block a few lines above still carried the
  // absolute ban. Both reached the model. Assert on the finished prompt.
  for (const variant of ["customer", "operator"]) {
    for (const tier of ["", "cold", "warm", "hot"]) {
      const prompt = buildBrainPrompt({ variant, leadTier: tier }).join("\n");
      assert.doesNotMatch(prompt, /Do not introduce a call, meeting, or (?:(?:Refalco Group|specialist) )?contact during ordinary information gathering/,
        `${variant}/${tier} prompt reintroduced BLK-6`);
      // Every variant must still carry SOME contact rule: removing the ban
      // without a replacement would be a fail-open, not a fix.
      assert.ok(bookingOfferBlock(tier).every((line) => prompt.includes(line)),
        `${variant}/${tier} prompt lost its booking rule entirely`);
    }
  }
  // And the hot-tier instruction must actually be reachable, which is what the
  // blanket ban used to contradict.
  assert.match(buildBrainPrompt({ variant: "customer", leadTier: "hot" }).join("\n"),
    /Stop selling and move to booking, with their consent/);
});

test("all three surfaces name REFAL and gate facts on approved evidence", () => {
  const sources = [
    ["src/ai.js", fs.readFileSync(path.join(REPO, "src/ai.js"), "utf8")],
    ["dashboard/server.js", fs.readFileSync(path.join(REPO, "dashboard/server.js"), "utf8")],
    ["edge function", fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/index.ts"), "utf8")]
  ];
  for (const [name, source] of sources) {
    assert.match(source, /Refalco Group/, `${name} does not name the group`);
    assert.doesNotMatch(source, /content: \[\s*\n\s*"You are a business assistant operating inside the dashboard\. No company identity/,
      `${name} still opens with BLK-3`);
  }
});

test("the three surfaces agree on the mandatory compliance rules verbatim", () => {
  // Spot-check the rules where drift would be most dangerous: the ones that
  // stop credentials and fabricated approvals reaching a customer.
  const compliance = BLOCKS.compliance();
  const customer = buildBrainPrompt({ variant: "customer" }).join("\n");
  const operator = buildBrainPrompt({ variant: "operator" }).join("\n");
  for (const rule of compliance) {
    assert.ok(customer.includes(rule), `customer surface lost a compliance rule: ${rule.slice(0, 40)}`);
    assert.ok(operator.includes(rule), `operator surface lost a compliance rule: ${rule.slice(0, 40)}`);
  }
});

test("BLK-3/5/6 are absent from the FOURTH prompt surface, the Agent decision step", () => {
  // P1.7 scoped itself to three surfaces. src/agentDecision.js is a fourth, and
  // it kept all three blockers verbatim after they were removed from the other
  // three: "No company identity, services, or prices are preconfigured" (BLK-3)
  // and one string carrying both the blanket pricing ban (BLK-5) and the
  // blanket booking ban (BLK-6).
  //
  // It is reached through REFAL_AGENT_LIVE_ENABLED *or* REFAL_AGENT_SHADOW_ENABLED,
  // and shadow mode still sends this prompt to a real model — it only stubs the
  // write tools. "Default off" was never a reason to leave a blocker in it.
  const { buildDecisionMessages } = require("./agentDecision");
  const { profile } = require("./companyProfile");

  const system = buildDecisionMessages({ currentMessage: "What does company formation cost?" }).at(0).content;

  assert.doesNotMatch(system, /No company identity(?:, services,)? or (?:services|prices) are preconfigured/i,
    "the Agent decision prompt reintroduced BLK-3");
  assert.doesNotMatch(system, /Never offer pricing, booking, or a specialist\/handover/i,
    "the Agent decision prompt reintroduced BLK-5/BLK-6");

  // And it must positively carry the same identity the other three state.
  assert.ok(system.includes(profile.brand), "the Agent decision prompt does not name REFAL");
  assert.ok(system.includes(profile.groupName), "the Agent decision prompt does not name the group");
  // Facts stay gated on a tool result, which is this surface's form of the
  // evidence rule. Removing BLK-3 must not become "state anything".
  assert.match(system, /require current approved knowledge from a tool result/i,
    "the Agent decision prompt stopped gating facts on a tool result");
  // The replacement booking rule must be present, not merely the ban removed.
  assert.match(system, /Do not offer a call, meeting, or specialist handover at this stage/,
    "removing BLK-6 here left no contact rule at all, which is a fail-open");
});

test("every surface DERIVES its identity line from the profile, not a literal", () => {
  // The requirement is narrower than "no literal anywhere". Rule TEXT may name
  // the company ("never produce a claim about Refalco Group"), and several of
  // those strings are pinned verbatim by src/ragPolicy.test.js across three
  // files — templating them would break that parity check for no gain.
  //
  // What must be profile-derived is the IDENTITY STATEMENT, the line that says
  // who REFAL works for. That is the one a rename has to change, and a literal
  // there is how a surface drifts into claiming a different employer.
  const { profile } = require("./companyProfile");

  for (const file of ["src/brainPrompt.js", "src/agentDecision.js"]) {
    const source = fs.readFileSync(path.join(REPO, file), "utf8");
    assert.match(source, /require\(["'][^"']*companyProfile["']\)/,
      `${file} does not read the company profile at all`);
    // The identity sentence must interpolate, never hardcode.
    assert.match(source, /\$\{profile\.groupName\}/,
      `${file} hardcodes the group name in its identity line instead of using profile.groupName`);
    assert.match(source, /\$\{profile\.brand\}/,
      `${file} hardcodes the brand in its identity line instead of using profile.brand`);
  }

  // A rename is then a data edit: change the profile and all four surfaces move
  // together. Prove the identity text actually reflects the configured values.
  const { buildDecisionMessages } = require("./agentDecision");
  const agentSystem = buildDecisionMessages({ currentMessage: "hello" }).at(0).content;
  for (const prompt of [
    buildBrainPrompt({ variant: "customer" }).join(" "),
    buildBrainPrompt({ variant: "operator" }).join(" "),
    agentSystem
  ]) {
    assert.ok(prompt.includes(profile.brand) && prompt.includes(profile.groupName));
  }
});
