const { detectMessageLanguage, foldArabicLetters, foldRulePatterns } = require("./language");
const { SAFETY_CATEGORIES, classifySafety, safeLocalizedFallback } = require("./safetyPolicy");
const { evaluateAnswerClaims, isApprovedEvidence, containsGuaranteeMarker, containsPersonalizedConclusion } = require("./claimPolicy");
const { violatesOutputGuards } = require("./outputGuards");
const { probesAnotherCustomer, crossCustomerRefusal } = require("./crossCustomerPolicy");

// P2.2 defect PRICE-1 (High, trilingual fail-open). Three price patterns lived
// inline in this file and had drifted apart: the excerpt filter below knew the
// Arabic currency words but NOT the Greek `ευρώ`, so a Greek price sentence was
// never stripped from a non-pricing answer. Proven with an approved Greek chunk:
// the question "do you handle company formation?" came back carrying "999 ευρώ",
// while the identical Arabic chunk was correctly stripped. `selectPricePassage`
// and `isPriceEvidence` had the mirror-image gap in the fail-closed direction,
// so a Greek or keyword-free Arabic price chunk could never be selected at all.
//
// One source now, three regexes built from it, so they cannot drift again. Note
// `src/groundingPolicy.js` PRICE_FACT already covered Greek; this file was the
// one that did not, which is exactly why the asymmetry went unnoticed.
//
// No \b after a non-ASCII currency word: \b is ASCII-only in JavaScript, which
// is the same trap documented at selectPricePassage below and at BLK-15/BLK-16.
const CURRENCY_AMOUNT_SOURCE = "(?:[$€£]\\s?[\\d٠-٩]|\\b(?:EUR|USD|GBP)\\s?[\\d٠-٩]|(?<![\\p{L}\\p{N}])[\\d٠-٩][\\d٠-٩,.]*\\s?(?:EUR|USD|GBP|euros?|dollars?|pounds?)\\b|[\\d٠-٩][\\d٠-٩,.]*\\s?(?:يورو|دولار|جنيه|ευρώ|δολάρια|λίρες))";
const PRICE_KEYWORD_SOURCE = "(?:fee|price|package|باقة|السعر|رسوم(?:\\s+التأسيس)?|τιμή|τιμές|κόστος|πακέτο|κοστίζει).{0,40}[\\d٠-٩]";
const CURRENCY_AMOUNT = new RegExp(CURRENCY_AMOUNT_SOURCE, "iu");
const PRICE_BEARING = new RegExp(`${CURRENCY_AMOUNT_SOURCE}|${PRICE_KEYWORD_SOURCE}`, "iu");

function answerFromEvidence(evidence, { allowPricing = false, customerQuestion = "" } = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const asksWhetherPriceIsCurrent = /\b(?:still\s+(?:the\s+)?current|currently\s+(?:valid|accurate)|is\s+(?:this|that|the\s+price)\s+still|up[- ]to[- ]date|current\s+(?:price|fee|package))\b|(?:لسا|ما زال|هل السعر الحالي|السعر لسا|صالح لحد الآن)|(?:ισχύει ακόμη|είναι ακόμη σε ισχύ|τρέχουσα τιμή)/iu.test(customerQuestion);
  const isPriceEvidence = (item) => PRICE_BEARING.test(String(item?.content || ""));
  const priceEvidence = evidence.filter(isPriceEvidence);
  if (((asksWhetherPriceIsCurrent || allowPricing) && !priceEvidence.length) || ((asksWhetherPriceIsCurrent || allowPricing) && priceEvidence.some((item) => !item?.valid_until || Date.parse(item.valid_until) <= Date.now() || item.review_status !== "approved"))) return null;
  const selectedPrice = asksWhetherPriceIsCurrent || allowPricing
    ? priceEvidence.map((item, index) => ({ item, index, passage: selectPricePassage(String(item.content || "")) }))
      .sort((left, right) => right.passage.score - left.passage.score || left.index - right.index)[0]
    : null;
  const source = selectedPrice?.item || evidence[0];
  const sourceContent = String(source.content || "");
  const focusedPricePassage = selectedPrice?.passage?.text || "";
  const raw = String((asksWhetherPriceIsCurrent || allowPricing) ? focusedPricePassage : sourceContent)
    .replace(/\b(?:retrieval\s+query|search\s+query|customer\s+question|user\s+query|query)\s*[:=].*$/iu, "")
    .replace(/\s+/g, " ").trim();
  // Some imported chunks include retrieval phrases to help Arabic lexical
  // search. Those phrases are metadata-like and should never be repeated to
  // the customer as prose. Keep only grounded declarative source sentences.
  const sentences = raw.split(/(?<=[.!؟?])\s+/u).filter((sentence) =>
    !/[؟?]/u.test(sentence) &&
    !/(?:what services does|what does business offer|شو خدمات الشركة|ما هي الخدمات التي تقدمها|بدي اسجل شركة|طلب عن تأسيس الشركة|retrieval\s+query|search\s+query|customer\s+question|user\s+query)/iu.test(sentence)
  );
  const excerpt = sentences
    .filter((sentence) => allowPricing || !PRICE_BEARING.test(sentence))
    .join(" ").trim();
  // W2.2.2 — the excerpt is built FROM this evidence, so it is judged against
  // this evidence. Before M2 the blanket gate deleted every grounded excerpt
  // that merely mentioned residency, a permit or a tax rate, which is BLK-1:
  // the deterministic answer path could never emit an approved programme fact.
  if (!excerpt || containsProhibitedClaim(excerpt, { evidence }) || containsPromptInjection(excerpt)) return null;
  if (customerQuestion) {
    // A deterministic excerpt has no model to translate or resolve context.
    // Do not turn an unrelated top-ranked chunk into the answer, or send
    // English source prose to an Arabic/Greek customer.
    if (detectMessageLanguage(excerpt) !== detectMessageLanguage(customerQuestion)) return null;
    if (!allowPricing && !hasQuestionEvidenceOverlap(customerQuestion, excerpt)) return null;
  }
  const answer = excerpt.length > 460 ? `${excerpt.slice(0, 457).replace(/\s+\S*$/, "")}...` : excerpt;
  const citations = [{
    name: source.source_name,
    url: source.source_url,
    documentId: source.document_id,
    chunkId: source.chunk_id || null
  }];
  return {
    answer,
    citations
  };
}

function selectPricePassage(content) {
  const blocks = String(content || "").split(/\n\s*\n/gu).map((block) => block.replace(/\s+/gu, " ").trim()).filter(Boolean);
  // The trailing \b made the Arabic currency words unreachable: \b is ASCII-only
  // in JavaScript, so "999 يورو" did NOT register as a price claim while
  // "999 EUR" did. Verified 2026-10-09. The Latin currency names keep their \b;
  // the Arabic ones are matched without it.
  const priceClaim = CURRENCY_AMOUNT;
  const unsafeExample = /^(?:❌|wrong\b|incorrect\b|خطأ)|(?:لا تقول|do not say|don['’]t say|μην πείτε)/iu;
  const candidates = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!priceClaim.test(block) || unsafeExample.test(block)) continue;
    const previous = blocks[index - 1] || "";
    if (unsafeExample.test(previous)) continue;
    let score = 1;
    if (/(?:current|published|price|fee|package|formation|setup|عرض|السعر|تكلفة|رسوم|تأسيس|τιμή|κόστος|πακέτ)/iu.test(block)) score += 4;
    if (block.length <= 100) score += 3;
    if (/(?:current|published|price|fee|package|formation|setup|عرض|السعر|تكلفة|رسوم|تأسيس|τιμή|κόστος|πακέτ)/iu.test(previous)) score += 2;
    if (/[?؟]/u.test(block)) score -= 5;
    if (/(?:غالي|رخيص|expensive|cheap|ακριβ)/iu.test(block)) score -= 4;
    const prefix = block.length <= 100 && previous.length <= 100 && /(?:current|published|price|fee|package|عرض|السعر|تكلفة|رسوم|τιμή|κόστος|πακέτ)/iu.test(previous)
      ? `${previous}: `
      : "";
    candidates.push({ score, index, text: `${prefix}${block}` });
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0] || { score: Number.NEGATIVE_INFINITY, index: -1, text: "" };
}

const EVIDENCE_QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "which", "where", "when", "does", "will", "would", "can", "could", "should", "have", "about", "tell", "please", "help", "need", "want", "you", "your", "company", "business", "refal", "information", "info", "more",
  "ال", "في", "من", "على", "عن", "شو", "كيف", "وين", "متى", "هل", "ممكن", "بدي", "عندي", "عنا", "ما", "هي", "هو", "مع", "الى", "إلى", "الشركة", "ريفال", "الخدمات", "خدمات", "معلومات",
  "και", "για", "από", "στο", "στη", "στην", "το", "τα", "της", "των", "τι", "πώς", "πού", "πότε", "είναι", "μπορεί", "μπορώ", "θέλω", "πληροφορίες", "business"
]);

function hasQuestionEvidenceOverlap(question, evidenceText) {
  const tokenize = (value) => String(value || "").toLocaleLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]{3,}/gu) || [];
  const queryTerms = [...new Set(tokenize(question).filter((term) => !EVIDENCE_QUERY_STOPWORDS.has(term)))];
  const evidenceTerms = new Set(tokenize(evidenceText));
  if (queryTerms.length === 0) return false;
  const overlap = queryTerms.filter((term) => evidenceTerms.has(term)).length;
  return queryTerms.length >= 3 ? overlap >= 2 : overlap >= 1;
}

function knowledgeSourceRecords(evidence, limit = 6) {
  if (!Array.isArray(evidence)) return [];
  const max = Math.max(0, Math.min(6, Number.isInteger(limit) ? limit : 6));
  if (!max) return [];
  const records = [];
  const seen = new Set();
  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;
    const sourceId = boundedEvidenceField(item.source_id ?? item.sourceId, 100);
    const documentId = boundedEvidenceField(item.document_id ?? item.documentId, 100);
    const chunkId = boundedEvidenceField(item.chunk_id ?? item.chunkId, 100);
    const sourceName = boundedEvidenceField(item.source_name ?? item.sourceName ?? item.name, 160);
    const sourceUrl = boundedEvidenceField(item.source_url ?? item.sourceUrl ?? item.url, 500);
    const key = [sourceId, documentId, chunkId, sourceUrl].join("|");
    if ((!sourceId && !documentId && !chunkId && !sourceUrl) || seen.has(key)) continue;
    seen.add(key);
    const rawScore = item.rank ?? item.score ?? item.similarity;
    const numericScore = rawScore === null || rawScore === undefined || rawScore === "" ? null : Number(rawScore);
    records.push({
      sourceId: sourceId || null,
      documentId: documentId || null,
      chunkId: chunkId || null,
      name: sourceName || null,
      url: sourceUrl || null,
      title: boundedEvidenceField(item.document_title ?? item.documentTitle, 200) || null,
      heading: boundedEvidenceField(item.heading, 200) || null,
      score: Number.isFinite(numericScore) ? numericScore : null
    });
    if (records.length >= max) break;
  }
  return records;
}

function knowledgeEvidenceMetadata(evidence, { modelRequestMade = false, modelResponseUsed = false, fallbackCitations = [] } = {}) {
  const items = Array.isArray(evidence) ? evidence : [];
  return {
    retrieved: knowledgeSourceRecords(items, 6),
    providedToModel: modelRequestMade ? knowledgeSourceRecords(items.slice(0, 5), 5) : [],
    usedForFallback: modelResponseUsed ? [] : knowledgeSourceRecords(fallbackCitations, 1)
  };
}

function boundedEvidenceField(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function containsPromptInjection(text) {
  return classifySafety(text).risks.includes(SAFETY_CATEGORIES.PROMPT_INJECTION);
}

function noApprovedEvidenceReply(language = "english", { pricing = false } = {}) {
  if (pricing && language === "arabic") return "لا تتوفر لديّ حاليًا رسوم تأسيس معتمدة أستطيع تأكيدها. ما النشاط الذي ستزاوله الشركة؟";
  if (pricing && language === "greek") return "Δεν έχω εγκεκριμένη τιμή ίδρυσης που να μπορώ να επιβεβαιώσω αυτή τη στιγμή. Ποια δραστηριότητα θα έχει η εταιρεία;";
  if (pricing) return "I don’t have an approved company formation fee to confirm right now. What business activity will the company have?";
  if (language === "arabic") return "ما عندي معلومة معتمدة أأكدها بهالنقطة حالياً. فيني ساعدك بأي جزء تاني من سؤالك.";
  if (language === "greek") return "Δεν έχω εγκεκριμένη πληροφορία για να το επιβεβαιώσω τώρα. Μπορώ να βοηθήσω με κάποιο άλλο σημείο της ερώτησής σας.";
  return "I don't have approved information to confirm that yet. I can help with another part of your question.";
}

// P2.2 / W2.2.1-W2.2.4 — the three patterns below were inline locals inside the
// old single-function gate. They are module-level consts now so that BOTH the
// legacy blanket path and the evidence-aware path use the SAME source text. A
// second hand-typed copy of a safety regex is exactly how the edge function
// drifted into a fail-open (see scripts/generateEdgeMirrors.js), so there is
// only ever one copy of each.
const UNSUPPORTED_SUITABILITY = /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b|\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b|(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|مؤهل|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu;
// Absolute-certainty claims. Deliberately NOT a blanket ban on "100%":
// "a non-resident can own 100% of a Cyprus company" is a correct and useful
// fact, and blocking it would push REFAL into vagueness about ownership. Only
// 100% paired with an OUTCOME word is a prohibited guarantee.
// No \b after `%`: the percent sign is not a word character, so `100\s*%\b`
// can never match. The same trap that killed the original pattern.
const ABSOLUTE_CERTAINTY = /\b100\s*(?:%|percent)[^.!?]{0,40}\b(?:success|approval|approved|guaranteed|certain|sure|accept\w*)\b|\b(?:success|approval|guarantee\w*|certain)\b[^.!?]{0,40}\b100\s*(?:%|percent)|(?:100\s*٪|مئة بالمئة|مائة بالمائة)[^.؟!]{0,40}(?:نجاح|موافقة|ضمان|مضمون)|(?:نجاح|موافقة|ضمان|مضمون)[^.؟!]{0,40}(?:100\s*٪|مئة بالمئة)|(?:100\s*%|εκατό τοις εκατό)[^.;!]{0,40}(?:επιτυχία|έγκριση|εγγύηση)/iu;
// BLK-1. This is the blanket topic regex. It deletes ANY sentence that merely
// mentions residency, visa, permit, licence, tax or investment, which is most
// of MB-F19..F55 — the entire Refalco knowledge base. It is kept VERBATIM and
// is still the whole gate when no approved evidence was supplied, so the empty
// knowledge case behaves exactly as it did before M2.
const BLANKET_RESTRICTED_TOPICS = /\b(?:investment\s+(?:returns?|roi|irr|yield|advice|recommendations?)|(?:returns?|roi|irr|yield|profits?)\b.{0,60}\binvest\w*|(?:returns?|roi|irr|yield)\s+(?:on|from)\s+(?:an?\s+)?investment|financial advice|(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered|registration number|company number|legal status|legal entity|legal advice|tax advice|immigration advice|visa|residency|bank approval|loan approval|mortgage approval|permit|licen[cs]e|government approval|company approval)\b|(?:عوائد|عائد|ربح|أرباح)\s+(?:الاستثمار|استثماري)|(?:استثمار|استثماري)\s+(?:بعائد|بعوائد|مربح|مضمون)|استشارة استثمارية|موافقة مضمونة|ضمان الموافقة|الموافقة مضمونة|عائد مضمون|عوائد مضمونة|أرباح مضمونة|ربح مضمون|الشركة\s+(?:مسجلة|مسجل)\s+(?:في|بقبرص)|السجل التجاري|الوضع القانوني|كيان قانوني|استشارة قانونية|استشارة ضريبية|معدل الضريبة|نسبة الضريبة|هجرة|تأشيرة|إقامة|موافقة البنك|قرض|رهن|رخصة|ترخيص|موافقة حكومية|(?:ستحصل|سيحصل|سيتم منحك).{0,35}(?:الموافقة|موافقة|رخصة|ترخيص)|επενδυτικ(?:ές|ή)\s+αποδόσεις|απόδοση\s+(?:επένδυσης|επενδυτική)|επενδυτική\s+συμβουλή|σίγουρη έγκριση|εγγυημένη έγκριση|εγγυημένη απόδοση|νομική συμβουλή|φορολογική συμβουλή|εταιρεία\s+(?:είναι\s+)?εγγεγραμμένη|νομική οντότητα|βίζα|διαμονή|έγκριση τράπεζας|δάνειο|άδεια|κρατική έγκριση|θα εγκριθεί.{0,40}(?:άδεια|έγκριση)|θα (?:πάρω|λάβω).{0,40}(?:άδεια|έγκριση)/iu;

// Claims that no amount of approved evidence can rescue. A guarantee and a
// personalized suitability verdict are prohibited BECAUSE of what they assert,
// not because the supporting fact is missing, so this runs on both paths.
function containsUnconditionalProhibition(text, options = {}) {
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (ABSOLUTE_CERTAINTY.test(claimText) || UNSUPPORTED_SUITABILITY.test(claimText)) return true;
  // P2.6 finding G-01. A bare guarantee with no restricted-topic noun beside it
  // matched neither the blanket regex nor any output guard. It is unconditional
  // by definition, so it is tested here on both branches. `containsGuaranteeMarker`
  // applies claimPolicy's refusal strips, so REFAL's own "I cannot guarantee..."
  // does not register.
  if (containsGuaranteeMarker(claimText) || containsPersonalizedConclusion(claimText)) return true;
  // P2.6 findings G-05, G-06, G-07. A bank-approval promise, an ROI or yield
  // claim, a personalized VAT verdict, an unsourced reservation deposit and a
  // question about another customer are prohibited because of WHAT they assert.
  // Approved evidence is irrelevant to all five, so they belong on this side of
  // the branch, not in the evidence-gated classifier.
  return violatesOutputGuards(claimText, { reservationSource: options?.reservationSource, language: options?.language });
}

// W2.2.1 — the pre-M2 gate, unchanged in behaviour and deliberately NOT deleted.
// It remains the whole gate whenever no approved evidence was supplied.
function containsProhibitedClaimLegacy(text) {
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (ABSOLUTE_CERTAINTY.test(claimText)) return true;
  return UNSUPPORTED_SUITABILITY.test(claimText) || BLANKET_RESTRICTED_TOPICS.test(claimText);
}

// W2.2.2 — the M2 gate. Branch, do not replace:
//
//   no approved evidence  -> containsProhibitedClaimLegacy, byte-identical to
//                            the pre-M2 behaviour.
//   approved evidence     -> split into clauses and classify each one. A clause
//                            is rejected when it is a PERSONALIZED_CONCLUSION, a
//                            GUARANTEE, or a PROGRAM_FACT whose entities and
//                            numbers are not all present in that evidence.
//
// `options.evidence` takes the same chunk objects `answerFromEvidence` consumes.
// Unapproved and expired chunks are filtered out by `isApprovedEvidence`, so a
// stale chunk can never unlock a programme fact.
function containsProhibitedClaim(text, options = {}) {
  // Runs BEFORE the branch, not inside the evidence arm. A guarantee, an ROI
  // claim, a personalized VAT verdict, an unsourced deposit figure and another
  // customer's data are prohibited whether or not a chunk was retrieved, so
  // gating them on evidence would have left the whole no-evidence path, which
  // is the common case today with an empty corpus, unprotected by them.
  //
  // This makes the gate a strict SUPERSET of the pre-M2 behaviour rather than
  // byte-identical to it. That is a deliberate strengthening, and it is why
  // src/guardrailRegression.test.js asserts implication (legacy blocked implies
  // this blocks) rather than equality.
  if (containsUnconditionalProhibition(text, options)) return true;
  const supplied = Array.isArray(options?.evidence) ? options.evidence.filter(isApprovedEvidence) : [];
  if (!supplied.length) return containsProhibitedClaimLegacy(text);
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (!claimText.trim()) return false;
  return !evaluateAnswerClaims(claimText, { evidence: supplied, language: options?.language }).allowed;
}

// Exempt only complete, narrowly worded disclaimer clauses. Splitting at
// sentence/semicolon boundaries means an affirmative neighboring clause is
// still checked by the normal prohibited-claim rules.
function removeSafeDisclaimerClauses(text) {
  const safeDisclaimer = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:provide|give|offer)\s+(?:personalized\s+|personalised\s+)?(?:tax|legal|immigration|investment|financial)\s+advice(?:\s+or\s+confirm\s+(?:a\s+)?tax\s+result)?[.!;]?$/iu;
  // P2.6 defect CLAIM-4, English half. The anchored pattern above requires the
  // clause to END at "advice", so REFAL's own approved English investment
  // fallback — "I can't provide investment advice, expected returns, or
  // financial guarantees." — was NOT exempt and the blanket topic regex deleted
  // it. That is pre-M2 behaviour and it is still live on the no-evidence path,
  // which is the common case while the corpus is empty. A refusal that ENUMERATES
  // what it refuses is still a refusal; the enumeration may not contain a verb,
  // which is what keeps this from swallowing an affirmative follow-on clause.
  const safeEnumeratedRefusal = /^(?:i|we|refal|refalco|business)\s+(?:can(?:not|['’]t)|cannot|do(?:es)?\s+not|don['’]t|will\s+not|won['’]t)\s+(?:provide|give|offer|share|discuss|quote)\s+[^.!?;]{0,120}$/iu;
  const safeLegalStatusDisclaimer = /^(?:business|i|we)\s+(?:do not|don['’]t|does not|doesn['’]t)\s+provide\s+(?:information\s+about\s+)?(?:company\s+registration\s+or\s+)?legal[- ]status(?:\s+information)?[.!]?$/iu;
  const safeOutcomeDisclaimer = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:guarantee|confirm|promise)\s+(?:that\s+)?(?:bank\s+approval|financing|a\s+loan outcome|a\s+tax result|a\s+permit(?:\s+(?:or\s+)?(?:licen[cs]e|planning))? outcome|(?:a\s+)?licen[cs]e outcome|(?:investment\s+)?returns?)(?:\s*;?\s*the\s+(?:bank|relevant authority)\s+decides)?[.!;]?$/iu;
  const safeEnglishRegulatoryUncertainty = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:confirm|determine|verify)\s+(?:whether|if)\s+.{0,100}\b(?:permit|licen[cs]e|eligible|eligibility|approved|approval|regulated|tax result)\b[.!?]?$/iu;
  const safeArabic = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تقديم|إعطاء)\s+(?:نصيحة|استشارة)\s+(?:ضريبية|قانونية|مالية|استثمارية)(?: شخصية)?(?:\s+أو\s+تأكيد\s+نتيجة ضريبية)?[.!؟]?$/u;
  const safeArabicOutcome = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|ضمان)\s+(?:نتيجة (?:الرخصة|التصريح|التخطيط|ضريبية)|(?:نتيجة )?موافقة البنك|الحصول على (?:رخصة|تصريح)|عوائد الاستثمار|نتيجة الرخصة أو التصريح أو التخطيط)(?:\s*؛?\s*(?:البنك|الجهة المختصة)\s+(?:هو من يقرر|تقرر))?[.!؟]?$/u;
  const safeArabicLegalStatus = /^لا\s+(?:أقدم|أوفر|أستطيع تقديم)\s+معلومات\s+عن\s+(?:تسجيل الشركات|الوضع القانوني|السجل التجاري)(?:\s+أو\s+(?:الوضع القانوني|تسجيل الشركات))?(?:\s+لها)?[.!؟]?$/u;
  const safeArabicRegulatoryUncertainty = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|أكد|تحديد|أتحقق)\s+(?:إذا|إن كان|ما إذا)?\s*.{0,100}(?:ترخيص|رخصة|مؤهل|مقبول|معتمد|خاضع للتنظيم|نتيجة ضريبية)[.!؟]?$/u;
  const safeGreek = /^(?:δεν μπορώ|δεν μπορούμε|η business δεν μπορεί)\s+να\s+(?:παρέχω|παρέχουμε|παρέχει|δώσω|δώσουμε)\s+(?:εξατομικευμένη\s+)?(?:φορολογική|νομική|μεταναστευτική|επενδυτική|οικονομική)\s+συμβουλή(?:\s+ή\s+να\s+επιβεβαιώσω\s+φορολογικό\s+αποτέλεσμα)?[.!;]?$/iu;
  const safeGreekOutcome = /^(?:δεν μπορώ|δεν μπορούμε|η business δεν μπορεί)\s+να\s+(?:εγγυηθώ|εγγυηθούμε|εγγυηθεί|επιβεβαιώσω|επιβεβαιώσουμε)\s+(?:την\s+)?(?:έγκριση τράπεζας|τραπεζική έγκριση|χρηματοδότηση|δάνειο|φορολογικό αποτέλεσμα|αποτέλεσμα (?:άδειας|πολεοδομικής έγκρισης)|αποτέλεσμα για άδεια ή πολεοδομική έγκριση|απόδοση επένδυσης)(?:\s*,?\s*(?:χρηματοδότηση|ή\s+δάνειο))?(?:\s*;?\s*η\s+(?:τράπεζα|αρμόδια αρχή)\s+αποφασίζει)?[.!;]?$/iu;
  const safeGreekBankGuarantee = /^δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο[.!;]?$/iu;
  const safeGreekRegulatoryUncertainty = /^δεν μπορώ να (?:επιβεβαιώσω|καθορίσω|επαληθεύσω)\s+(?:αν|εάν)\s+.{0,100}(?:άδεια|έγκριση|επιλέξιμη|ρυθμιζόμενη|φορολογικό αποτέλεσμα)[.!;]?$/iu;
  return String(text || "").split(/(?<=[.!?؟;；])\s+/u).filter((clause) => {
    const value = clause.trim();
    return !(safeDisclaimer.test(value) || safeEnumeratedRefusal.test(value) || safeLegalStatusDisclaimer.test(value) || safeOutcomeDisclaimer.test(value) || safeEnglishRegulatoryUncertainty.test(value) || safeArabic.test(value) || safeArabicOutcome.test(value) || safeArabicLegalStatus.test(value) || safeArabicRegulatoryUncertainty.test(value) || safeGreek.test(value) || safeGreekOutcome.test(value) || safeGreekBankGuarantee.test(value) || safeGreekRegulatoryUncertainty.test(value));
  }).join(" ");
}

// W2.2.3 / BLK-2 — a PROGRAMME enquiry is a question about a published Refalco
// service or a published Cyprus programme. It is the core of what REFAL exists
// to answer, so it is not a restricted topic in itself. Compare with
// PERSONALIZED_OUTCOME_DEMAND below, which asks REFAL to decide the customer's
// own outcome and stays refused in every case, evidence or not.
const rawProgrammeEnquiry = [["programme_enquiry", /\b(?:permanent\s+residenc(?:y|e)|residency\s+(?:programme|program|route|scheme|requirements?)|pr\s+(?:route|programme|program)|category\s+[abc]\b|non[\s-]?dom|ip\s*box|qualifying\s+investment|investment\s+(?:programme|program|route|scheme)|golden\s+visa|(?:reduced|standard|property)\s+vat|vat\s+(?:rate|registration|number|of\s+\d)|corporate\s+tax\s+rate|tax\s+(?:residency|resident)|double\s+tax\s+(?:treaty|treaties)|source\s+of\s+(?:funds|wealth)|eori|company\s+formation|work\s+permit\s+requirements?|residence\s+permit\s+requirements?|planning\s+permission|building\s+permit|trademark\s+registration)\b|(?:الاقامة\s+الدائمة|برنامج\s+الاقامة|متطلبات\s+الاقامة|الفئة\s+(?:A|B|C|أ|ب|ج)|نون\s*دوم|الاستثمار\s+المؤهل|برنامج\s+الاستثمار|ضريبة\s+الشركات|ضريبة\s+القيمة\s+المضافة|الاقامة\s+الضريبية|الازدواج\s+الضريبي|مصدر\s+(?:الاموال|الثروة)|تاسيس\s+الشركات?|تاسيس\s+شركة|رخصة\s+(?:البناء|التخطيط)|تسجيل\s+العلامة\s+التجارية)|(?:μόνιμ\p{L}*\s+(?:διαμον\p{L}*|κατοικ\p{L}*)|πρόγραμμα(?:\s+\p{L}+){0,2}\s+διαμον\p{L}*|Κατηγορία\s+[ΑΒΓABC]|εταιρικ\p{L}*\s+φόρο\p{L}*|φορολογικ\p{L}*\s+κατοικ\p{L}*|επιλέξιμ\p{L}*\s+επένδυσ\p{L}*|πηγ\p{L}*\s+(?:κεφαλαί\p{L}*|πλούτου)|ίδρυσ\p{L}*\s+εταιρεί\p{L}*|πολεοδομικ\p{L}*\s+άδει\p{L}*|άδει\p{L}*\s+οικοδομ\p{L}*|(?:μειωμέν\p{L}*|κανονικ\p{L}*)?\s*ΦΠΑ|εγγραφ\p{L}*\s+ΦΠΑ)/iu]];
const rawPersonalizedOutcomeDemand = [["personalized_outcome_demand", /\b(?:will\s+i\s+(?:get|receive|be\s+(?:approved|granted|eligible))|do\s+i\s+qualify|am\s+i\s+eligible|can\s+i\s+get\s+approved|guarantee\s+(?:me|my|that\s+i)|is\s+my\s+(?:company|activity|business|case|application)\s+(?:eligible|suitable|approved|going\s+to)|my\s+(?:case|situation)\s+(?:qualif|eligib))|(?:هل\s+ساحصل|هل\s+انا\s+مؤهل|هل\s+نشاطي\s+(?:مناسب|مقبول)|هل\s+شركتي\s+مؤهله|بتضمنلي|تضمنلي|احصل\s+على\s+الموافقه\s+اكيد)|(?:θα\s+πάρω|δικαιούμαι|είμαι\s+επιλέξιμ|μου\s+εγγυάστε|η\s+εταιρεία\s+μου\s+δικαιούται)/iu]];
const [, PROGRAMME_ENQUIRY] = foldRulePatterns(rawProgrammeEnquiry)[0];
const [, PERSONALIZED_OUTCOME_DEMAND] = foldRulePatterns(rawPersonalizedOutcomeDemand)[0];

function isProgrammeEnquiry(text) {
  const value = foldArabicLetters(String(text || "").normalize("NFKC"));
  return PROGRAMME_ENQUIRY.test(value) && !PERSONALIZED_OUTCOME_DEMAND.test(value);
}

// Prompt injection and credential exposure are never traded away for a grounded
// answer. They are the two risks that are about the REQUEST, not the topic.
const NEVER_BYPASSED_RISKS = Object.freeze([SAFETY_CATEGORIES.PROMPT_INJECTION, SAFETY_CATEGORIES.PRIVACY]);

// True when a restricted-topic refusal should stand down and let the normal
// retrieval + grounded-answer path run instead. Used by refalcoAnswer itself and
// by src/messageRouter.js, which refuses BEFORE retrieval happens and was
// therefore the place BLK-2 did most of its damage.
// P2.6 finding G-06 (Blocker, introduced by P2.2 and repaired here).
//
// The first version of this function stood down the refusal for anything that
// merely LOOKED like a programme enquiry, and re-armed only for prompt injection
// and credential exposure. `INVESTMENT_RETURN_OR_GUARANTEE` sat further down in
// `restrictedRefalcoReply`, below the early return, so it was never reached once
// evidence existed. The measured consequence: "What is the ROI on the Category C
// qualifying investment?" was refused before M2 and silently stopped being
// refused after it, in all three languages. MB-F55 and MB-SEC1 forbid exactly
// that, and SOURCE-ANALYSIS.md section 11.1 lists it under "explicitly NOT
// removed". P2.2's own W2.2.4 test asserted those strings stay refused, but only
// in the no-evidence mode, which is why the regression was invisible.
//
// The repair is to make every "never stand down" reason one predicate, checked
// BEFORE the carve-out rather than after it.
function requiresRefusalRegardlessOfEvidence(text) {
  const folded = foldArabicLetters(String(text || "").normalize("NFKC"));
  if (INVESTMENT_RETURN_OR_GUARANTEE.test(folded)) return true;
  if (PERSONALIZED_OUTCOME_DEMAND.test(folded)) return true;
  if (containsUnconditionalProhibition(text)) return true;
  return classifySafety(text).risks.some((risk) => NEVER_BYPASSED_RISKS.includes(risk));
}

function allowsGroundedProgrammeAnswer(text) {
  if (!isProgrammeEnquiry(text)) return false;
  return !requiresRefusalRegardlessOfEvidence(text);
}

// W2.2.4 — Category C is literally an investment product and MB-R5 makes REFAL
// an Investment Enquiry Assistant, so a bare mention of "investment" can no
// longer trigger a flat refusal. Only investment ADVICE, RETURNS and GUARANTEES
// do. This narrowing is the whole of BLK-8.
const INVESTMENT_PROGRAMME_CONTEXT = /\b(?:qualifying\s+investment|investment\s+(?:programme|program|route|scheme|threshold|amount|requirements?)|category\s+[abc]\b|permanent\s+residency)\b|(?:الاستثمار\s+المؤهل|برنامج\s+الاستثمار|الفئة\s+(?:A|B|C|أ|ب|ج)|الاقامه\s+الدائمه)|(?:επιλέξιμ\p{L}*\s+επένδυσ\p{L}*|πρόγραμμα\s+επένδυσ\p{L}*|μόνιμ\p{L}*\s+διαμον\p{L}*)/iu;
// The narrowing above must never reach a RETURN or a GUARANTEE. "Guaranteed 8%
// on the Category C investment" carries programme words and is still exactly
// the claim MB-F55 forbids, so these terms re-arm the refusal unconditionally.
const INVESTMENT_RETURN_OR_GUARANTEE = /\b(?:investment\s+(?:advice|recommendations?|returns?)|financial\s+advice|roi|irr|yield|profit\s+guarantee|guaranteed?\s+returns?|expected\s+returns?)\b|(?:استشاره\s+استثماريه|نصيحه\s+ماليه|توصيه\s+استثماريه|عوائد\s+(?:مضمونه|متوقعه)|العائد\s+(?:المتوقع|المضمون)|عوائد\s+الاستثماريه|عوائد\s+استثماريه|ربح\s+مضمون)|(?:επενδυτική\s+συμβουλή|οικονομική\s+συμβουλή|εγγυημένη\s+απόδοση)/iu;

function restrictedRefalcoReply(text, options = {}) {
  const language = detectMessageLanguage(text);
  const arabic = language === "arabic";
  const supplied = Array.isArray(options?.evidence) ? options.evidence.filter(isApprovedEvidence) : [];
  // W2.2.3 — with approved, unexpired evidence in hand a programme question is
  // answered from that evidence instead of refused. Without evidence the
  // refusal below stands exactly as it did before M2.
  // P2.6 finding G-05. Asked before the programme carve-out, because the probes
  // that mattered were written IN programme vocabulary ("who else is applying
  // under the 300,000 euro permanent residency route?") and so looked exactly
  // like the questions M2 just taught REFAL to answer. The reply names the real
  // reason rather than falling through to a generic immigration refusal, and it
  // points out that the same protection covers this customer.
  if (probesAnotherCustomer(text)) return crossCustomerRefusal(language);
  if (supplied.length && allowsGroundedProgrammeAnswer(text)) return null;
  const investmentAdvice = /\b(?:investment\s+(?:advice|recommendations?|returns?|opportunities?)|financial advice|roi|irr|returns?|yield|profit guarantee)\b|استشارة استثمارية|نصيحة مالية|توصية استثمارية|عوائد (?:مضمونة|متوقعة)|العائد (?:المتوقع|المضمون)|عوائد الاستثمارية|عوائد استثمارية|ربح مضمون|επενδυτική συμβουλή|οικονομική συμβουλή|εγγυημένη απόδοση|κέρδος/iu.test(text);
  const folded = foldArabicLetters(String(text || "").normalize("NFKC"));
  const programmeOnlyInvestment = INVESTMENT_PROGRAMME_CONTEXT.test(folded)
    && !INVESTMENT_RETURN_OR_GUARANTEE.test(folded)
    && !PERSONALIZED_OUTCOME_DEMAND.test(folded);
  const investment = investmentAdvice && !programmeOnlyInvestment;
  const legal = /\b(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered\b|\b(?:registration number|company number|legal entity|company status|legal status|he\s*382352)\b|مسجل|مسجلة|السجل التجاري|كيان قانوني|الوضع القانوني|حالة الشركة|εγγεγραμ|νομική οντότητα/iu.test(text);
  if (investment) return arabic
    ? "لا أستطيع تقديم معلومات عن الاستثمارات أو العوائد المالية أو النصائح المالية. يمكنني المساعدة بمعلومات أخرى معتمدة عن الشركة."
    : language === "greek" ? "Η REFAL δεν παρέχει επενδυτικές πληροφορίες, οικονομικές αποδόσεις ή οικονομικές συμβουλές. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco Group."
      : "REFAL cannot provide investment, financial-return, or financial-advice information. I can help with other approved Refalco Group information.";
  if (legal) return arabic
    ? "لا أقدم معلومات عن تسجيل الشركات أو الوضع القانوني لها. يمكنني المساعدة بمعلومات أخرى معتمدة عن الشركة."
    : language === "greek" ? "Η REFAL δεν παρέχει πληροφορίες για την εγγραφή ή το νομικό καθεστώς εταιρειών. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco Group."
      : "REFAL does not provide company registration or legal-status information. I can help with other approved Refalco Group information.";
  const safety = classifySafety(text);
  return safety.restricted ? safeLocalizedFallback(text, language) : null;
}

module.exports = { answerFromEvidence, knowledgeSourceRecords, knowledgeEvidenceMetadata, containsProhibitedClaim, containsProhibitedClaimLegacy, containsUnconditionalProhibition, containsPromptInjection, noApprovedEvidenceReply, restrictedRefalcoReply, isProgrammeEnquiry, allowsGroundedProgrammeAnswer };
