const { detectObjection } = require("./objectionWorkflow");
const { classifyEvidence, seedRegister } = require("./factRegister");
const { profile, describeCount } = require("./companyProfile");

const CREDIBILITY_FACTS = Object.freeze(["MB-C1", "MB-C2", "MB-C3", "MB-C4"]);

const TEXT = Object.freeze({
  en: {
    O1: (items) => items ? `I understand. What offer are you comparing it with? We can compare the current package inclusions: ${items}.` : "I understand. What offer are you comparing it with? I can check the current package inclusions before comparing.",
    O2: (items) => items ? `That is useful to compare. Does the €500 offer include the same items, such as ${items}, and a stated annual commitment?` : "That is useful to compare. Does the €500 offer include the same package items and a stated annual commitment?",
    O3: "Of course, take the time you need. Is there one point you would like clarified before deciding?",
    O4: "I can send a focused summary on WhatsApp. Which one topic would be most useful right now?",
    O5: (facts) => facts ? `It is reasonable to want reassurance. ${facts} I can also arrange a direct call before you take any step; would that help?` : "It is reasonable to want reassurance. I can share approved company information or arrange a direct call before you take any step; would a direct call help?"
  },
  ar: {
    O1: (items) => items ? `مفهوم. مع أي عرض تقارنه؟ يمكننا مقارنة المكونات الحالية للباقة: ${items}.` : "مفهوم. مع أي عرض تقارنه؟ يمكنني التحقق من المكونات الحالية للباقة قبل المقارنة.",
    O2: (items) => items ? `من المفيد المقارنة. هل يشمل عرض €500 المكونات نفسها، مثل ${items}، والتزاماً سنوياً موضحاً؟` : "من المفيد المقارنة. هل يشمل عرض €500 مكونات الباقة نفسها والتزاماً سنوياً موضحاً؟",
    O3: "أكيد، خذ وقتك. هل هناك نقطة واحدة تحب أن أوضحها قبل أن تقرر؟",
    O4: "أقدر أرسل لك ملخصاً مركزاً على واتساب. ما الموضوع الواحد الأكثر فائدة لك الآن؟",
    O5: (facts) => facts ? `من حقك أن تطمئن. ${facts} ويمكنني ترتيب مكالمة مباشرة قبل أي خطوة؛ هل يناسبك ذلك؟` : "من حقك أن تطمئن. أستطيع مشاركة معلومات الشركة المعتمدة أو ترتيب مكالمة مباشرة قبل أي خطوة؛ هل تناسبك مكالمة مباشرة؟"
  },
  el: {
    O1: (items) => items ? `Κατανοητό. Με ποια προσφορά το συγκρίνετε; Μπορούμε να συγκρίνουμε τα τρέχοντα στοιχεία του πακέτου: ${items}.` : "Κατανοητό. Με ποια προσφορά το συγκρίνετε; Μπορώ πρώτα να ελέγξω τα τρέχοντα στοιχεία του πακέτου.",
    O2: (items) => items ? `Είναι χρήσιμο να γίνει σύγκριση. Περιλαμβάνει η προσφορά των €500 τα ίδια στοιχεία, όπως ${items}, και σαφή ετήσια δέσμευση;` : "Είναι χρήσιμο να γίνει σύγκριση. Περιλαμβάνει η προσφορά των €500 τα ίδια στοιχεία του πακέτου και σαφή ετήσια δέσμευση;",
    O3: "Βεβαίως, πάρτε τον χρόνο σας. Υπάρχει ένα σημείο που θα θέλατε να διευκρινίσω πριν αποφασίσετε;",
    O4: "Μπορώ να σας στείλω μια σύντομη περίληψη στο WhatsApp. Ποιο ένα θέμα θα ήταν πιο χρήσιμο τώρα;",
    O5: (facts) => facts ? `Είναι εύλογο να θέλετε διαβεβαίωση. ${facts} Μπορώ επίσης να κανονίσω απευθείας κλήση πριν από οποιοδήποτε βήμα· θα σας βοηθούσε;` : "Είναι εύλογο να θέλετε διαβεβαίωση. Μπορώ να μοιραστώ εγκεκριμένες πληροφορίες για την εταιρεία ή να κανονίσω απευθείας κλήση πριν από οποιοδήποτε βήμα· θα σας βοηθούσε μια κλήση;"
  }
});

function identifyObjection(text = "") {
  const value = String(text);
  if (/(?:€\s*500|500\s*(?:euro|ευρώ|يورو)|found.{0,20}(?:offer|price)|لقيت.{0,20}500|βρήκα.{0,20}500)/iu.test(value)) return "O2";
  if (/(?:€\s*999|999\s*(?:euro|ευρώ|يورو)|too expensive|feels expensive|price.{0,20}expensive|غالي|مكلف|ακριβό|ακριβά)/iu.test(value)) return "O1";
  if (/(?:think about it|need to think|let me think|need some time|بدي أفكر|أفكر بالموضوع|να το σκεφτώ|να το σκεφτώ λίγο)/iu.test(value)) return "O3";
  if (/(?:everything|all the details|كل التفاصيل|كل شي|τα πάντα|όλες τις πληροφορίες).{0,35}(?:whatsapp|واتساب|whats ?app)/iu.test(value)
    || /(?:whatsapp|واتساب|whats ?app).{0,35}(?:everything|all|كل|τα πάντα|όλες)/iu.test(value)) return "O4";
  if (detectObjection(value).categories.includes("trust")) return "O5";
  return null;
}

function currentInclusions(offers, now = new Date()) {
  if (!Array.isArray(offers)) return null;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;
  const current = offers.find((offer) => {
    const effective = Date.parse(offer?.effectiveDate);
    const verified = Date.parse(offer?.verifiedAt);
    const updated = Date.parse(offer?.lastUpdated);
    const until = Date.parse(offer?.validUntil);
    return offer?.kind === "offers" && offer?.active === true && offer?.reviewStatus === "approved"
    && offer?.provenance === "approved_live_edge_data" && [effective, verified, updated, until].every(Number.isFinite)
    && effective <= nowMs && verified <= nowMs && updated <= nowMs && effective < until && nowMs < until && Array.isArray(offer.inclusions)
    && offer.inclusions.length > 0 && offer.inclusions.every((item) => typeof item === "string" && item.trim());
  });
  return current ? current.inclusions.slice(0, 8).map((item) => item.trim()).join(", ") : null;
}

function renderCredibilityEvidence(chunks, { register, now, language } = {}) {
  if (!Array.isArray(chunks) || !register) return "";
  const classified = classifyEvidence(chunks, { register, now, lang: language });
  const nowMs = new Date(now || Date.now()).getTime();
  const allowed = new Set(classified.statable.filter((id) => {
    if (!CREDIBILITY_FACTS.includes(id) || !Number.isFinite(nowMs)) return false;
    const row = register.get(id);
    const verifiedAt = Date.parse(row?.verifiedAt);
    return row?.status === "approved" && typeof row.reviewer === "string" && row.reviewer.trim().length > 0
      && Number.isFinite(verifiedAt) && verifiedAt <= nowMs && typeof row.claimText === "string" && row.claimText.trim().length > 0;
  }));
  if (!allowed.size) return "";
  const lang = language || "en";
  const rendered = {
    en: {
      "MB-C1": `Refalco has operational roots in Cyprus dating to ${profile.foundedYear}.`,
      "MB-C2": `Refalco has ${describeCount("yearsExperience")} years of field experience.`,
      "MB-C3": `Refalco has delivered ${describeCount("developmentProjects")} real estate development projects.`,
      "MB-C4": `Refalco has delivered ${describeCount("totalProjects")} multi sector projects.`
    },
    ar: {
      "MB-C1": `لدى Refalco جذور تشغيلية في قبرص منذ عام ${profile.foundedYear}.`,
      "MB-C2": `لدى Refalco خبرة ميدانية تبلغ ${describeCount("yearsExperience")} عاماً.`,
      "MB-C3": `أنجزت Refalco ${describeCount("developmentProjects")} مشروعاً للتطوير العقاري.`,
      "MB-C4": `أنجزت Refalco ${describeCount("totalProjects")} مشروعاً في قطاعات متعددة.`
    },
    el: {
      "MB-C1": `Η Refalco δραστηριοποιείται στην Κύπρο από το ${profile.foundedYear}.`,
      "MB-C2": `Η Refalco έχει ${describeCount("yearsExperience")} χρόνια εμπειρίας στον κλάδο.`,
      "MB-C3": `Η Refalco έχει ολοκληρώσει ${describeCount("developmentProjects")} έργα ανάπτυξης ακινήτων.`,
      "MB-C4": `Η Refalco έχει ολοκληρώσει ${describeCount("totalProjects")} έργα σε πολλούς τομείς.`
    }
  }[lang] || null;
  if (!rendered) return "";
  return CREDIBILITY_FACTS.filter((id) => allowed.has(id)).map((id) => rendered[id]).join(" ");
}

function objectionMatrix({ text = "", language = "en", offers, now = new Date(), credibilityEvidence = [], factRegister, humourLevel = 2 } = {}) {
  const objection = identifyObjection(text);
  if (!objection) return { objection: null, response: null, humourLevel, safe: true };
  const lang = String(language).toLowerCase().slice(0, 2);
  const copy = TEXT[lang] || TEXT.en;
  const inclusions = (objection === "O1" || objection === "O2") ? currentInclusions(offers, now) : null;
  const factEvidence = objection === "O5"
    ? renderCredibilityEvidence(credibilityEvidence, { register: factRegister, now, language: lang }) : "";
  const renderer = copy[objection];
  const response = typeof renderer === "function" ? renderer(objection === "O1" || objection === "O2" ? inclusions : factEvidence) : renderer;
  const effectiveHumourLevel = objection === "O5" ? Math.min(Number(humourLevel) || 0, 1) : humourLevel;
  return { objection, response, humourLevel: effectiveHumourLevel, inclusionsAvailable: inclusions !== null, safe: true };
}

module.exports = { identifyObjection, currentInclusions, renderCredibilityEvidence, objectionMatrix };
