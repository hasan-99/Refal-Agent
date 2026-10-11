const test = require("node:test");
const assert = require("node:assert/strict");
const { detectMessageLanguage, detectExplicitLanguageRequest, languageInstruction, inboundRetryMessage } = require("./language");

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
  // A common short Greeklish definition question may contain only Greek
  // function words plus an English legal/product term, so domain vocabulary
  // alone cannot identify it.
  assert.equal(detectMessageLanguage("Ti einai to IP Box?"), "greek");
  assert.equal(detectMessageLanguage("Ti simenei EORI?"), "greek");
  assert.equal(detectMessageLanguage("Nai, thelo na miliso me kapoion."), "greek");
  // Common Greeklish process and cost questions otherwise contain mostly
  // Latin-script words that resemble English and need a distinctive cue.
  assert.equal(detectMessageLanguage("Poia einai i diadikasia?"), "greek");
  assert.equal(detectMessageLanguage("Poio einai to kostos?"), "greek");
  assert.equal(detectMessageLanguage("Poios einai o synithismenos xronos?"), "greek");
  assert.equal(detectMessageLanguage("Poio is a project code."), "english");
  assert.equal(detectMessageLanguage("Shou is a family name."), "english");
  assert.equal(detectMessageLanguage("Poio, it is a project code."), "english");
  assert.equal(detectMessageLanguage("Shou — it is a family name."), "english");
  assert.equal(detectMessageLanguage("Poia einai i diadikasia? It is a process."), "greek");
  assert.equal(detectMessageLanguage("Shou services 3andkon? This is a concern for my company."), "arabic");
  assert.equal(detectMessageLanguage("Poia einai i diadikasia, it is a process."), "greek");
  assert.equal(detectMessageLanguage("Shou services 3andkon — this is a concern for my company."), "arabic");
  assert.equal(detectMessageLanguage("Shou is a family name; shu bta3mlo?"), "arabic");
  // Common Syrian Arabizi client formulations for activity, readiness, and
  // company capital, while plain English remains English.
  assert.equal(detectMessageLanguage("shu bta3mlo iza baddi eftah sharike jadide?"), "arabic");
  assert.equal(detectMessageLanguage("bte2daro tsa3douni b rasse mal?"), "arabic");
  // Common client spellings were missing from the detector: "shou" and the
  // plural/company-directed "3andkon" left an otherwise clear Arabizi query
  // in English, weakening both the reply-language lock and Arabic routing.
  assert.equal(detectMessageLanguage("shou services 3andkon?"), "arabic");
  assert.equal(detectMessageLanguage("shu services 3andon?"), "arabic");
  assert.equal(detectMessageLanguage("shou services 3andkom?"), "arabic");
  assert.equal(detectMessageLanguage("Ποιες υπηρεσίες προσφέρει η Refalco Group;"), "greek");
  assert.equal(detectMessageLanguage("What services does Refalco Group provide?"), "english");
  assert.equal(detectMessageLanguage("The shop is open today; I can compare the options later."), "english");
  // "Den" is ordinary English vocabulary as well as Greeklish for "not".
  // It is too weak to classify a Latin-script message by itself.
  assert.equal(detectMessageLanguage("Den is a good option."), "english");
  assert.equal(detectMessageLanguage("Den thelo rantevou akoma."), "greek");
  assert.equal(detectMessageLanguage("IP Box?"), "english");
  assert.equal(detectMessageLanguage("TI is a project code."), "english");
  assert.equal(detectMessageLanguage("EORI and GESY"), "english");
  assert.equal(detectMessageLanguage("bank services"), "english");
  assert.equal(detectMessageLanguage("The company has a new business model and a bank account."), "english");
});

test("recognizes explicit requests to switch the reply language", () => {
  assert.equal(detectExplicitLanguageRequest("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectMessageLanguage("Actually, can we continue in Greek?"), "greek");
  assert.equal(detectExplicitLanguageRequest("منكمل بالعربي لو سمحت"), "arabic");
  assert.equal(detectExplicitLanguageRequest("Please reply in English from now on."), "english");
  // Customers commonly phrase the same preference as a request to answer.
  // Explicit language choice must win over the English script of the request.
  assert.equal(detectExplicitLanguageRequest("Could you answer me in Greek?"), "greek");
  assert.equal(detectMessageLanguage("Could you answer me in Greek?"), "greek");
  assert.equal(detectMessageLanguage("Please answer in Arabic."), "arabic");
  assert.equal(detectMessageLanguage("Can you answer in English?"), "english");
  // Customers often ask for an explanation or translation rather than using
  // the words "reply" or "answer". The requested output language must still
  // override the language of the English request itself.
  assert.equal(detectExplicitLanguageRequest("Could you explain GESY in Arabic?"), "arabic");
  assert.equal(detectMessageLanguage("Could you explain GESY in Arabic?"), "arabic");
  assert.equal(detectExplicitLanguageRequest("Tell me about this in Greek, please."), "greek");
  assert.equal(detectExplicitLanguageRequest("Can you translate this into Greek?"), "greek");
  assert.equal(detectExplicitLanguageRequest("Explain this in English, please."), "english");
  assert.equal(detectExplicitLanguageRequest("Tell me what Greek services are available."), null);
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

test("language prompts preserve the planned register in Arabic, Greek, and English", () => {
  assert.match(languageInstruction("arabic"), /Syrian\/Levantine Arabic/);
  assert.match(languageInstruction("arabic"), /legal and government wording simple and professional/);
  assert.match(languageInstruction("greek"), /simple and readable/);
  assert.match(languageInstruction("greek"), /professional business Greek/);
  assert.match(languageInstruction("english"), /mirror the formality of their message/);
  assert.match(languageInstruction("english"), /relaxed when they are casual, concise and professional when they are formal/);
});

test("temporary inbound failures and overload notices use the customer's language", () => {
  assert.match(inboundRetryMessage("arabic"), /رسالتك/);
  assert.match(inboundRetryMessage("greek"), /μηνύματός σας/);
  assert.match(inboundRetryMessage("english"), /checking your message/);
  assert.match(inboundRetryMessage("arabic", "busy"), /إعادة إرسال رسالتك/);
  assert.match(inboundRetryMessage("greek", "busy"), /στείλτε ξανά το μήνυμά σας/);
  assert.match(inboundRetryMessage("english", "busy"), /resend your message/);
  assert.match(inboundRetryMessage("unknown"), /checking your message/);
});
