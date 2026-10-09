const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  SOURCE_OF_FUNDS,
  SOURCE_OF_WEALTH,
  explainSourceOfFunds,
  explainSourceOfWealth,
  explainBothSeparately,
  requestsSensitiveFinancialDocument
} = require("./sourceOfFundsPolicy");
const { MB_CANDIDATES } = require("./brainMbCandidates");

// P2.5 / W2.5.6 (MB-SEC3).

const LANGUAGES = ["english", "arabic", "greek"];

function candidate(id) {
  const list = Array.isArray(MB_CANDIDATES) ? MB_CANDIDATES : [];
  return list.find((entry) => entry && entry.id === id) || null;
}

test("Source of Funds is explained in all three languages", () => {
  for (const language of LANGUAGES) {
    const text = explainSourceOfFunds(language);
    assert.equal(text, SOURCE_OF_FUNDS[language]);
    assert.ok(text.length > 60, language);
  }
  assert.equal(explainSourceOfFunds("klingon"), SOURCE_OF_FUNDS.english);
  assert.equal(explainSourceOfFunds(), SOURCE_OF_FUNDS.english);
});

test("Source of Wealth is explained separately, and is not the same text", () => {
  for (const language of LANGUAGES) {
    const wealth = explainSourceOfWealth(language);
    assert.equal(wealth, SOURCE_OF_WEALTH[language]);
    assert.notEqual(wealth, SOURCE_OF_FUNDS[language], language);
  }
  assert.equal(explainSourceOfWealth("klingon"), SOURCE_OF_WEALTH.english);
  assert.equal(explainSourceOfWealth(), SOURCE_OF_WEALTH.english);
});

test("the combined explanation keeps the two separate and states the chat boundary", () => {
  for (const language of LANGUAGES) {
    const both = explainBothSeparately(language);
    assert.ok(both.includes(SOURCE_OF_FUNDS[language]), language);
    assert.ok(both.includes(SOURCE_OF_WEALTH[language]), language);
    // Two distinct blocks, not one merged paragraph.
    assert.ok(both.split("\n\n").length >= 3, language);
  }
  // The boundary: high level status only, documents go elsewhere.
  assert.match(explainBothSeparately("english"), /high level status/iu);
  assert.match(explainBothSeparately("english"), /approved secure channel/iu);
});

test("the wording stays consistent with the approved MBC-010 and MBC-011 candidates", () => {
  const mbc010 = candidate("MBC-010");
  const mbc011 = candidate("MBC-011");
  assert.ok(mbc010, "MBC-010 is missing from brainMbCandidates");
  assert.ok(mbc011, "MBC-011 is missing from brainMbCandidates");
  for (const [language, key] of [["english", "en"], ["arabic", "ar"], ["greek", "el"]]) {
    assert.ok(SOURCE_OF_FUNDS[language].includes(mbc010[key]), `MBC-010 drift in ${language}`);
    assert.ok(SOURCE_OF_FUNDS[language].includes(mbc011[key]), `MBC-011 drift in ${language}`);
  }
});

test("no customer-facing string uses dash punctuation as a connector, and none is alarming", () => {
  for (const language of LANGUAGES) {
    const text = explainBothSeparately(language);
    assert.doesNotMatch(text, /\s[-–—]\s/u, language);
    // MB-SEC3: explain both "without terrifying the customer".
    assert.doesNotMatch(text, /suspicious|investigation|penalt|criminal|fail(?:ure)? to comply|frozen|مشبوه|تحقيق|عقوبة|جريمة|ύποπτ|έρευνα|ποινή|έγκλημα/iu, language);
  }
});

test("asking for a sensitive financial document in chat is caught in all three languages", () => {
  for (const text of [
    "Please send your payslip and your latest tax return",
    "Can you upload your bank statement here?",
    "أرسل قسيمة الراتب والإقرار الضريبي من فضلك",
    "ارفع كشف الحساب هون",
    "Στείλτε μου τη φορολογική δήλωση και τη βεβαίωση αποδοχών",
    "Ανεβάστε εδώ το τραπεζικό αντίγραφο"
  ]) {
    assert.equal(requestsSensitiveFinancialDocument(text), true, text);
  }
});

test("explaining a document is not requesting one, and ordinary words do not false positive", () => {
  for (const text of [
    "Source of Funds is the direct path of the amount used in this specific transaction",
    "I can explain what a bank statement is and why banks ask for one",
    "The compliance file is progressing normally",
    "بقدر أشرحلك شو يعني الإقرار الضريبي",
    "Μπορώ να εξηγήσω τι είναι η φορολογική δήλωση"
  ]) {
    assert.equal(requestsSensitiveFinancialDocument(text), false, text);
  }
  // The whole approved explanation must be sendable without tripping its own gate.
  for (const language of LANGUAGES) {
    assert.equal(requestsSensitiveFinancialDocument(explainBothSeparately(language)), false, language);
  }
});

test("Arabic bare-alef and hamza spellings reach the same verdict (BLK-16)", () => {
  const pairs = [
    ["ارسل كشف الحساب", "أرسل كشف الحساب"],
    ["ارسل الاقرار الضريبي", "أرسل الإقرار الضريبي"],
    ["ارسل قسيمه الراتب", "أرسل قسيمة الراتب"]
  ];
  for (const [bare, pointed] of pairs) {
    assert.equal(requestsSensitiveFinancialDocument(bare), requestsSensitiveFinancialDocument(pointed), `variant mismatch: ${bare}`);
    assert.equal(requestsSensitiveFinancialDocument(bare), true, `bare-alef spelling bypassed the gate: ${bare}`);
  }
});

test("null, empty, and undefined input are safe", () => {
  for (const text of [null, undefined, "", "   "]) {
    assert.equal(requestsSensitiveFinancialDocument(text), false);
  }
});
