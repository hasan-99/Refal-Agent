"use strict";

// P5.1: deterministic, evidence-backed cross-sell hints. This module only
// selects a single optional hint; callers remain responsible for placing it
// after the customer's answer and for persisting the returned hook id.
const { detectMessageLanguage, foldArabicLetters } = require("./language");

const HOOKS = Object.freeze({
  H1_IP_BOX: {
    topics: ["ip-box"],
    hints: {
      en: "Since your activity involves software, Cyprus has an IP Box regime worth having a tax adviser review. It is not automatic for every company. Would you like to explore that?",
      ar: "بما إن نشاطك له علاقة بالبرمجيات، في نظام IP Box بقبرص ممكن نخلي مستشار ضريبي يراجعه معك. النظام مو تلقائي لكل شركة. بتحب نستكشفه؟",
      el: "Αφού η δραστηριότητά σας σχετίζεται με λογισμικό, υπάρχει στην Κύπρο το καθεστώς IP Box που αξίζει να εξετάσει φορολογικός σύμβουλος μαζί σας. Δεν εφαρμόζεται αυτόματα σε κάθε εταιρεία. Θα θέλατε να το διερευνήσουμε;"
    },
    matches: [
      /(?:\b(?:software|saas|app|application|dev(?:eloper|elopment)?|coding|programming|barmeje|tatweer|tatbi2|bermeje|barnemej|efarmogi|logismiko|saas)\b|λογισμικ|εφαρμογ|προγραμματισ|σοφτγουερ|برمجيات|تطبيق|مطور|تطوير|كود|برمجة)/iu
    ]
  },
  H2_RESIDENCY: {
    topics: ["permanent-residency"],
    hints: {
      en: "With the budget and non-EU connection you mentioned, Cyprus permanent residency may be relevant for you and your family. Would you like to look at the programme facts?",
      ar: "مع الميزانية ووضعك من خارج الاتحاد الأوروبي، ممكن يكون برنامج الإقامة الدائمة بقبرص مناسب إلك ولعيلتك. بتحب نراجع معلومات البرنامج؟",
      el: "Με τον προϋπολογισμό και τη σύνδεσή σας με χώρα εκτός ΕΕ, το πρόγραμμα μόνιμης διαμονής στην Κύπρο μπορεί να σας αφορά μαζί με την οικογένειά σας. Θα θέλατε να δούμε τα στοιχεία του προγράμματος;"
    },
    matches: [
      /(?:\b(?:non[- ]?eu|outside the eu|outside european union|non eu|bara\s+apo\s+ee|ektos\s+ee|ektos\s+evropaikis\s+enosis)\b|εκτός\s+(?:της\s+)?(?:ευρωπαϊκής\s+)?ένωσης|εκτος\s+(?:της\s+)?(?:ευρωπαικης\s+)?ενωσης|خارج\s+(?:الاتحاد\s+الأوروبي|الاتحاد\s+الاوروبي))/iu,
      /\b(?:300k|three hundred thousand)\b/iu
    ]
  },
  H3_RELOCATION: {
    topics: ["relocation-checklist", "non-dom-status", "gesy"],
    allTopicsRequired: true,
    hints: {
      en: "Since moving with family is on your mind, I can also outline international schools, GESY and the Non Dom programme, which may apply for up to 17 years. Which would help most?",
      ar: "بما إن الانتقال مع العيلة ببالك، فيني كمان أوضح موضوع المدارس الدولية وGESY وبرنامج Non Dom اللي ممكن ينطبق لمدة تصل لـ17 سنة. أي نقطة بتفيدك أكثر؟",
      el: "Αφού σκέφτεστε τη μετακόμιση με την οικογένεια, μπορώ επίσης να σας ενημερώσω για διεθνή σχολεία, το ΓεΣΥ και το πρόγραμμα Non Dom που μπορεί να ισχύει έως και 17 χρόνια. Τι θα σας βοηθούσε περισσότερο;"
    },
    matches: [
      /(?:\b(?:family|children|kids|school|housing|living|relocat\w*|mov(?:e|ing)|3ayle|3eyle|madras|sakan|metakomizo|oikogeneia|spiti|na2el|na2lo)\b|μετακόμ|οικογέν|σχολεί|στέγαση|διαμονή|عائلة|العيلة|أولاد|اولاد|مدارس|سكن|انتقل|ننتقل|نعيش|ننقل)/iu
    ]
  },
  H4_SUBSTANCE: {
    topics: ["virtual-office", "office-services", "substance"],
    hints: {
      en: "Since you want to move and work from Cyprus, office services and real business substance may be relevant. Would you like to explore that?",
      ar: "بما إنكم بدكم تنتقلوا وتشتغلوا فعلياً من قبرص، ممكن تكون خدمات المكاتب والتواجد الفعلي مرتبطة بخطتكم. بتحبوا نستكشف هالموضوع؟",
      el: "Αφού θέλετε να μετακομίσετε και να εργάζεστε πραγματικά από την Κύπρο, μπορεί να σας ενδιαφέρουν οι υπηρεσίες γραφείου και η πραγματική επιχειρηματική παρουσία. Θα θέλατε να το εξετάσουμε;"
    },
    matches: [
      /(?:\b(?:actually|really|physically)\b.{0,50}\b(?:move|work|live)\b.{0,50}\b(?:cyprus)\b|\b(?:move|relocate|work|live)\b.{0,50}\b(?:to|in|from)\s+cyprus\b|(?:na\s+)?(?:metakom|ergaz).{0,60}(?:kypro|kypros)|(?:να\s+)?(?:μετακομ|εργασ).{0,60}κύπρ|(?:ننتقل|انتقل|نشتغل|أشتغل|اشتغل).{0,60}قبرص|\b(?:baddi|badna)\s+(?:ne2dar\s+)?(?:ne2al|neshteghel).{0,60}cyprus\b)/iu
    ]
  },
  H5_TRADEMARK: {
    topics: ["trademark", "intellectual-property"],
    hints: {
      en: "Since you have a brand or product, Cyprus or EU trademark registration may be relevant. Have you considered protecting the brand?",
      ar: "بما إن عندك علامة أو منتج، ممكن يكون تسجيل علامة بقبرص أو الاتحاد الأوروبي مناسب. فكرت بحماية العلامة؟",
      el: "Αφού έχετε επωνυμία ή προϊόν, μπορεί να σας αφορά η καταχώριση εμπορικού σήματος στην Κύπρο ή στην ΕΕ. Έχετε σκεφτεί την προστασία της επωνυμίας;"
    },
    matches: [
      /(?:\b(?:brand|trademark|trade mark|product|new app|emporiko\s+sima|marka|proion|efarmogi)\b|επωνυμ|μάρκα|προϊόν|бренд|ماركة|علامة|منتج|تطبيق\s+جديد)/iu
    ]
  },
  H6_PR_TO_PROPERTY: {
    topics: ["property-categories", "residential-property", "permanent-residency"],
    hints: {
      en: "For a permanent-residency investment, a new Category A residential property may be one option to discuss. Would you like to explore the property route?",
      ar: "إذا كان استثمار الإقامة الدائمة هدفك، ممكن يكون العقار السكني الجديد من الفئة A خيار للنقاش. بتحب نستكشف مسار العقار؟",
      el: "Αν ο στόχος σας είναι η επένδυση για μόνιμη διαμονή, ένα νέο οικιστικό ακίνητο Κατηγορίας Α μπορεί να είναι μία επιλογή προς συζήτηση. Θα θέλατε να εξετάσουμε τη διαδρομή του ακινήτου;"
    },
    matches: [
      /(?:\b(?:permanent\s+residency|residency\s+investment|residency|monimi\s+diamoni)\b|μόνιμ[αήηος]*\s+διαμον|επένδυση\s+.*διαμον|إقامة\s+دائمة|الإقامة|الاقامة|اقامة)/iu,
      /(?:\b(?:budget|invest\w*|clear\s+option|clear\s+investment\s+option|estir|masary)\b|επένδυ|προϋπολογισ|ميزانية|استثمر|استثمار|خيار\s+واضح)/iu
    ]
  }
});

const DECLINE_EN = /\b(?:no\s+thanks|not\s+interested|don't\s+offer|do\s+not\s+offer|stop\s+selling|no\s+more)\b/iu;
const DECLINE_AR = /(?:لا\s*شكراً|لا\s*شكرا|مو\s*مهتم|مش\s*مهتم|ما\s*بدي|بلا\s*عروض)/u;
const DECLINE_EL = /(?:όχι\s*ευχαριστώ|δεν\s*ενδιαφέρομαι|σταματήστε)/iu;

function isDecline(text, language) {
  if (DECLINE_EN.test(text)) return true;
  if (language === "arabic") return DECLINE_AR.test(foldArabicLetters(text));
  if (language === "greek") return DECLINE_EL.test(text);
  // Code-switched and short messages can be misclassified; check localized
  // opt-out phrases independently so they cannot be bypassed by another script.
  return DECLINE_AR.test(foldArabicLetters(text)) || DECLINE_EL.test(text);
}

function normalizeDigits(text) {
  return String(text).replace(/[٠-٩۰-۹]/gu, (digit) => {
    const code = digit.codePointAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function hasResidencyBudget(text) {
  const normalized = normalizeDigits(text);
  const amountPattern = /(?<!\w)\d[\d\s.,٬،]*(?!\w)/gu;
  const budgetContext = /\b(?:budget|invest\w*|financial\s+capacity|300k|three\s+hundred\s+thousand)\b|ميزاني|استثمار|استثمر|مبلغ|προϋπολογ|επένδ|ποσό/iu;
  const currency = /€|\beur(?:o)?\b|ευρώ|يورو/iu;
  const contextualized = (index, length) => {
    const prefix = normalized.slice(Math.max(0, index - 40), index);
    const anchors = [...prefix.matchAll(new RegExp(budgetContext.source, `${budgetContext.flags}g`))];
    const lastAnchor = anchors.at(-1);
    const budgetBefore = lastAnchor && !/\d/u.test(prefix.slice(lastAnchor.index + lastAnchor[0].length));
    const before = normalized.slice(Math.max(0, index - 8), index);
    const after = normalized.slice(index + length, index + length + 8);
    const currencyAttached = /€\s*$|\b(?:eur|euro)\s*$/iu.test(before) || /^\s*(?:€|\b(?:eur|euro)\b)/iu.test(after) ||
      /(?:ευρώ|يورو)\s*$/iu.test(before) || /^\s*(?:ευρώ|يورو)/iu.test(after);
    return Boolean(budgetBefore || currencyAttached);
  };
  for (const match of normalized.matchAll(/\b(\d+(?:[.,]\d+)?)\s*k\b/giu)) {
    if (Number(match[1].replace(",", ".")) * 1000 < 300000) continue;
    if (contextualized(match.index, match[0].length)) return true;
  }
  for (const match of normalized.matchAll(amountPattern)) {
    if (Number(match[0].replace(/\D/gu, "")) < 300000) continue;
    if (contextualized(match.index, match[0].length)) return true;
  }
  if (/three\s+hundred\s+thousand/iu.test(normalized) && budgetContext.test(normalized)) return true;
  return false;
}

function currentApproved(item, now) {
  if (!item || item.review_status !== "approved") return false;
  if (item.valid_until == null || item.valid_until === "") return true;
  const expires = Date.parse(item.valid_until);
  return Number.isFinite(expires) && expires > now;
}

function evidenceForHook(items, hook, now) {
  const validItems = (Array.isArray(items) ? items : []).filter((item) => {
    if (!currentApproved(item, now)) return false;
    const metadata = [item.topic, item.sourceRef, item.source_ref, item.title, item.section, item.content]
      .filter(Boolean).join(" ").toLowerCase();
    const topical = hook.topics.some((topic) => metadata.includes(topic));
    if (!topical) return false;
    if (hook === HOOKS.H1_IP_BOX) {
      const content = String(item.content || "").toLowerCase();
      const namesIpBox = /ip\s*box|آي\s*بي\s*بوكس/iu.test(content);
      const saysNotAutomatic = /not\s+automatic|مو\s+تلقائي|غير\s+تلقائي|δεν\s+εφαρμόζεται\s+αυτόματα/iu.test(content);
      return namesIpBox && saysNotAutomatic;
    }
    return true;
  });
  if (hook.allTopicsRequired) {
    return hook.topics.every((topic) => validItems.some((item) => {
      const metadata = [item.topic, item.sourceRef, item.source_ref, item.title, item.section, item.content]
        .filter(Boolean).join(" ").toLowerCase();
      if (!metadata.includes(topic)) return false;
      const content = normalizeDigits(String(item.content || "")).toLowerCase();
      if (topic === "relocation-checklist") return /school|مدارس|σχολ/u.test(content);
      if (topic === "gesy") return /gesy|γεσυ|جيسي|healths*care|رعايةs*صحية/u.test(content);
      if (topic === "non-dom-status") return /non[ -]?dom|نونs*دوم|17\s*(?:years?|χρόν|سن|عام)/u.test(content);
      return false;
    }));
  }
  return validItems.length > 0;
}

function matchesResidencyTrigger(text) {
  return HOOKS.H2_RESIDENCY.matches[0].test(text) && hasResidencyBudget(text);
}

function selectSalesHook({
  message = "", language, humourLevel = 0, answer = "", questionAnswered = false,
  declined = false, previouslyOfferedHooks = [], informational = false,
  complaint = false, sensitive = false, evidence = [], now = Date.now()
} = {}) {
  const text = String(message || "").normalize("NFKC");
  const detectedLanguage = String(language || detectMessageLanguage(text)).toLowerCase();
  const resolvedLanguage = detectedLanguage.startsWith("ar") ? "ar"
    : detectedLanguage.startsWith("el") || detectedLanguage.includes("greek") ? "el" : "en";
  if (!questionAnswered || !String(answer || "").trim()) return null;
  if (Number(humourLevel) <= 0 || Number(humourLevel) > 3) return null;
  if (declined || isDecline(text, resolvedLanguage) || informational || complaint || sensitive) return null;

  const offered = new Set(Array.isArray(previouslyOfferedHooks) ? previouslyOfferedHooks : []);
  for (const [id, hook] of Object.entries(HOOKS)) {
    if (offered.has(id)) continue;
    if (id === "H3_RELOCATION" && ![1, 2].includes(Number(humourLevel))) continue;
    if (id === "H2_RESIDENCY" ? !matchesResidencyTrigger(text) : !hook.matches.every((pattern) => pattern.test(text))) continue;
    if (!evidenceForHook(evidence, hook, Number(now))) continue;
    return { id, phrase: hook.hints[resolvedLanguage] || hook.hints.en };
  }
  return null;
}

module.exports = { HOOKS, selectSalesHook };
