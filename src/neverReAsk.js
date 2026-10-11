// P8.3 deterministic pre-send guard. Memories only suppress a repeat question
// when the value is customer-stated (legacy strings came only from the
// saveCustomerFact tool, which enforces that provenance) or a sufficiently
// confident, provenance-bearing CRM record. Inferred or conflicting values
// never suppress clarification.

const FIELD_QUESTIONS = Object.freeze({
  countryOfResidence: /\b(?:which|what)\s+(?:country|country of residence)\b|\bwhere\s+(?:do you|are you)\s+(?:live|living|based)\b|(?:أي|ما)\s*(?:بلد|دولة)\s*(?:إقامتك|تقيم|تعيش)|أين\s*(?:تقيم|تعيش)|(?:من\s+أي\s+بلد|وين\s+(?:ساكن|عايش)|بأي\s+بلد)\s*(?:أنت|تقيم|تعيش)?|σε\s+ποια\s+χώρα\s+(?:μέν|κατοικ)|πού\s+(?:μέν|κατοικ)|από\s+ποια\s+χώρα\s+(?:είστε|κατάγεστε)|ποια\s+είναι\s+η\s+χώρα\s+διαμονής\s+σας/iu,
  investmentBudget: /\b(?:what(?:'s| is)\s+)?(?:your\s+)?(?:investment\s+)?budget\b|\bhow\s+much\s+(?:are you planning|would you like to invest)\b|(?:ما|كم)\s*(?:هي\s*)?(?:ميزانيتك|المبلغ الذي تريد استثماره)|كم\s*(?:تريد|تنوي|ناوي)\s*(?:أن\s*)?تستثمر|قديش\s*(?:ميزانيتك|ناوي\s+تستثمر)|(?:ποιος|ποιο)\s+(?:είναι\s+)?(?:ο\s+)?(?:προϋπολογισμός|ποσό)\s+(?:σας|επένδυσης)|πόσα\s+(?:θέλετε|σκοπεύετε)\s+να\s+επενδύσετε|τι\s+προϋπολογισμό\s+έχετε|πόσα\s+σκοπεύετε\s+να\s+διαθέσετε/iu,
  familyMembers: /\b(?:how many|number of)\s+(?:family members|people in your family|dependants|dependents)\b|\b(?:do you have|will you bring)\s+(?:a\s+)?family\b|(?:كم\s*(?:عدد\s*)?(?:أفراد|أشخاص|فرداً|أشخاصاً)\s*(?:عائلتك|أسرتك)|كم\s*(?:عدد\s*)?فرد.{0,20}(?:عائلتك|أسرتك)|هل\s*(?:لديك|معك|عندك)\s*عائلة)|πόσα\s+μέλη\s+(?:έχει|έχει\s+η)\s+(?:η\s+)?οικογένειά\s+σας|θα\s+μετακινηθεί\s+η\s+οικογένειά\s+σας|έχετε\s+οικογένεια|πόσα\s+άτομα\s+θα\s+μετακινηθούν\s+μαζί\s+σας/iu,
  businessActivity: /\b(?:what|which)\s+(?:is|will be)\s+(?:your|the company'?s)\s+(?:business\s+)?activit(?:y|ies)\b|\bwhat\s+is\s+your\s+company'?s\s+(?:business\s+)?activit(?:y|ies)\b|\bwhat\s+does\s+(?:your\s+)?company\s+do\b|(?:ما|شو)\s*(?:هو\s*)?(?:نشاطك|نشاط الشركة)|بماذا\s*(?:تعمل|ستعمل)\s*الشركة|(?:ما|شو)\s*(?:طبيعة|نوع)\s*(?:نشاطك|نشاط الشركة|عمل الشركة)|ποια\s+είναι\s+η\s+δραστηριότητα\s+(?:της\s+εταιρείας|σας)|τι\s+δραστηριότητα\s+θα\s+έχει\s+η\s+εταιρεία|τι\s+κάνει\s+η\s+εταιρεία|με\s+τι\s+ασχολείται\s+η\s+εταιρεία/iu,
  targetMarkets: /\b(?:which|what)\s+(?:target\s+)?markets\b|\bwhere\s+(?:will|do)\s+you\s+(?:operate|sell|trade)\b|(?:أي|ما)\s*(?:ال)?أسواق\s*(?:تستهدف|مستهدفة|تريد)|في\s*أي\s*أسواق\s*(?:ستعمل|تعمل)|أي\s*(?:دول|بلدان)\s*(?:تستهدف|تعمل)|σε\s+ποιες\s+αγορές\s+(?:στοχεύετε|θα\s+δραστηριοποιηθείτε)|πού\s+θα\s+δραστηριοποιηθείτε|ποιες\s+χώρες\s+στοχεύετε/iu,
  timeline: /\b(?:when|what(?:'s| is) your timeline|by when|how soon)\b|\b(?:when do you|when would you)\s+(?:want|plan|need)\b|متى\s*(?:تريد|تخطط|تحتاج|بتخطط|ناوي)|ما\s*(?:هو\s*)?(?:الإطار الزمني|الجدول الزمني)|خلال\s*متى|πότε\s+(?:θέλετε|σκοπεύετε|χρειάζεστε)|ποιο\s+είναι\s+το\s+χρονοδιάγραμμά\s+σας|πότε\s+σκοπεύετε\s+να\s+ξεκινήσετε|πότε\s+θέλετε\s+να\s+αρχίσουμε/iu
});

function trustedKnownValue(record) {
  if (typeof record === "string" || typeof record === "number") return String(record).trim() ? { present: true } : null;
  if (!record || typeof record !== "object" || record.conflict === true || record.correctionNeeded === true || record.inferred === true) return null;
  const value = record.normalizedValue ?? record.value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!String(value).trim()) return null;
  if (record.provenance && record.provenance !== "customer_message") return null;
  if (record.confidence != null && (!Number.isFinite(Number(record.confidence)) || Number(record.confidence) < 0.8)) return null;
  return { present: true };
}

function findRepeatedQuestion(text, knownFacts = {}) {
  const draft = String(text || "");
  const findings = [];
  const factsByCanonicalName = new Map(Object.entries(knownFacts && typeof knownFacts === "object" ? knownFacts : {})
    .map(([field, value]) => [field.toLocaleLowerCase(), value]));
  for (const [field, pattern] of Object.entries(FIELD_QUESTIONS)) {
    if (!trustedKnownValue(factsByCanonicalName.get(field.toLocaleLowerCase()))) continue;
    if (pattern.test(draft)) findings.push(field);
  }
  return findings;
}

module.exports = { FIELD_QUESTIONS, trustedKnownValue, findRepeatedQuestion };
