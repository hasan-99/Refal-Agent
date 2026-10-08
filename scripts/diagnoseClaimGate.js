#!/usr/bin/env node
"use strict";

// Diagnostic helper for P0.2 / W0.2.1. For a conflicting sentence it reports the
// exact trigger term, so CONFLICT-REGISTER.md cites a real cause not a guess.
//
// Usage: node scripts/diagnoseClaimGate.js "<sentence>"
//        node scripts/diagnoseClaimGate.js --all

const { containsProhibitedClaim, restrictedRefalcoReply } = require("../src/refalcoAnswer");
const { MB_CANDIDATES, LANGUAGES } = require("../src/brainMbCandidates");

// Candidate trigger terms drawn from the two live regexes in src/refalcoAnswer.js.
// Each is tested in isolation so the report names the precise offending token.
const TRIGGERS = [
  "investment returns", "investment return", "investment advice", "financial advice",
  "roi", "irr", "yield", "legally registered", "registration number", "company number",
  "legal status", "legal entity", "legal advice", "tax advice", "immigration advice",
  "visa", "residency", "bank approval", "loan approval", "mortgage approval",
  "permit", "permits", "licence", "license", "government approval", "company status",
  "returns", "profit guarantee", "registered",
  "عوائد", "عائد", "ربح", "أرباح", "استشارة استثمارية", "السجل التجاري",
  "الوضع القانوني", "كيان قانوني", "استشارة قانونية", "استشارة ضريبية",
  "معدل الضريبة", "نسبة الضريبة", "هجرة", "تأشيرة", "إقامة", "موافقة البنك",
  "قرض", "رهن", "رخصة", "ترخيص", "موافقة حكومية", "مسجل", "مسجلة",
  "επενδυτική συμβουλή", "νομική συμβουλή", "φορολογική συμβουλή", "νομική οντότητα",
  "βίζα", "διαμονή", "έγκριση τράπεζας", "δάνειο", "άδεια", "κρατική έγκριση",
  "εγγεγραμ", "κέρδος", "απόδοση",
];

function triggersIn(sentence) {
  const lower = sentence.toLowerCase();
  return TRIGGERS.filter((t) => lower.includes(t.toLowerCase()));
}

function diagnose(sentence) {
  const prohibited = containsProhibitedClaim(sentence);
  const restricted = restrictedRefalcoReply(sentence);
  return {
    sentence,
    containsProhibitedClaim: prohibited,
    restrictedRefalcoReply: restricted !== null,
    restrictedKind: restricted === null ? null
      : /investment|επενδυτικ|استثمار/iu.test(restricted) ? "investment-branch"
        : /registration|legal-status|εγγραφή|تسجيل/iu.test(restricted) ? "legal-branch"
          : "safety-branch",
    triggerTerms: triggersIn(sentence),
  };
}

function main() {
  const arg = process.argv[2];
  if (arg === "--all") {
    for (const c of MB_CANDIDATES) {
      for (const lang of LANGUAGES) {
        const s = c[lang];
        if (!s) continue;
        const d = diagnose(s);
        const blocked = d.containsProhibitedClaim || d.restrictedRefalcoReply;
        const wanted = c.expect === "pass";
        if (blocked === wanted) {
          process.stdout.write(`${c.id}\t${lang}\t${c.mbRef}\tterms=[${d.triggerTerms.join(", ")}]\tkind=${d.restrictedKind || "-"}\tprohibited=${d.containsProhibitedClaim}\n`);
        }
      }
    }
    return;
  }
  if (!arg) {
    process.stderr.write("usage: node scripts/diagnoseClaimGate.js \"<sentence>\" | --all\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(diagnose(arg), null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { diagnose, triggersIn };
