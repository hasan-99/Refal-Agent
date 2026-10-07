const { detectMessageLanguage } = require("./language");
const { SAFETY_CATEGORIES, classifySafety, safeLocalizedFallback } = require("./safetyPolicy");

function answerFromEvidence(evidence, { allowPricing = false, customerQuestion = "" } = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const asksWhetherPriceIsCurrent = /\b(?:still\s+(?:the\s+)?current|currently\s+(?:valid|accurate)|is\s+(?:this|that|the\s+price)\s+still|up[- ]to[- ]date|current\s+(?:price|fee|package))\b|(?:لسا|ما زال|هل السعر الحالي|السعر لسا|صالح لحد الآن)|(?:ισχύει ακόμη|είναι ακόμη σε ισχύ|τρέχουσα τιμή)/iu.test(customerQuestion);
  const isPriceEvidence = (item) => /(?:[$€£]\s?[\d٠-٩]|\b(?:EUR|USD|GBP)\s?[\d٠-٩]|\b[\d٠-٩][\d٠-٩,.]*\s?(?:EUR|USD|GBP|euros?|dollars?|pounds?)\b|(?:fee|price|package|باقة|السعر|رسوم).{0,40}[\d٠-٩])/iu.test(String(item?.content || ""));
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
    !/(?:what services does|what does refalco offer|شو خدمات ريفالكو|ما هي الخدمات التي تقدمها|بدي اسجل شركة|طلب عن تأسيس الشركة|retrieval\s+query|search\s+query|customer\s+question|user\s+query)/iu.test(sentence)
  );
  const excerpt = sentences
    .filter((sentence) => allowPricing || !/(?:[$€£]\s?[\d٠-٩]|\b(?:EUR|USD|GBP)\s?[\d٠-٩]|\b[\d٠-٩][\d٠-٩,.]*\s?(?:EUR|USD|GBP|euros?|dollars?|pounds?)\b|(?:fee|price|package|باقة|السعر|رسوم(?:\s+التأسيس)?).{0,40}[\d٠-٩]|[\d٠-٩].{0,25}(?:يورو|دولار|جنيه))/iu.test(sentence))
    .join(" ").trim();
  if (!excerpt || containsProhibitedClaim(excerpt) || containsPromptInjection(excerpt)) return null;
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
  const priceClaim = /(?:[$€£]\s?[\d٠-٩]|\b(?:EUR|USD|GBP)\s?[\d٠-٩]|\b[\d٠-٩][\d٠-٩,.]*\s?(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه)\b)/iu;
  const unsafeExample = /^(?:❌|wrong\b|incorrect\b|خطأ\b)|(?:لا تقول|do not say|don['’]t say|μην πείτε)/iu;
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
  "the", "and", "for", "with", "from", "that", "this", "what", "which", "where", "when", "does", "will", "would", "can", "could", "should", "have", "about", "tell", "please", "help", "need", "want", "you", "your", "company", "refalco", "refal", "information", "info", "more",
  "ال", "في", "من", "على", "عن", "شو", "كيف", "وين", "متى", "هل", "ممكن", "بدي", "عندي", "عنا", "ما", "هي", "هو", "مع", "الى", "إلى", "ريفالكو", "ريفال", "الخدمات", "خدمات", "معلومات",
  "και", "για", "από", "στο", "στη", "στην", "το", "τα", "της", "των", "τι", "πώς", "πού", "πότε", "είναι", "μπορεί", "μπορώ", "θέλω", "πληροφορίες", "refalco"
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

function containsProhibitedClaim(text) {
  const answerText = String(text || "").replace(/https?:\/\/\S+/giu, "[source]");
  const claimText = removeSafeDisclaimerClauses(answerText);
  const unsupportedSuitability = /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b|\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b|(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|مؤهل|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu;
  return unsupportedSuitability.test(claimText) || /\b(?:investment\s+(?:returns?|roi|irr|yield|advice|recommendations?)|(?:returns?|roi|irr|yield|profits?)\b.{0,60}\binvest\w*|(?:returns?|roi|irr|yield)\s+(?:on|from)\s+(?:an?\s+)?investment|financial advice|(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered|registration number|company number|legal status|legal entity|legal advice|tax advice|immigration advice|visa|residency|bank approval|loan approval|mortgage approval|permit|licen[cs]e|government approval|company approval)\b|(?:عوائد|عائد|ربح|أرباح)\s+(?:الاستثمار|استثماري)|(?:استثمار|استثماري)\s+(?:بعائد|بعوائد|مربح|مضمون)|استشارة استثمارية|الشركة\s+(?:مسجلة|مسجل)\s+(?:في|بقبرص)|السجل التجاري|الوضع القانوني|كيان قانوني|استشارة قانونية|استشارة ضريبية|معدل الضريبة|نسبة الضريبة|هجرة|تأشيرة|إقامة|موافقة البنك|قرض|رهن|رخصة|ترخيص|موافقة حكومية|(?:ستحصل|سيحصل|سيتم منحك).{0,35}(?:الموافقة|موافقة|رخصة|ترخيص)|επενδυτικ(?:ές|ή)\s+αποδόσεις|απόδοση\s+(?:επένδυσης|επενδυτική)|επενδυτική\s+συμβουλή|νομική συμβουλή|φορολογική συμβουλή|εταιρεία\s+(?:είναι\s+)?εγγεγραμμένη|νομική οντότητα|βίζα|διαμονή|έγκριση τράπεζας|δάνειο|άδεια|κρατική έγκριση|θα εγκριθεί.{0,40}(?:άδεια|έγκριση)|θα (?:πάρω|λάβω).{0,40}(?:άδεια|έγκριση)/iu.test(claimText);
}

// Exempt only complete, narrowly worded disclaimer clauses. Splitting at
// sentence/semicolon boundaries means an affirmative neighboring clause is
// still checked by the normal prohibited-claim rules.
function removeSafeDisclaimerClauses(text) {
  const safeDisclaimer = /^(?:i|we|refalco)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:provide|give|offer)\s+(?:personalized\s+|personalised\s+)?(?:tax|legal|immigration|investment|financial)\s+advice(?:\s+or\s+confirm\s+(?:a\s+)?tax\s+result)?[.!;]?$/iu;
  const safeLegalStatusDisclaimer = /^(?:refalco|i|we)\s+(?:do not|don['’]t|does not|doesn['’]t)\s+provide\s+(?:information\s+about\s+)?(?:company\s+registration\s+or\s+)?legal[- ]status(?:\s+information)?[.!]?$/iu;
  const safeOutcomeDisclaimer = /^(?:i|we|refalco)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:guarantee|confirm|promise)\s+(?:that\s+)?(?:bank\s+approval|financing|a\s+loan outcome|a\s+tax result|a\s+permit(?:\s+(?:or\s+)?(?:licen[cs]e|planning))? outcome|(?:a\s+)?licen[cs]e outcome|(?:investment\s+)?returns?)(?:\s*;?\s*the\s+(?:bank|relevant authority)\s+decides)?[.!;]?$/iu;
  const safeEnglishRegulatoryUncertainty = /^(?:i|we|refalco)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:confirm|determine|verify)\s+(?:whether|if)\s+.{0,100}\b(?:permit|licen[cs]e|eligible|eligibility|approved|approval|regulated|tax result)\b[.!?]?$/iu;
  const safeArabic = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تقديم|إعطاء)\s+(?:نصيحة|استشارة)\s+(?:ضريبية|قانونية|مالية|استثمارية)(?: شخصية)?(?:\s+أو\s+تأكيد\s+نتيجة ضريبية)?[.!؟]?$/u;
  const safeArabicOutcome = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|ضمان)\s+(?:نتيجة (?:الرخصة|التصريح|التخطيط|ضريبية)|(?:نتيجة )?موافقة البنك|الحصول على (?:رخصة|تصريح)|عوائد الاستثمار|نتيجة الرخصة أو التصريح أو التخطيط)(?:\s*؛?\s*(?:البنك|الجهة المختصة)\s+(?:هو من يقرر|تقرر))?[.!؟]?$/u;
  const safeArabicLegalStatus = /^لا\s+(?:أقدم|أوفر|أستطيع تقديم)\s+معلومات\s+عن\s+(?:تسجيل الشركات|الوضع القانوني|السجل التجاري)(?:\s+أو\s+(?:الوضع القانوني|تسجيل الشركات))?(?:\s+لها)?[.!؟]?$/u;
  const safeArabicRegulatoryUncertainty = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|أكد|تحديد|أتحقق)\s+(?:إذا|إن كان|ما إذا)?\s*.{0,100}(?:ترخيص|رخصة|مؤهل|مقبول|معتمد|خاضع للتنظيم|نتيجة ضريبية)[.!؟]?$/u;
  const safeGreek = /^(?:δεν μπορώ|δεν μπορούμε|η refalco δεν μπορεί)\s+να\s+(?:παρέχω|παρέχουμε|παρέχει|δώσω|δώσουμε)\s+(?:εξατομικευμένη\s+)?(?:φορολογική|νομική|μεταναστευτική|επενδυτική|οικονομική)\s+συμβουλή(?:\s+ή\s+να\s+επιβεβαιώσω\s+φορολογικό\s+αποτέλεσμα)?[.!;]?$/iu;
  const safeGreekOutcome = /^(?:δεν μπορώ|δεν μπορούμε|η refalco δεν μπορεί)\s+να\s+(?:εγγυηθώ|εγγυηθούμε|εγγυηθεί|επιβεβαιώσω|επιβεβαιώσουμε)\s+(?:την\s+)?(?:έγκριση τράπεζας|τραπεζική έγκριση|χρηματοδότηση|δάνειο|φορολογικό αποτέλεσμα|αποτέλεσμα (?:άδειας|πολεοδομικής έγκρισης)|αποτέλεσμα για άδεια ή πολεοδομική έγκριση|απόδοση επένδυσης)(?:\s*,?\s*(?:χρηματοδότηση|ή\s+δάνειο))?(?:\s*;?\s*η\s+(?:τράπεζα|αρμόδια αρχή)\s+αποφασίζει)?[.!;]?$/iu;
  const safeGreekBankGuarantee = /^δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο[.!;]?$/iu;
  const safeGreekRegulatoryUncertainty = /^δεν μπορώ να (?:επιβεβαιώσω|καθορίσω|επαληθεύσω)\s+(?:αν|εάν)\s+.{0,100}(?:άδεια|έγκριση|επιλέξιμη|ρυθμιζόμενη|φορολογικό αποτέλεσμα)[.!;]?$/iu;
  return String(text || "").split(/(?<=[.!?؟;；])\s+/u).filter((clause) => {
    const value = clause.trim();
    return !(safeDisclaimer.test(value) || safeLegalStatusDisclaimer.test(value) || safeOutcomeDisclaimer.test(value) || safeEnglishRegulatoryUncertainty.test(value) || safeArabic.test(value) || safeArabicOutcome.test(value) || safeArabicLegalStatus.test(value) || safeArabicRegulatoryUncertainty.test(value) || safeGreek.test(value) || safeGreekOutcome.test(value) || safeGreekBankGuarantee.test(value) || safeGreekRegulatoryUncertainty.test(value));
  }).join(" ");
}

function restrictedRefalcoReply(text) {
  const language = detectMessageLanguage(text);
  const arabic = language === "arabic";
  const investment = /\b(?:investment\s+(?:advice|recommendations?|returns?|opportunities?)|financial advice|roi|irr|returns?|yield|profit guarantee)\b|استشارة استثمارية|نصيحة مالية|توصية استثمارية|عوائد (?:مضمونة|متوقعة)|العائد (?:المتوقع|المضمون)|عوائد الاستثمارية|عوائد استثمارية|ربح مضمون|επενδυτική συμβουλή|οικονομική συμβουλή|εγγυημένη απόδοση|κέρδος/iu.test(text);
  const legal = /\b(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered\b|\b(?:registration number|company number|legal entity|company status|legal status|he\s*382352)\b|مسجل|مسجلة|السجل التجاري|كيان قانوني|الوضع القانوني|حالة الشركة|εγγεγραμ|νομική οντότητα/iu.test(text);
  if (investment) return arabic
    ? "لا أستطيع تقديم معلومات عن الاستثمارات أو العوائد المالية أو النصائح المالية. يمكنني المساعدة بمعلومات أخرى معتمدة عن ريفالكو."
    : language === "greek" ? "Η REFAL δεν παρέχει επενδυτικές πληροφορίες, οικονομικές αποδόσεις ή οικονομικές συμβουλές. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco."
      : "REFAL cannot provide investment, financial-return, or financial-advice information. I can help with other approved Refalco information.";
  if (legal) return arabic
    ? "لا أقدم معلومات عن تسجيل الشركات أو الوضع القانوني لها. يمكنني المساعدة بمعلومات أخرى معتمدة عن ريفالكو."
    : language === "greek" ? "Η REFAL δεν παρέχει πληροφορίες για την εγγραφή ή το νομικό καθεστώς εταιρειών. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco."
      : "REFAL does not provide company registration or legal-status information. I can help with other approved Refalco information.";
  const safety = classifySafety(text);
  return safety.restricted ? safeLocalizedFallback(text, language) : null;
}

module.exports = { answerFromEvidence, knowledgeSourceRecords, knowledgeEvidenceMetadata, containsProhibitedClaim, containsPromptInjection, noApprovedEvidenceReply, restrictedRefalcoReply };
