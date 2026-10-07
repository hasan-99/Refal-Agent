const test = require("node:test");
const assert = require("node:assert/strict");
const { detectMessageLanguage, detectExplicitLanguageRequest, languageInstruction } = require("./language");

test("detects script Arabic, Syrian Arabizi, and Greek reliably", () => {
  assert.equal(detectMessageLanguage("شو خدمات الشركة؟"), "arabic");
  assert.equal(detectMessageLanguage("baddi a3ref shu services 3andkon"), "arabic");
  assert.equal(detectMessageLanguage("shoghlha an online furniture shop"), "arabic");
  assert.equal(detectMessageLanguage("adey fee? la t2aked shi mish approved."), "arabic");
  assert.equal(detectMessageLanguage("Thelo na anoikso etaireia stin Kypro. Ti ypiresies exete?"), "greek");
  assert.equal(detectMessageLanguage("Den thelo rantevou akoma."), "greek");
  assert.equal(detectMessageLanguage("Den thelo na me piesis na kleiso rantevou i na doso stoicheia epikoinonias."), "greek");
  assert.equal(detectMessageLanguage("Den exo kati allo gia tin ora. An xreiaso kati, tha to zitiso."), "greek");
  assert.equal(detectMessageLanguage("Poso kostizei? Min peis kati an den einai sigouro."), "greek");
  assert.equal(detectMessageLanguage("Nai, pes mou analytika ti perilamvanei to paketo."), "greek");
  assert.equal(detectMessageLanguage("Meta tin kata8esi, poio einai to synithismeno xroniko diastima mexri tin egkrisi?"), "greek");
  assert.equal(detectMessageLanguage("Ποιες υπηρεσίες προσφέρει η the business;"), "greek");
  assert.equal(detectMessageLanguage("What services does the business provide?"), "english");
  assert.equal(detectMessageLanguage("The shop is open today; I can compare the options later."), "english");
});

test("recognizes explicit requests to switch the reply language", () => {
  assert.equal(detectExplicitLanguageRequest("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectMessageLanguage("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectExplicitLanguageRequest("منكمل بالعربي لو سمحت"), "arabic");
  assert.equal(detectExplicitLanguageRequest("Please reply in English from now on."), "english");
  assert.equal(detectExplicitLanguageRequest("What Greek services do you offer?"), null);
});

test("language prompts request readable Syrian Arabic and simple professional Greek", () => {
  assert.match(languageInstruction("arabic"), /Syrian\/Levantine Arabic/);
  assert.match(languageInstruction("greek"), /simple and readable/);
});
