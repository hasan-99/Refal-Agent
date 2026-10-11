"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { selectSalesHook } = require("./salesHooks");

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
function evidence(topic, content = "Approved programme facts.", valid_until = "2026-12-01T00:00:00.000Z") {
  return [{ topic, review_status: "approved", valid_until, content }];
}
function relocationEvidence() {
  return [
    ["relocation-checklist", "International schools are part of the relocation information."],
    ["non-dom-status", "Non Dom status may apply for 17 years."],
    ["gesy", "GESY is Cyprus healthcare information."]
  ].map(([topic, content]) => ({ topic, review_status: "approved", valid_until: "2026-12-01T00:00:00.000Z", content }));
}
function select(message, topic, extras = {}) {
  return selectSalesHook({
    message, language: "english", humourLevel: 1, answer: "Here is the answer.", questionAnswered: true,
    evidence: evidence(topic, extras.content), now: NOW, ...extras
  });
}

test("H1 IP Box recognizes software triggers in Arabic, English, Greek, Arabizi and Greeklish", () => {
  const cases = [
    ["Our SaaS app is in software development", "english"],
    ["نشاطي برمجيات وتطبيقات", "arabic"],
    ["Η εταιρεία αναπτύσσει λογισμικό και εφαρμογές", "greek"],
    ["shoghle barmeje w software", "arabic"],
    ["ftiaxno efarmogi kai logismiko", "greek"]
  ];
  for (const [message, language] of cases) {
    const result = selectSalesHook({ message, language, humourLevel: 1, answer: "answered", questionAnswered: true,
      evidence: evidence("ip-box", "IP Box is not automatic for every company."), now: NOW });
    assert.equal(result?.id, "H1_IP_BOX", message);
    const localizedMarker = language === "arabic" ? /النظام مو تلقائي/u
      : language === "greek" ? /Δεν εφαρμόζεται αυτόματα/u : /not automatic/u;
    assert.match(result.phrase, localizedMarker);
  }
});

test("H2 residency, H3 relocation, H4 substance, H5 trademark, and H6 property triggers select at most one grounded hook", () => {
  assert.equal(select("I am non-EU and have a budget of €300,000", "permanent-residency")?.id, "H2_RESIDENCY");
  assert.equal(select("عندي عيلة وعم فكر بالمدارس والسكن", "relocation-checklist", { humourLevel: 1, evidence: relocationEvidence() })?.id, "H3_RELOCATION");
  assert.equal(select("Thelo na metakomiso kai na doulevo pragmatika apo Kypro", "office-services")?.id, "H4_SUBSTANCE");
  assert.equal(select("We run a dev team", "ip-box", { content: "IP Box is not automatic for every company." })?.id, "H1_IP_BOX");
  assert.equal(select("Έχω νέο brand και προϊόν", "trademark")?.id, "H5_TRADEMARK");
  assert.equal(select("I want permanent residency and a clear investment option", "property-categories")?.id, "H6_PR_TO_PROPERTY");
  assert.doesNotMatch(select("I want permanent residency and a clear investment option", "property-categories").phrase, /guaranteed|εγγυη|مضمون/iu);
});

test("the remaining hooks recognize Arabic, Greek, Arabizi and Greeklish forms", () => {
  const cases = [
    ["أنا من خارج الاتحاد الأوروبي وميزانيتي 300,000 يورو", "permanent-residency", "H2_RESIDENCY"],
    ["Είμαι εκτός Ευρωπαϊκής Ένωσης και έχω προϋπολογισμό 300.000 ευρώ", "permanent-residency", "H2_RESIDENCY"],
    ["oikogeneia kai metakomizo stin Kypro", "relocation-checklist", "H3_RELOCATION"],
    ["Η οικογένειά μου μετακομίζει στην Κύπρο", "relocation-checklist", "H3_RELOCATION"],
    ["بدنا ننتقل ونشتغل فعلياً من قبرص", "office-services", "H4_SUBSTANCE"],
    ["Έχω νέο brand και προϊόν", "trademark", "H5_TRADEMARK"],
    ["عندي براند ومنتج جديد", "trademark", "H5_TRADEMARK"],
    ["أريد إقامة دائمة وعندي ميزانية وخيار استثمار واضح", "property-categories", "H6_PR_TO_PROPERTY"],
    ["Θέλω μόνιμη διαμονή και έχω προϋπολογισμό για επένδυση", "property-categories", "H6_PR_TO_PROPERTY"]
  ];
  const topics = {
    H2_RESIDENCY: "permanent-residency", H3_RELOCATION: "relocation-checklist",
    H4_SUBSTANCE: "office-services", H5_TRADEMARK: "trademark", H6_PR_TO_PROPERTY: "property-categories"
  };
  for (const [message, topic, expected] of cases) {
    const result = select(message, topic, {
      language: /[\u0600-\u06ff]/u.test(message) ? "arabic" : /[\u0370-\u03ff]/u.test(message) ? "greek" : "english",
      ...(expected === "H3_RELOCATION" ? { evidence: relocationEvidence() } : {})
    });
    assert.equal(result?.id, expected, message);
    assert.equal(topics[result.id], topic);
  }
});

test("H1 fails closed when evidence is missing, unapproved, expired, or has an invalid expiry", () => {
  const base = { message: "Our SaaS software business", language: "english", humourLevel: 1, answer: "answered", questionAnswered: true, now: NOW };
  assert.equal(selectSalesHook({ ...base }), null);
  for (const item of [
    { topic: "ip-box", review_status: "pending", valid_until: null, content: "IP Box" },
    { topic: "ip-box", review_status: "approved", valid_until: "2026-10-09T23:59:59Z", content: "IP Box" },
    { topic: "ip-box", review_status: "approved", valid_until: "not a date", content: "IP Box" },
    { topic: "corporate-tax", review_status: "approved", valid_until: null, content: "ordinary tax rate" }
  ]) assert.equal(selectSalesHook({ ...base, evidence: [item] }), null);
  assert.equal(selectSalesHook({ ...base, evidence: evidence("ip-box", "IP Box is not automatic for every company.", null) })?.id, "H1_IP_BOX");
});

test("all hooks require an answered question, humour above zero, and nonsuppressed conversation state", () => {
  const base = { message: "Our SaaS app uses software", language: "english", evidence: evidence("ip-box"), now: NOW };
  for (const options of [
    { questionAnswered: false, answer: "answer" }, { questionAnswered: true, answer: "" },
    { questionAnswered: true, answer: "answer", humourLevel: 0 },
    { questionAnswered: true, answer: "answer", humourLevel: 1, declined: true },
    { questionAnswered: true, answer: "answer", humourLevel: 1, message: "No thanks, no more offers" },
    { questionAnswered: true, answer: "answer", humourLevel: 1, informational: true },
    { questionAnswered: true, answer: "answer", humourLevel: 1, complaint: true },
    { questionAnswered: true, answer: "answer", humourLevel: 1, sensitive: true },
    { questionAnswered: true, answer: "answer", humourLevel: 1, previouslyOfferedHooks: ["H1_IP_BOX"] }
  ]) assert.equal(selectSalesHook({ ...base, ...options }), null);
});

test("H3 only fires at humour levels one or two", () => {
  const base = { message: "Moving with my family and kids", language: "english", answer: "answered", questionAnswered: true,
    evidence: relocationEvidence(), now: NOW };
  assert.equal(selectSalesHook({ ...base, humourLevel: 1 })?.id, "H3_RELOCATION");
  assert.equal(selectSalesHook({ ...base, humourLevel: 2 })?.id, "H3_RELOCATION");
  assert.equal(selectSalesHook({ ...base, humourLevel: 3 }), null);
});

test("Arabic and Greek declines suppress H1 even in code-switched messages", () => {
  const cases = [
    ["لا شكراً، نشاطي SaaS", "arabic"],
    ["مش مهتم، عندي تطبيق", "arabic"],
    ["δεν ενδιαφέρομαι, I build software", "greek"]
  ];
  for (const [message, language] of cases) {
    assert.equal(selectSalesHook({ message, language, humourLevel: 1, answer: "answered", questionAnswered: true,
      evidence: evidence("ip-box", "IP Box is not automatic for every company."), now: NOW }), null, message);
  }
});

test("H2 accepts any budget at or above 300,000, including Arabic-Indic digits", () => {
  for (const amount of ["350000", "350,000", "350.000", "٣٠٠٬٠٠٠", "٣٥٠٠٠٠", "۳۵۰۰۰۰"]) {
    const result = select(`I am non-EU and my budget is ${amount}`, "permanent-residency");
    assert.equal(result?.id, "H2_RESIDENCY", amount);
  }
  assert.equal(select("I am non-EU, ID 350000 and budget €100,000", "permanent-residency"), null);
  assert.equal(select("I am non-EU and my budget is 350k", "permanent-residency")?.id, "H2_RESIDENCY");
  assert.equal(select("I am non-EU and my budget is 350000", "permanent-residency")?.id, "H2_RESIDENCY");
  assert.equal(select("I am non-EU and my budget is 299,999", "permanent-residency"), null);
});

test("H2 does not associate a client ID with a separate below-threshold budget", () => {
  assert.equal(select("I am non-EU, client ID 350000, budget €100000", "permanent-residency"), null);
  assert.equal(select("I am non-EU, client ID 350000, budget €350000", "permanent-residency")?.id, "H2_RESIDENCY");
});

test("H3 names GESY and the 17-year Non Dom programme only when all three current evidence topics exist", () => {
  const message = "Moving with my family and children";
  const result = select(message, "relocation-checklist", { evidence: relocationEvidence() });
  assert.equal(result?.id, "H3_RELOCATION");
  assert.match(result.phrase, /GESY/u);
  assert.match(result.phrase, /17 years/u);
  assert.equal(select(message, "relocation-checklist"), null);
  assert.equal(select(message, "relocation-checklist", { evidence: relocationEvidence().slice(0, 2) }), null);
});
