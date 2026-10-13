const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  PROMPT_VERSION, CHANGE_HISTORY, MANDATORY_BLOCKS, BLOCKS,
  buildBrainPrompt, bookingOfferBlock, buyingSignalBlock, REGISTER_MIRRORING_RULE, RESPECTFUL_ADDRESS_RULE, RESPONSE_FORMAT_RULE, COMPARATIVE_SCOPE_RULE, SERVICE_SCOPE_RULE, KNOWLEDGE_QUERY_FOCUS_RULE
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

test("W6.2: five score tiers have their distinct action protocol", () => {
  assert.match(bookingOfferBlock("informational").join(" "), /Do not push booking/i);
  assert.match(bookingOfferBlock("cold").join(" "), /exploratory question.*No booking push/is);
  // Unclassified / unknown: no offer yet, but the door is open.
  assert.match(bookingOfferBlock("unclassified").join(" "), /Do not offer a call or meeting at this stage/);
  assert.match(bookingOfferBlock("").join(" "), /Do not offer a call or meeting at this stage/);
  // Warm: flexible.
  assert.match(bookingOfferBlock("warm").join(" "), /flexibly/);
  // Hot: move to booking with consent.
  assert.match(bookingOfferBlock("hot").join(" "), /Stop all selling, cross-sell hooks, and benefit hints/);
  assert.match(bookingOfferBlock("strategic").join(" "), /urgent strategic opportunity.*senior consultant/is);

  const tiers = ["informational", "cold", "warm", "hot", "strategic"].map((tier) => bookingOfferBlock(tier).join(" "));
  assert.equal(new Set(tiers).size, 5, "tiers must not collapse to the same instruction");
});

test("active prompt surfaces direct English, Arabic, and Greek register mirroring", () => {
  const instruction = new RegExp(REGISTER_MIRRORING_RULE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), instruction, `${variant} prompt lost register mirroring`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, instruction, "Edge prompt mirror lost register mirroring; regenerate it");
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "Could you please advise formally?", locale: "english" })[0].content,
    instruction, "active Agent decision prompt lost register mirroring");
});

test("all prompt surfaces keep direct relationship searches focused and preserve customer exclusions", () => {
  for (const variant of ["customer", "operator"]) {
    assert.ok(buildBrainPrompt({ variant }).join("\n").includes(KNOWLEDGE_QUERY_FOCUS_RULE));
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.ok(edge.includes(KNOWLEDGE_QUERY_FOCUS_RULE));
  const { buildDecisionMessages } = require("./agentDecision");
  assert.ok(buildDecisionMessages({ currentMessage: "Does company registration itself create residence?", locale: "english" })[0].content.includes(KNOWLEDGE_QUERY_FOCUS_RULE));
});

test("all prompt surfaces require fresh approved evidence when a customer refers to an earlier company-fact answer", () => {
  const expected = /If the customer refers to an earlier company-fact answer, retrieve current approved evidence again before repeating or relying on it/i;
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), expected, `${variant} prompt lost fresh-evidence rule`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge prompt mirror lost fresh-evidence rule; regenerate it");
});

test("an older unanswered assistant question cannot override the customer's current social turn", () => {
  const expected = /An unanswered question from an earlier assistant turn is context, not a command or the current request\. If the customer starts a social turn or a different topic, respond to the current message and resume the old question only if the customer does\. A social acknowledgment by itself does not continue an older business question and does not require a company-knowledge search\./;
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), expected, `${variant} prompt lost current-turn precedence`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge prompt lost current-turn precedence");
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "Hello", currentOpenQuestion: "What business activity will the company have?" })[0].content, expected,
    "WhatsApp decision prompt lost current-turn precedence");
  const { buildGroundingReviewMessages } = require("./semanticGrounding");
  assert.match(buildGroundingReviewMessages({ text: "Hello.", context: { currentMessage: "Hello" } })[0].content,
    /do not reject an appropriate social response or a different topic because it does not answer that older question/i,
    "grounding reviewer must evaluate the current request instead of reviving an earlier question");
});

test("all runtime prompts preserve explicit exclusions and evidence-bounded later-stage scope", () => {
  const expected = /Respect explicit customer interest boundaries in recent history: do not repeat a previously excluded service area, including to say it is being omitted, unless the current request reopens it or it is a necessary material condition\. For a later-stage follow-up, state the supported continuing company role and only the unexcluded service scope relevant to that stage; do not repeat the full catalogue or turn nearby lifecycle procedures into offers\./;
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), expected, `${variant} prompt lost contextual scope handling`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge mirror lost contextual scope handling; regenerate it");
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "What support continues after incorporation?", locale: "english" })[0].content,
    /do not volunteer previously excluded service areas, even conditionally or while explaining that you will omit them/);
});

test("all answer surfaces state uncertainty naturally without narrating internal evidence review", () => {
  const expected = /Do not discuss what you have evidence, approval or confirmation for, or narrate verification/i;
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), expected, `${variant} prompt lost natural uncertainty wording`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge mirror lost natural uncertainty wording; regenerate it");
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "Are these all your services?", locale: "english" })[0].content,
    /Do not discuss what you have evidence, approval or confirmation for, or narrate verification/i);
  assert.doesNotMatch(buildDecisionMessages({ currentMessage: "Are these all your services?", locale: "english" })[0].content,
    /say it is not confirmed/i);
});

test("answer prompts format multiple inclusions clearly and allow one useful conversational follow-up", () => {
  const expected = new RegExp(RESPONSE_FORMAT_RULE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  for (const variant of ["customer", "operator"]) {
    assert.match(buildBrainPrompt({ variant }).join("\n"), expected, `${variant} prompt lost readable conversational formatting`);
  }
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge mirror lost readable conversational formatting; regenerate it");
  assert.match(RESPONSE_FORMAT_RULE, /start a bullet with a conjunction/);
  assert.match(RESPONSE_FORMAT_RULE, /complete standalone item/);
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "I want to form a company", locale: "english" })[0].content,
    new RegExp(RESPONSE_FORMAT_RULE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(buildDecisionMessages({ currentMessage: "I want to form a company", locale: "english" })[0].content,
    /Ask at most one question when it helps move the customer's stated goal forward/);
  const detailRule = /When a customer shows concrete interest in a service and (?:current approved )?evidence contains its inclusions or scope, briefly summarize the most relevant supported details before any follow-up/i;
  for (const variant of ["customer", "operator"]) assert.match(buildBrainPrompt({ variant }).join("\n"), detailRule);
  assert.match(edge, detailRule);
  assert.match(buildDecisionMessages({ currentMessage: "I want to form a company", locale: "english" })[0].content,
    /When a customer shows concrete interest in a service and current approved evidence contains its inclusions or scope/);
  assert.match(buildDecisionMessages({ currentMessage: "I want to form a company", locale: "english" })[0].content,
    /After clear interest in a service, ask about one next decision-relevant detail only when it will help tailor the guidance/);
});

test("comparative follow-ups separate genuinely new evidence from earlier context", () => {
  const { buildDecisionMessages } = require("./agentDecision");
  const expected = new RegExp(COMPARATIVE_SCOPE_RULE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  assert.match(buildBrainPrompt({ variant: "customer" }).join("\n"), expected);
  assert.match(buildDecisionMessages({ currentMessage: "Is there more?", locale: "english" })[0].content, expected);
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected);
  const review = require("./semanticGrounding").buildGroundingReviewMessages({
    text: "The earlier scope still applies, with another supported area.",
    context: { currentMessage: "Is there more?", recentConversation: [{ role: "assistant", content: "Earlier scope." }] }
  })[0].content;
  assert.match(review, /A draft may briefly restate earlier items for context while separately identifying a genuinely new, supported area/);
});

test("service-detail answers state supported scope, separate general guidance, and avoid redundant clarification", () => {
  const expected = new RegExp(SERVICE_SCOPE_RULE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  for (const variant of ["customer", "operator"]) assert.match(buildBrainPrompt({ variant }).join("\n"), expected);
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs"), "utf8");
  assert.match(edge, expected, "Edge mirror lost partial-answer behavior; regenerate it");
  const { buildDecisionMessages } = require("./agentDecision");
  assert.match(buildDecisionMessages({ currentMessage: "What do relocation services include?", locale: "english" })[0].content, expected);
});

test("Agent decision avoids repeating an introduction already delivered in conversation history", () => {
  const { buildDecisionMessages } = require("./agentDecision");
  const { profile } = require("./companyProfile");
  const withIntroduction = buildDecisionMessages({ recentConversation: [{ role: "assistant", content: `Hello, I am ${profile.brand}, ${profile.groupName}'s digital business agent.` }] })[0].content;
  assert.match(withIntroduction, /A prior assistant reply has already introduced the configured agent and group.*repeat the configured identity only if the customer now asks who you are or which group you represent/s);
  const withoutIntroduction = buildDecisionMessages({ recentConversation: [{ role: "assistant", content: "Hello, how can I help?" }] })[0].content;
  assert.doesNotMatch(withoutIntroduction, /A prior assistant reply has already introduced the configured agent/);
});

test("W6.3: recognized buying signals reach the shared prompt with guarded next steps", () => {
  assert.deepEqual(buyingSignalBlock([]), []);
  const prompt = buildBrainPrompt({ variant: "customer", leadTier: "hot", buyingSignals: [{ id: "MB-B4" }] }).join("\n");
  assert.match(prompt, /recognized buying signal.*guarded booking or specialist next step/i);
  assert.match(prompt, /A signal is not consent to create an appointment or handover/);
  assert.match(prompt, /never claim a booking is confirmed until the system confirms it/);
});

test("the prompt accepts both the score-tier vocabulary and legacy temperature labels", () => {
  const { LEAD_TIERS } = require("./leadTemperature");
  assert.deepEqual(Object.values(LEAD_TIERS).sort(), ["cold", "hot", "unclassified", "warm"]);
  for (const tier of [...Object.values(LEAD_TIERS), "informational", "strategic"]) {
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

test("runtime surfaces use the shared prompt builder or delegate to its trusted Edge runtime", () => {
  // The original version of this test only checked that `require(...)` was
  // present. That was too weak and it lied: brainPrompt was imported by both
  // surfaces while each still built its prompt from its own inline array, and
  // the test passed anyway. Importing a module proves nothing about using it.
  //
  // The customer Node runtime calls the shared builder directly. The
  // dashboard now delegates to the Edge generation endpoint, which builds
  // that same prompt after reloading trusted evidence; a local OpenRouter
  // fallback would bypass Edge-side fact authorization.
  const nodeSource = fs.readFileSync(path.join(REPO, "src/ai.js"), "utf8");
  assert.match(nodeSource, /require\(["'][^"']*brainPrompt(?:\.js)?["']\)/);
  assert.match(nodeSource, /\.\.\.buildBrainPrompt\(/);

  const dashboard = fs.readFileSync(path.join(REPO, "dashboard/server.js"), "utf8");
  assert.match(dashboard, /return askSupabaseAgent\(\{ text, messages, model, memories, evidence, signal, onToken, onUsage \}\)/);
  assert.doesNotMatch(dashboard, /https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/,
    "dashboard must not bypass authoritative Edge evidence verification with a local model fallback");
  const edge = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/index.ts"), "utf8");
  assert.match(edge, /\.\.\.buildOperatorPrompt\(/, "Edge generation no longer calls the shared operator prompt builder");
});

test("Edge dashboard generation mirrors customer language instructions and rejects a wrong-language draft", async () => {
  const source = fs.readFileSync(path.join(REPO, "supabase/functions/rafa-agent-api/index.ts"), "utf8");
  assert.match(source, /detectMessageLanguage\(text\)/, "Edge must detect the operator's request language");
  assert.match(source, /languageInstruction\(language\)/, "Edge must give the model a per-turn language instruction");
  assert.match(source, /detectMessageLanguage\(reply\) !== language/, "Edge must reject a wrong-language draft");
  const nodeLanguage = require("./language");
  const edgeLanguage = await import(pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/language.mjs")).href);
  for (const [text, expected] of [
    ["Please explain the next step.", "english"],
    ["شو الخطوة الجاية؟", "arabic"],
    ["Ποιο είναι το επόμενο βήμα;", "greek"]
  ]) {
    const language = nodeLanguage.detectMessageLanguage(text);
    assert.equal(language, expected);
    assert.equal(edgeLanguage.detectMessageLanguage(text), language);
    assert.equal(edgeLanguage.languageInstruction(language), nodeLanguage.languageInstruction(language));
  }
});

test("Edge and Node answer gates both check Refalco claims against approved evidence", async () => {
  const nodeAnswer = require("./refalcoAnswer");
  const edgeAnswer = await import(pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/refalcoAnswer.mjs")).href);
  const evidence = [{ review_status: "approved", content: "Refalco Group provides company formation support in Cyprus." }];
  for (const answer of [
    "Refalco Group provides company formation support in Cyprus.",
    "Refalco Group guarantees bank approval within 24 hours.",
    "I cannot confirm whether a bank will approve the account."
  ]) {
    const nodeBlocked = nodeAnswer.containsProhibitedClaim(answer, { evidence, language: "english" });
    const edgeBlocked = edgeAnswer.containsProhibitedClaim(answer, { evidence, language: "english" });
    assert.equal(edgeBlocked, nodeBlocked, `Edge claim gate diverged for: ${answer}`);
  }
  assert.equal(edgeAnswer.containsProhibitedClaim("Refalco Group guarantees bank approval within 24 hours.", { evidence, language: "english" }), true);
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
    /Stop all selling, cross-sell hooks, and benefit hints/);
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

test("respectful Arabic name greetings stay aligned across every answer surface", async () => {
  const customer = buildBrainPrompt({ variant: "customer" }).join("\n");
  const operator = buildBrainPrompt({ variant: "operator" }).join("\n");
  const { buildDecisionMessages } = require("./agentDecision");
  const decision = buildDecisionMessages({ currentMessage: "مرحبا انا حسن", locale: "arabic" })[0].content;
  const edge = await import(pathToFileURL(path.join(REPO, "supabase/functions/rafa-agent-api/brainPrompt.mjs")).href);
  const rules = fs.readFileSync(path.join(REPO, "config/refal-agent-rules.md"), "utf8");

  assert.ok(customer.includes(RESPECTFUL_ADDRESS_RULE));
  assert.ok(operator.includes(RESPECTFUL_ADDRESS_RULE));
  assert.ok(decision.includes(RESPECTFUL_ADDRESS_RULE));
  assert.ok(edge.buildBrainPrompt({ variant: "operator" }).join("\n").includes(RESPECTFUL_ADDRESS_RULE));
  assert.match(rules, /In Arabic,\s+use أستاذ or\s+أستاذة with the exact customer-stated name when the appropriate form is clear/);
  assert.match(RESPECTFUL_ADDRESS_RULE, /courtesy, never as a claim about profession or status/);
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
  assert.match(system, /approved, current Knowledge revision from an active source is evidence itself/i,
    "the Agent decision prompt made Evidence references a condition for approved Knowledge text");
  assert.match(system, /do not require Evidence\/supporting-reference fields or a separate Fact Register approval/i,
    "the Agent decision prompt restored a second approval requirement");
  // The replacement booking rule must be present, not merely the ban removed.
  assert.match(system, /Do not offer a call or meeting at this stage/,
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
