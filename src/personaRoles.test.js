const assert = require("node:assert/strict");
const { test } = require("node:test");
const { INTENTS } = require("./intent");
const {
  ROLES, MAX_ACTIVE_DIRECTIVES, PERSONA_CORE,
  selectRoles, detectRegister, personaDirectives
} = require("./personaRoles");

test("all ten master-brain roles are present with distinct ids and one directive each", () => {
  assert.equal(ROLES.length, 10);
  assert.deepEqual(
    ROLES.map((role) => role.id).sort(),
    ["MB-R1", "MB-R10", "MB-R2", "MB-R3", "MB-R4", "MB-R5", "MB-R6", "MB-R7", "MB-R8", "MB-R9"]
  );
  for (const role of ROLES) {
    assert.ok(role.directive.trim().length > 20, `${role.id} needs a real directive`);
    assert.ok(role.intents.length > 0, `${role.id} needs at least one trigger intent`);
    assert.ok(role.intents.every(Boolean), `${role.id} references an undefined intent`);
  }
});

test("every role trigger is a real intent, so a renamed intent cannot silently orphan a role", () => {
  const known = new Set(Object.values(INTENTS));
  for (const role of ROLES) {
    for (const intent of role.intents) {
      assert.ok(known.has(intent), `${role.id} triggers on unknown intent: ${intent}`);
    }
  }
});

test("at most two role directives reach the prompt, however many roles are active", () => {
  // Deliberately activate many roles at once.
  const intents = [
    INTENTS.PRICING, INTENTS.COMPANY_FORMATION, INTENTS.INVESTMENT,
    INTENTS.REAL_ESTATE, INTENTS.APPOINTMENT, INTENTS.COMPLAINT, INTENTS.LEGAL
  ];
  const active = selectRoles(intents);
  assert.ok(active.length > MAX_ACTIVE_DIRECTIVES, "test needs more active roles than the cap");

  const result = personaDirectives({ intents, message: "Hello", language: "english" });
  assert.equal(result.roles.length, MAX_ACTIVE_DIRECTIVES);
  assert.ok(result.suppressedRoles.length > 0);
  // Nothing is lost silently: a suppressed role is still reported.
  assert.equal(result.roles.length + result.suppressedRoles.length, active.length);
});

test("a complaint outranks every commercial role", () => {
  // MB is explicit that a complaint is handled, not sold into. If the cap ever
  // let a cross-sell directive outrank service recovery, REFAL would answer an
  // angry customer with an offer.
  const result = personaDirectives({
    intents: [INTENTS.COMPLAINT, INTENTS.PRICING, INTENTS.BUSINESS_PROPOSAL, INTENTS.INVESTMENT],
    message: "I am unhappy with how my case was handled.",
    language: "english"
  });
  assert.equal(result.roles[0], "MB-R8");
  assert.ok(!result.roles.includes("MB-R1"), "business development must not outrank service recovery");
});

test("the persona core is authored in all three languages, not translated placeholders", () => {
  assert.deepEqual(Object.keys(PERSONA_CORE).sort(), ["arabic", "english", "greek"]);
  for (const [language, text] of Object.entries(PERSONA_CORE)) {
    assert.ok(text.trim().length > 40, `${language} persona core is too thin`);
  }
  assert.match(PERSONA_CORE.arabic, /[؀-ۿ]/u);
  assert.match(PERSONA_CORE.greek, /[Ͱ-Ͽ]/u);
  // The English core must not leak into the other two.
  assert.doesNotMatch(PERSONA_CORE.arabic, /cheerful/i);
  assert.doesNotMatch(PERSONA_CORE.greek, /cheerful/i);
});

test("the persona core is selected by language and falls back to English", () => {
  assert.equal(personaDirectives({ language: "arabic" }).lines[0], PERSONA_CORE.arabic);
  assert.equal(personaDirectives({ language: "greek" }).lines[0], PERSONA_CORE.greek);
  assert.equal(personaDirectives({ language: "klingon" }).lines[0], PERSONA_CORE.english);
});

test("register is read from how the message is written", () => {
  assert.equal(detectRegister("hey, wanna know about company setup?"), "casual");
  assert.equal(detectRegister("شو الأسعار؟"), "casual");
  assert.equal(detectRegister("As CFO, I am writing on behalf of our group regarding a corporate restructuring."), "executive");
  assert.equal(detectRegister("We are considering a €4 million development."), "executive");
  assert.equal(detectRegister(""), "neutral");
});

test("register NEVER varies by language, nationality or name — only by how the message is written", () => {
  // CX 8A fairness rule. The same enquiry, written the same way, must get the
  // same register in every language. If this ever fails, REFAL is treating
  // customers differently based on a protected characteristic.
  const equivalents = [
    "As CEO, I am writing on behalf of our group regarding a corporate restructuring project.",
    "بصفتي الرئيس التنفيذي، أكتب نيابة عن مجموعتنا بخصوص مشروع إعادة هيكلة.",
    "Ως διευθύνων σύμβουλος, γράφω εκ μέρους της εταιρείας μας για ένα έργο αναδιάρθρωσης."
  ];
  const registers = equivalents.map(detectRegister);
  assert.deepEqual(registers, ["executive", "executive", "executive"], "register diverged across languages");

  // And the signature itself refuses identity input: detectRegister takes only
  // the message, so there is no parameter through which a name or nationality
  // could reach it.
  assert.equal(detectRegister.length, 1);
});

test("non-Latin marker branches are reachable, not dead \\b-guarded code", () => {
  // JavaScript's \b is ASCII-only even under /u, so wrapping Arabic or Greek
  // alternatives in \b makes them unmatchable. That exact bug shipped once in
  // followUp.js. These assertions fail loudly if it is reintroduced here.
  const { hasExecutiveMarker, hasCasualMarker } = require("./personaRoles");
  assert.equal(hasExecutiveMarker("نيابة عن مجموعتنا"), true, "Arabic executive marker is unreachable");
  assert.equal(hasExecutiveMarker("εκ μέρους της εταιρείας μας"), true, "Greek executive marker is unreachable");
  assert.equal(hasCasualMarker("شو الأخبار"), true, "Arabic casual marker is unreachable");
  assert.equal(hasCasualMarker("τι λέει"), true, "Greek casual marker is unreachable");
});

test("an unknown or empty intent list yields persona only, with no role directives", () => {
  const result = personaDirectives({ intents: [INTENTS.UNKNOWN], message: "", language: "english" });
  assert.equal(result.roles.length, 0);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0], PERSONA_CORE.english);
});

test("the silent scoring engine is never exposed to the customer", () => {
  const qualification = ROLES.find((role) => role.id === "MB-R3");
  assert.match(qualification.directive, /silently/i);
  assert.match(qualification.directive, /[Nn]ever state, imply, or hint/);
});
