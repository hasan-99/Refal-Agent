"use strict";

// Evidence-based scorer for P6.1. Kept separate from leadQualification.js so
// existing callers retain their legacy contract until the integration phase.
const SCORER_VERSION = "qualification-engine-v1";
const { createHash } = require("node:crypto");
const DIMENSIONS = Object.freeze(["need", "value", "timing", "authority", "readiness", "fit"]);

// Each dimension has explicit language anchors. Scores are derived from the
// customer's words; callers cannot submit a score or dimension map.
const ANCHORS = Object.freeze({
  need: [
    /\b(?:need|require|looking for|want to|plan to)\b|أحتاج|احتاج|أريد|اريد|أبحث عن|χρειάζομαι|θέλω|ψάχνω/iu,
    /\b(?:need|looking for|plan to)\b[^.!?]{0,55}\b(?:company|property|project|development|accounting|residency|service)\b|(?:أحتاج|أبحث عن)[^.!؟]{0,55}(?:شركة|عقار|مشروع|خدمة)|(?:χρειάζομαι|ψάχνω)[^.!?]{0,55}(?:εταιρεί|ακίνητ|έργο|υπηρεσί)/iu,
    /\b(?:actively looking|seeking support|need help with)\b|أبحث بجدية|أحتاج مساعدة|χρειάζομαι υποστήριξη/iu,
    /\b(?:specific requirement|defined project|for my business)\b|مشروع محدد|احتياج واضح|συγκεκριμένο έργο/iu,
    /\b(?:cannot proceed without|critical need|must resolve)\b|لا أستطيع المتابعة دون|حاجة ملحة|δεν μπορώ να προχωρήσω χωρίς/iu
  ],
  value: [
    /\b(?:budget|funding|capital|investment|investor|portfolio|million|€\s?\d|eur\s?\d)\b|ميزانية|تمويل|رأس المال|استثمار|مستثمر|مليون|€\s?\d|κεφάλαιο|χρηματοδότηση|επένδυση|επενδυτής|εκατομμύριο/iu,
    /\b(?:approved|secured|available)\s+(?:funding|capital|budget)\b|تمويل\s+(?:جاهز|مؤكد)|رأس\s+مال\s+متاح|εγκεκριμένη\s+χρηματοδότηση|εγκεκριμένο\s+κεφάλαιο|διαθέσιμο\s+κεφάλαιο/iu,
    /\b(?:budget of|allocated)\s+(?:€|eur|\$)?\s?\d|ميزانية قدرها|διαθέσιμο ποσό/iu,
    /\b(?:funds are ready|funding is secured|capital is committed)\b|التمويل جاهز|رأس المال مؤكد|η χρηματοδότηση είναι εξασφαλισμένη/iu,
    /\b(?:proof of funds|bank-confirmed funding|committed investment)\b|إثبات التمويل|استثمار مؤكد|επιβεβαιωμένη χρηματοδότηση/iu
  ],
  timing: [
    /\b(?:soon|this week|this month|urgent|asap|by\s+(?:\w+day|\w+\s+\d{1,2}))\b|قريبًا|قريبا|هذا الأسبوع|هذا الشهر|عاجل|بأسرع وقت|άμεσα|αυτή την εβδομάδα|αυτόν τον μήνα|επείγον/iu,
    /\b(?:today|tomorrow|deadline|starting immediately|ready now)\b|اليوم|غدًا|غدا|موعد نهائي|جاهز الآن|σήμερα|αύριο|προθεσμία|έτοιμος τώρα/iu,
    /\b(?:within \d+ days|by next week|this month)\b|خلال \d+ أيام|بحلول الأسبوع القادم|αυτή την εβδομάδα/iu,
    /\b(?:deadline is|must start by|time-sensitive)\b|الموعد النهائي|يجب أن أبدأ قبل|επείγουσα προθεσμία/iu,
    /\b(?:must complete by|fixed completion date|immediate deadline)\b|يجب الإنجاز قبل|موعد نهائي فوري|καταληκτική ημερομηνία/iu
  ],
  authority: [
    /\b(?:i am|i'm)\s+(?:the\s+)?(?:owner|founder|director|decision maker|partner)\b|\bi\s+own\s+(?:a\s+|the\s+)?(?:company|business)\b|\b(?:my|our)\s+(?:company|business)\b|أنا\s+(?:المالك|المؤسس|المدير|صاحب القرار)|ιδιοκτήτης|ιδρύτρια|ιδρυτής|διευθυντής|αποφασίζω/iu,
    /\b(?:i|we)\s+(?:decide|will decide|can approve|have authority)\b|أنا\s+صاحب\s+القرار|أستطيع\s+الموافقة|αποφασίζω|έχω\s+την\s+αρμοδιότητα/iu,
    /\b(?:sole owner|final decision maker|i approve the budget)\b|المالك الوحيد|صاحب القرار النهائي|εγώ εγκρίνω τον προϋπολογισμό/iu,
    /\b(?:authorized signatory|board-approved|mandated to represent)\b|مفوض بالتوقيع|موافقة مجلس الإدارة|εξουσιοδοτημένος εκπρόσωπος/iu,
    /\b(?:signed mandate|formal authority to commit)\b|تفويض رسمي|صلاحية الالتزام|επίσημη εξουσιοδότηση/iu
  ],
  readiness: [
    /\b(?:ready to|want to start|proceed|move forward|book|schedule|send the documents)\b|جاهز ل|أريد أن أبدأ|لنبدأ|أتابع|احجز|أرسل المستندات|έτοιμος να|θέλω να ξεκινήσω|να προχωρήσουμε|κλείσω ραντεβού/iu,
    /\b(?:today|now|immediately)\b[^.!?]{0,40}\b(?:start|proceed|book|sign)\b|ابدأ\s+الآن|نبدأ\s+اليوم|να\s+ξεκινήσουμε\s+τώρα/iu,
    /\b(?:documents are ready|ready to book|let's proceed)\b|المستندات جاهزة|جاهز للحجز|ας προχωρήσουμε/iu,
    /\b(?:please send the contract|can sign today|start the process)\b|أرسلوا العقد|أستطيع التوقيع اليوم|να ξεκινήσουμε τη διαδικασία/iu,
    /\b(?:signed|submitted|payment arranged)\b|وقعت|تم التقديم|تم ترتيب الدفع|έχω υπογράψει|έχω υποβάλει/iu
  ],
  fit: [
    /\b(?:company formation|business expansion|real estate|property development|construction|investment project|corporate services)\b|تأسيس شركة|توسع تجاري|عقارات|تطوير عقاري|إنشاء|مشروع استثماري|خدمات شركات|ίδρυση εταιρεί|επιχειρηματική επέκταση|ακίνητ|ανάπτυξη ακινήτ|κατασκευή|επενδυτικό έργο/iu,
    /\b(?:land for development|construction tender|strategic partnership|joint venture)\b|أرض للتطوير|مناقصة إنشاء|شراكة استراتيجية|مشروع مشترك|γη για ανάπτυξη|κατασκευαστικός διαγωνισμός|στρατηγική συνεργασία/iu,
    /\b(?:commercial project|corporate expansion|property acquisition)\b|مشروع تجاري|توسع شركة|شراء عقار|εμπορικό έργο|εταιρική επέκταση/iu,
    /\b(?:Cyprus company|Cyprus property|Cyprus development)\b|شركة في قبرص|عقار في قبرص|تطوير في قبرص|εταιρεία στην Κύπρο|ακίνητο στην Κύπρο/iu,
    /\b(?:large-scale development|institutional project|multi-unit construction)\b|تطوير واسع النطاق|مشروع مؤسسي|κατασκευή μεγάλης κλίμακας/iu
  ]
});

function meaningfulText(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return text.length >= 3 ? text : "";
}

function removeTraitClauses(text) {
  // Strip only the trait clause itself. A comma may join an independent
  // commercial assertion (“I speak Arabic, and I am ready to proceed”), so
  // preserve everything after that boundary.
  const conjunction = String.raw`\s+(?:and|but|while|also)\s+(?=(?:i|we|my|our|the company|funding|the project)\b)`;
  return String(text)
    .replace(new RegExp(String.raw`\b(?:my name is|i am called|i speak|my language is|i am from|i'm from|nationality is|born in)\b[^,.!?;؟；。]*?(?=[,.!?;؟；。]|${conjunction}|$)`, "giu"), " ")
    .replace(/(?:اسمي|أتحدث|اتحدث|لغتي|أنا من|جنسيتي|ولدت في)[^,.!?;؟；。]*?(?=[،,.!?;؟；。]|\s+(?:لكن|ولكن|بينما)\s+(?=(?:أنا|نحن|تمويل|المشروع)(?=\s|$))|$)/giu, " ")
    .replace(/(?:ονομάζομαι|μιλώ|η γλώσσα μου|είμαι από|η εθνικότητά μου)[^,.!?;؟；。]*?(?=[,.!?;؟；。]|\s+(?:και|αλλά|ενώ)\s+(?=(?:εγώ|εμείς|η εταιρεία|χρηματοδότηση)(?=\s|$))|$)/giu, " ")
    .replace(/\s+/gu, " ").trim();
}

function isNegatedMatch(text, index) {
  const before = text.slice(0, index);
  const boundary = Math.max(-1, ...[".", "!", "?", ";", "؟", "；", "。", ",", "،", "，", " but ", " yet ", " however ", " لكن ", "ولكن", " بس ", " بل ", " אלא ", " αλλά ", " όμως "]
    .map((separator) => { const index = before.lastIndexOf(separator); return index < 0 ? -1 : index + separator.length; }));
  const prefix = before.slice(boundary < 0 ? 0 : boundary);
  return /(?:\b(?:not|never|don't|do not|doesn't|didn't|can't|cannot|no)\b[^.!?;؟；。]{0,35}|(?:لا|ما|مش|مو|ليس|لم|لن)[^.!?;؟；。]{0,35}|(?:δεν|μη|όχι)[^.!?;؟；。]{0,35})\s*$/iu.test(prefix);
}

function hasAffirmativeMatch(pattern, text) {
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  for (const match of text.matchAll(matcher)) {
    if (!isNegatedMatch(text, match.index)) return true;
  }
  return false;
}

function containsScoringEvidence(text) {
  const candidate = removeTraitClauses(text);
  return DIMENSIONS.some((dimension) => ANCHORS[dimension].some((pattern) => hasAffirmativeMatch(pattern, candidate)));
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set();
  return evidence.flatMap((item) => {
    const text = meaningfulText(item?.text ?? item?.message);
    const sourceRef = String(item?.sourceRef ?? item?.source_ref ?? "").trim().slice(0, 200);
    if (!text || !sourceRef || !containsScoringEvidence(text)) return [];
    // A caller-provided sourceRef is an unverified trace label, never evidence
    // of authorship or authority. Scores come only from the sanitized text.
    const key = `${sourceRef}\u0000${text}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ text, sourceRef }];
  }).sort((a, b) => `${a.sourceRef}\u0000${a.text}`.localeCompare(`${b.sourceRef}\u0000${b.text}`));
}

function scoreEvidence(evidence) {
  const scores = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  const references = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []]));
  for (const item of evidence) {
    const text = removeTraitClauses(item.text);
    if (!text) continue;
    for (const dimension of DIMENSIONS) {
      const patterns = ANCHORS[dimension];
      let anchor = 0;
      for (let index = 0; index < patterns.length; index += 1) {
        if (hasAffirmativeMatch(patterns[index], text)) anchor = index + 1;
      }
      if (anchor > 0) {
        if (!references[dimension].includes(item.sourceRef)) references[dimension].push(item.sourceRef);
        // Strength comes from the explicit rubric pattern that matched, not
        // from how many caller-labeled references repeat the same assertion.
        scores[dimension] = Math.max(scores[dimension], anchor);
      }
    }
  }
  for (const dimension of DIMENSIONS) references[dimension].sort();
  return { scores, references };
}

function fingerprint(evidence) {
  const canonical = JSON.stringify(evidence.map(({ sourceRef, text }) => [sourceRef, text]).sort((a, b) => `${a[0]}\u0000${a[1]}`.localeCompare(`${b[0]}\u0000${b[1]}`)));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Score customer-authored evidence. Evidence items require a stable sourceRef
 * (for example `turn:12`); caller-supplied dimensions/scores are ignored.
 * `previous` may be the prior result to avoid recomputation for identical
 * meaningful evidence. `now` is injectable for deterministic tests.
 */
function scoreQualification({ evidence = [], previous = null, now = new Date() } = {}) {
  const normalized = normalizeEvidence(evidence);
  const evidenceFingerprint = fingerprint(normalized);
  if (previous?.scorerVersion === SCORER_VERSION && previous?.evidenceFingerprint === evidenceFingerprint) {
    return { ...previous, recomputed: false };
  }
  const { scores, references } = scoreEvidence(normalized);
  const total = DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0);
  const scoredAt = new Date(now).toISOString();
  const rationale = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, {
    anchorStrength: scores[dimension],
    evidenceRefs: [...references[dimension]]
  }]));
  const sourceTurnId = normalized[0]?.sourceRef || null;
  return {
    dimensions: scores,
    evidenceReferences: references,
    evidenceRefs: references,
    rationale,
    total,
    max: 30,
    scorerVersion: SCORER_VERSION,
    scoredAt,
    assessedAt: scoredAt,
    evidenceFingerprint,
    meaningfulEvidenceHash: evidenceFingerprint,
    sourceTurnId,
    recomputed: true
  };
}

module.exports = { DIMENSIONS, SCORER_VERSION, scoreQualification };
