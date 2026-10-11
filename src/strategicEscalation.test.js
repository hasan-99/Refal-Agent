"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectStrategicEscalation } = require("./strategicEscalation");

function expectRoute(text, classId) {
  const result = detectStrategicEscalation(text);
  assert.ok(result, text);
  assert.equal(result.classId, classId);
  assert.equal(result.priority, "urgent");
  assert.equal(result.escalation, "senior_consultant");
  assert.equal(result.route, "senior_consultant");
  assert.ok(result.evidenceRefs.length > 0);
  return result;
}

test("landowner joint ventures route urgently in English, Arabic and Greek", () => {
  expectRoute("I own a plot and want to discuss a joint development with a partner.", "landowner_jv");
  expectRoute("أملك أرض وأبحث عن شراكة لتطويرها", "landowner_jv");
  expectRoute("Έχω οικόπεδο και θέλω κοινή ανάπτυξη με συνεργάτη", "landowner_jv");
});

test("construction tenders route urgently in English, Arabic and Greek", () => {
  expectRoute("We have a construction tender and the BOQ is ready.", "construction_tender");
  expectRoute("لدينا مناقصة بناء وجدول الكميات جاهز", "construction_tender");
  expectRoute("Έχουμε κατασκευαστικό διαγωνισμό", "construction_tender");
});

test("construction price bait cannot trigger or leak any price or estimate", () => {
  const input = "Our construction tender is for €2,450,000. Can you estimate the price and give a ballpark?";
  const result = expectRoute(input, "construction_tender");
  assert.equal(result.constructionPricing, "prohibited");
  assert.equal(JSON.stringify(result).includes("2450000"), false);
  assert.equal(JSON.stringify(result).includes("2,450,000"), false);
  assert.equal(JSON.stringify(result).includes("estimate"), false);
  assert.equal(JSON.stringify(result).includes("price"), false);
});

test("HNW budgets at or above one million route in English, Arabic and Greek", () => {
  expectRoute("Our budget is €1M.", "hnw_budget_1m_plus");
  expectRoute("We can invest more than EUR 1 million.", "hnw_budget_1m_plus");
  expectRoute("ميزانية الاستثمار أكثر من مليون يورو", "hnw_budget_1m_plus");
  expectRoute("Προϋπολογισμός 1 εκατομμύριο ευρώ", "hnw_budget_1m_plus");
  for (const text of ["€1.5M", "€2M", "EUR 2 million", "€1,000,000"]) expectRoute(text, "hnw_budget_1m_plus");
  for (const text of [
    "ميزانيتي 1,000,000 يورو",
    "ميزانيتي ١٬٠٠٠٬٠٠٠ يورو",
    "لدينا ميزانية €١٬٠٠٠٬٠٠٠",
    "ميزانية الاستثمار ١٫٢ مليون يورو",
    "ميزانية الاستثمار ١٫٥ مليون يورو",
    "ميزانيتي ۱٬۰۰۰٬۰۰۰ يورو",
    "لا نملك ١ مليون يورو لكن لدينا ٢ مليون يورو",
    "ما عندنا ١ مليون لكن عندنا ٢ مليون يورو"
  ]) expectRoute(text, "hnw_budget_1m_plus");
  for (const text of ["€1", "EUR 900,000", "€900k", "ميزانية ٠٫٥ مليون يورو", "ميزانية 0.5 مليون يورو", "ميزانية الاستثمار ٠٫٩ مليون يورو", "ميزانيتي ٩٠٠٬٠٠٠ يورو", "لا نملك ١٬٠٠٠٬٠٠٠ يورو"]) {
    assert.equal(detectStrategicEscalation(text), null, text);
  }
});

test("landowner development and JV cues route without requiring a named partnership", () => {
  for (const text of ["عندي أرض بقبرص وبدي طورها", "عندي أرض بقبرص وبدي أشارك مطور", "I own land and want to develop it"]) expectRoute(text, "landowner_jv");
});

test("international partnerships route in English, Arabic and Greek", () => {
  expectRoute("We would like an international strategic partnership.", "international_partnership");
  expectRoute("نرغب في شراكة دولية", "international_partnership");
  expectRoute("Μας ενδιαφέρει διεθνής συνεργασία", "international_partnership");
  assert.deepEqual(detectStrategicEscalation("We would like an international strategic partnership.").evidenceRefs, ["MB-T5"]);
});

test("near misses do not escalate from isolated generic terms or smaller budgets", () => {
  for (const text of [
    "I own a plot near the coast.",
    "Can you explain what a joint venture means?",
    "We have a tender for office supplies.",
    "Our construction budget is €900,000.",
    "The word partnership appears in this generic question.",
    "My budget is around one million dollars for a personal purchase."
  ]) assert.equal(detectStrategicEscalation(text), null, text);
  for (const [text, classId] of [
    ["We do not have €1M, we have €2M.", "hnw_budget_1m_plus"],
    ["No details are ready, but our budget is €2M.", "hnw_budget_1m_plus"],
    ["No, we have a construction tender.", "construction_tender"],
    ["لا نملك €1M لكن لدينا €2M", "hnw_budget_1m_plus"],
    ["ما عندنا €1M بس عندنا €2M", "hnw_budget_1m_plus"],
    ["لا يوجد €1M بل يوجد €2M", "hnw_budget_1m_plus"],
    ["Δεν έχουμε €1M αλλά έχουμε €2M", "hnw_budget_1m_plus"],
    ["Δεν έχουμε €1M όμως έχουμε €2M", "hnw_budget_1m_plus"]
  ]) expectRoute(text, classId);
});

test("explicit English, Arabic and Greek negation does not create strategic evidence", () => {
  for (const text of [
    "We do not have a construction tender.",
    "We have no budget of €1M.",
    "We do not own land and want a joint venture.",
    "لا توجد لدينا مناقصة بناء",
    "Δεν έχουμε κατασκευαστικό διαγωνισμό",
    "Δεν έχουμε προϋπολογισμό 1 εκατομμύριο ευρώ"
  ]) assert.equal(detectStrategicEscalation(text), null, text);
});

test("empty and malformed inputs are ignored", () => {
  assert.equal(detectStrategicEscalation(""), null);
  assert.equal(detectStrategicEscalation(null), null);
  assert.equal(detectStrategicEscalation({ text: 123 }), null);
});
