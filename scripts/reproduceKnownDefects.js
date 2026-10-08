#!/usr/bin/env node
"use strict";

// P0.3 — reproduce the 13 known defects from the CX production history.
//
// Each defect is executed, not reasoned about. The script reports one of:
//   REPRODUCED      the defect still happens on this code
//   ALREADY-FIXED   the defect does not happen, with the guard that prevents it
//   NOT-TESTABLE    needs live Supabase / corpus / model, which this harness
//                   deliberately does not touch (BOSS protocol, 2026-10-08)
//
// Usage: node scripts/reproduceKnownDefects.js [--json]
// Exit: 0 always. This is an observation harness, not a gate; the gate is the
//       release checklist in P14.5, which requires FIX-1/9/10/12 green.

const { detectIntents, INTENTS } = require("../src/intent");
const { classifySafety } = require("../src/safetyPolicy");
const { containsProhibitedClaim, restrictedRefalcoReply } = require("../src/refalcoAnswer");

const results = [];
function record(fix, defect, status, evidence, repairedBy) {
  results.push({ fix, defect, status, evidence, repairedBy });
}

// ---------------------------------------------------------------- in-memory store
function memoryStore(initialUser) {
  const users = new Map([["u1", JSON.parse(JSON.stringify(initialUser))]]);
  return {
    async ensureUser(id) {
      if (!users.has(id)) users.set(id, { profile: {} });
      return users.get(id);
    },
    async updateUser(id, mutate) {
      const draft = users.get(id) || { profile: {} };
      mutate(draft);
      users.set(id, draft);
      return draft;
    },
    _get: (id) => users.get(id),
  };
}

// ------------------------------------------------------------------------ FIX-1
// Programme facts deleted by the claim gate. Already measured in W0.2.1.
function fix1() {
  const facts = [
    ["MB-F30 PR investment", "The minimum qualifying investment for permanent residency is 300,000 euro plus VAT where applicable."],
    ["MB-F19 corporate tax ar", "ضريبة الشركات الأساسية في قبرص تبدأ من 15% اعتباراً من سنة 2026."],
    ["MB-F45 property VAT", "Reduced VAT of 5% can apply to a first permanent residence, subject to the current conditions."],
  ];
  const blocked = facts.filter(([, s]) => containsProhibitedClaim(s) || restrictedRefalcoReply(s) !== null);
  record("FIX-1", "Programme facts deleted by the claim gate",
    blocked.length ? "REPRODUCED" : "ALREADY-FIXED",
    `${blocked.length}/${facts.length} approved MB facts blocked: ${blocked.map(([n]) => n).join(" · ")}. Full sweep: 27/66 (40.9%) in CONFLICT-REGISTER.md.`,
    "P2.2");
}

// ------------------------------------------------------------------------ FIX-5
// Formation vs investment misclassification: should be BOTH.
function fix5() {
  const s = "بدي أسجل شركة استثمارية";
  const intents = detectIntents(s);
  const both = intents.includes(INTENTS.COMPANY_FORMATION) && intents.includes(INTENTS.INVESTMENT);
  record("FIX-5", "Formation vs investment misclassification",
    both ? "ALREADY-FIXED" : "REPRODUCED",
    `"${s}" -> [${intents.join(", ")}]${both ? " — both intents present, detectIntents is multi-label" : " — missing one of the two"}`,
    "P1.2");
}

// ------------------------------------------------------------------------ FIX-6
// Levantine colloquial formation not matched.
function fix6() {
  const phrasings = [
    "بدي افتح شركة",
    "شو بدي عشان افتح شركة بقبرص",
    "بدي اسس شركة",
    "كيف بفتح شركة؟",
    "حابب اعمل شركة بقبرص",
  ];
  const missed = phrasings.filter((p) => !detectIntents(p).includes(INTENTS.COMPANY_FORMATION));
  record("FIX-6", "Levantine colloquial formation not matched",
    missed.length ? "REPRODUCED" : "ALREADY-FIXED",
    `${missed.length}/${phrasings.length} colloquial phrasings return no company_formation intent: ${missed.map((m) => `"${m}"`).join(" · ")}`,
    "P3.1, P10.1");
}

// ----------------------------------------------------------------------- FIX-13
// Agent identity question. Intent detection vs the answer are separate failures.
function fix13() {
  const qs = [["ar", "من أنت؟"], ["en", "what are you?"], ["el", "Ποιος είσαι;"]];
  const missed = qs.filter(([, q]) => !detectIntents(q).includes(INTENTS.AGENT_IDENTITY));
  record("FIX-13", "Agent identity question answered wrongly",
    missed.length ? "REPRODUCED" : "ALREADY-FIXED (detection only)",
    missed.length
      ? `agent_identity intent missed in: ${missed.map(([l]) => l).join(", ")}`
      : "agent_identity detected in ar/en/el. The defect is NOT detection — it is the answer, which still says \"the business\" (BLK-3 / CR-009, 222 occurrences). Detection repro is green; answer repro needs P1.1.",
    "P1.1, P1.2");
}

// ------------------------------------------------- Arabic orthography (new find)
function orthography() {
  const pairs = [["الإقامة الدائمة", "الاقامة الدائمة"], ["تأسيس شركة", "تاسيس شركة"]];
  const divergent = pairs.filter(([a, b]) => {
    const ra = JSON.stringify([detectIntents(a), classifySafety(a).risks]);
    const rb = JSON.stringify([detectIntents(b), classifySafety(b).risks]);
    return ra !== rb;
  });
  record("NEW", "Arabic orthographic variants change intent AND safety outcome",
    divergent.length ? "REPRODUCED" : "ALREADY-FIXED",
    divergent.map(([a, b]) => `"${a}" -> intents=[${detectIntents(a)}] safety=[${classifySafety(a).risks}] BUT "${b}" -> intents=[${detectIntents(b)}] safety=[${classifySafety(b).risks}]`).join(" || "),
    "P2.2 (BLK-16)");
}

// ------------------------------------------------------------------ FIX-3, FIX-4
// Booking draft must not block Q&A, and must not resume after abandonment.
async function bookingDefects() {
  const { handleBookingMessage } = require("../src/booking");
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const now = new Date();

  // FIX-3: a pending booking draft must not swallow an unrelated question.
  const store3 = memoryStore({
    profile: { name: "Omar" },
    booking: { status: "awaiting_details", startedAt: new Date(Date.now() - 60 * 1000).toISOString() },
  });
  const r3 = await handleBookingMessage({
    userId: "u1", text: "How much does company formation cost?", store: store3, now,
  });
  record("FIX-3", "Q&A blocked while a booking is pending",
    r3 === null ? "ALREADY-FIXED" : "REPRODUCED",
    r3 === null
      ? "handleBookingMessage returned null for an unrelated question while status=awaiting_details, so the router falls through to normal Q&A (booking.js:532)."
      : `booking handler hijacked the question and replied: "${String(r3.response).slice(0, 90)}"`,
    "P7.4");

  // FIX-4: a draft abandoned 2h ago must not resume on a new, unrelated topic.
  const store4 = memoryStore({
    profile: { name: "Omar" },
    booking: { status: "awaiting_details", startedAt: hourAgo },
  });
  await handleBookingMessage({ userId: "u1", text: "Tell me about Non Dom status", store: store4, now });
  const after = store4._get("u1");
  record("FIX-4", "A new message resumes an abandoned booking",
    after.booking === null ? "ALREADY-FIXED" : "REPRODUCED",
    after.booking === null
      ? "A draft idle for 2h was cleared on the next message; drafts expire after 60 minutes (booking.js:520-529)."
      : `stale draft survived: ${JSON.stringify(after.booking)}`,
    "P7.4");
}

// ------------------------------------------------------------------------ FIX-2
// A greeting saved as the customer's name. extractCustomerName is a pure,
// exported function, so this needs no store after all.
function fix2() {
  const { extractCustomerName, isPlausibleCustomerName } = require("../src/messageRouter");
  const greetings = ["مرحبا", "السلام عليكم", "hello", "hi there", "Γεια σας", "صباح الخير", "شكرا"];
  const captured = greetings.filter((g) => {
    const n = extractCustomerName(g);
    return n && isPlausibleCustomerName(n);
  });
  // Control: a real name must still be captured, or the guard is simply "never extract".
  const realNames = [["اسمي عمر", "عمر"], ["my name is Omar", "Omar"]];
  const missedReal = realNames.filter(([input, expected]) => extractCustomerName(input) !== expected);

  record("FIX-2", "A greeting saved as the customer's name",
    captured.length ? "REPRODUCED" : "ALREADY-FIXED",
    captured.length
      ? `greetings captured as names: ${captured.join(" · ")}`
      : `0/${greetings.length} greetings captured as a name across ar/en/el, and ${realNames.length - missedReal.length}/${realNames.length} real names still extracted correctly (so the guard is selective, not a blanket refusal).`,
    "P8.2");
}

// ------------------------------------------------------- DB / corpus / model gated
function notTestableHere() {
  const gated = [
    ["FIX-7", "Arabic retrieval returns zero for services and pricing", "live Supabase corpus + embeddings", "P3.10"],
    ["FIX-8", "Greek coverage gaps", "live Supabase corpus per domain", "P3.1-P3.8"],
    ["FIX-9", "Handover notification lost, badge mismatch", "live store + dashboard counts", "P6.5, P12.3"],
    ["FIX-10", "Output leaks: internal reasoning, retrieval fallback text", "live model round trip (adversarial, 3 languages)", "P11.2"],
    ["FIX-11", "Specialist offer not persisted, so it repeats", "live store across turns", "P5.4"],
    ["FIX-12", "Phone metadata treated as consent", "live store consent source field", "P9.1"],
  ];
  for (const [fix, defect, needs, repairedBy] of gated) {
    record(fix, defect, "NOT-TESTABLE", `Requires ${needs}. Not run; no live DB from the agent session per BOSS protocol 2026-10-08.`, repairedBy);
  }
}

async function main() {
  fix1(); fix2(); fix5(); fix6(); fix13(); orthography();
  await bookingDefects();
  notTestableHere();

  if (process.argv[2] === "--json") {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  const order = { REPRODUCED: 0, "ALREADY-FIXED": 1, "ALREADY-FIXED (detection only)": 1, "NOT-TESTABLE": 2 };
  results.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  process.stdout.write("P0.3 — known defect reproduction\n");
  process.stdout.write(`${"=".repeat(72)}\n`);
  for (const r of results) {
    process.stdout.write(`\n[${r.status}] ${r.fix} — ${r.defect}\n  repaired by: ${r.repairedBy}\n  evidence: ${r.evidence}\n`);
  }
  const counts = results.reduce((acc, r) => { const k = r.status.startsWith("ALREADY") ? "ALREADY-FIXED" : r.status; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  process.stdout.write(`\n${"=".repeat(72)}\nSummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}\n`);
}

if (require.main === module) main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });

module.exports = { main, results };
