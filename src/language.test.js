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
  assert.equal(detectMessageLanguage("ftiaxno efarmogi kai logismiko"), "greek");
  assert.equal(detectMessageLanguage("barmeje SaaS"), "arabic");
  assert.equal(detectMessageLanguage("baddi a3ref 3an tasees sharike w darayeb"), "arabic");
  assert.equal(detectMessageLanguage("Meta tin kata8esi, poio einai to synithismeno xroniko diastima mexri tin egkrisi?"), "greek");
  assert.equal(detectMessageLanguage("Thelo na anoikso etaireia kai na miliso gia forologika kai akinito."), "greek");
  // M10 domain coverage: unfamiliar corporate, tax, residency and property
  // queries must be classified as Greeklish before intent-specific routing.
  assert.equal(detectMessageLanguage("Metoxos se etaireia, ti xreiazetai gia systasi?"), "greek");
  assert.equal(detectMessageLanguage("Poso einai o forologikos syntelestis kai ta merismata?"), "greek");
  assert.equal(detectMessageLanguage("Ti xreiazetai gia adeia paramonis kai monimi diamoni?"), "greek");
  assert.equal(detectMessageLanguage("Thelo na agoraso oikopedo i diamerisma stin Kypro."), "greek");
  assert.equal(detectMessageLanguage("Nai, thelo na miliso me kapoion."), "greek");
  // Common Syrian Arabizi client formulations for activity, readiness, and
  // company capital, while plain English remains English.
  assert.equal(detectMessageLanguage("shu bta3mlo iza baddi eftah sharike jadide?"), "arabic");
  assert.equal(detectMessageLanguage("bte2daro tsa3douni b rasse mal?"), "arabic");
  assert.equal(detectMessageLanguage("Ποιες υπηρεσίες προσφέρει η Refalco Group;"), "greek");
  assert.equal(detectMessageLanguage("What services does Refalco Group provide?"), "english");
  assert.equal(detectMessageLanguage("The shop is open today; I can compare the options later."), "english");
  assert.equal(detectMessageLanguage("IP Box?"), "english");
  assert.equal(detectMessageLanguage("EORI and GESY"), "english");
  assert.equal(detectMessageLanguage("bank services"), "english");
  assert.equal(detectMessageLanguage("The company has a new business model and a bank account."), "english");
});

test("recognizes explicit requests to switch the reply language", () => {
  assert.equal(detectExplicitLanguageRequest("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectMessageLanguage("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectExplicitLanguageRequest("منكمل بالعربي لو سمحت"), "arabic");
  assert.equal(detectExplicitLanguageRequest("Please reply in English from now on."), "english");
  assert.equal(detectExplicitLanguageRequest("رد علي بالإنجليزي لو سمحت"), "english");
  assert.equal(detectMessageLanguage("رد علي بالإنجليزي لو سمحت"), "english");
  assert.equal(detectExplicitLanguageRequest("جاوبني باليوناني"), "greek");
  assert.equal(detectMessageLanguage("جاوبني باليوناني"), "greek");
  assert.equal(detectExplicitLanguageRequest("Μίλα μου στα αγγλικά παρακαλώ"), "english");
  assert.equal(detectExplicitLanguageRequest("Γράψε μου στα αραβικά"), "arabic");
  assert.equal(detectExplicitLanguageRequest("apantise sta ellinika"), "greek");
  assert.equal(detectExplicitLanguageRequest("What Greek services do you offer?"), null);
  assert.equal(detectExplicitLanguageRequest("بتحكي انكليزي"), null);
  assert.equal(detectMessageLanguage("بتحكي انكليزي"), "arabic");
});

test("language prompts request readable Syrian Arabic and simple professional Greek", () => {
  assert.match(languageInstruction("arabic"), /Syrian\/Levantine Arabic/);
  assert.match(languageInstruction("greek"), /simple and readable/);
});
