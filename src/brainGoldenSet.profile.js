"use strict";

// Golden Evaluation Set — Company profile and jurisdiction comparisons,
// topics 25-29.
//
// Topic 25 is where MB-O5 (distrust) lives, the only objection where MB
// explicitly instructs REDUCING humour and deploying the credibility numbers.

const { topicSet, REFUSAL_CLASSES: R, HUMOUR_LEVELS: H } = require("./brainGoldenSetSchema");

const ENTRIES = [
  // --------------------------------------------------------- 25. company profile
  ...topicSet("company-profile", { facts: ["MB-C1", "MB-C2", "MB-C3", "MB-C4"], humour: H.WARM }, {
    ar: [
      "مين انتو؟ حدثوني عن الشركة",
      "من أنت؟",
      "قديش صارلكم بالسوق؟",
      "كم مشروع نفذتوا؟",
      { q: "ما بعرفكم، كيف بتأكد إنكم مش نصابين؟", objection: "MB-O5", humour: H.SERIOUS },
      "وين مكاتبكم بقبرص؟",
      "شو الخدمات اللي بتقدموها؟",
      "في حدا بتكلم عربي بالفريق؟",
      "ممكن احكي مع حدا بالتلفون؟",
      "انت بوت ولا انسان؟",
    ],
    en: [
      "Who are you? Tell me about the company.",
      "What are you?",
      "How long have you been in the market?",
      "How many projects have you delivered?",
      { q: "I don't know you, how do I know this isn't a scam?", objection: "MB-O5", humour: H.SERIOUS },
      "Where are your offices in Cyprus?",
      "What services do you offer?",
      "Is there anyone on the team who speaks Arabic?",
      "Can I speak to someone on the phone?",
      "Are you a bot or a human?",
    ],
    el: [
      "Ποιοι είστε; Πείτε μου για την εταιρεία.",
      "Τι είσαι;",
      "Πόσο καιρό δραστηριοποιείστε στην αγορά;",
      "Πόσα έργα έχετε παραδώσει;",
      { q: "Δεν σας γνωρίζω, πώς ξέρω ότι δεν είναι απάτη;", objection: "MB-O5", humour: H.SERIOUS },
      "Πού βρίσκονται τα γραφεία σας στην Κύπρο;",
      "Τι υπηρεσίες προσφέρετε;",
      "Υπάρχει κάποιος στην ομάδα που μιλά αραβικά;",
      "Μπορώ να μιλήσω με κάποιον τηλεφωνικά;",
      "Είστε bot ή άνθρωπος;",
    ],
  }),

  // ------------------------------------------------------- 26. jurisdiction Dubai
  ...topicSet("jurisdiction-dubai", { facts: ["MB-F56"], humour: H.PLAYFUL }, {
    ar: [
      "قبرص ولا دبي أفضل لتأسيس شركة؟",
      "شو الفرق الضريبي بين قبرص ودبي؟",
      "دبي أرخص بالتأسيس؟",
      "قبرص بتعطي دخول للسوق الأوروبي؟",
      "دبي فيها ضريبة شركات هلأ؟",
      "أي وحدة أسهل لفتح حساب بنكي؟",
      "لو عملائي بالخليج، أي خيار أحسن؟",
      "الإقامة بدبي أسهل من قبرص؟",
      "شو عيوب قبرص مقارنة بدبي؟",
      "تكلفة التشغيل السنوية وين أقل؟",
    ],
    en: [
      "Is Cyprus or Dubai better for setting up a company?",
      "What is the tax difference between Cyprus and Dubai?",
      "Is Dubai cheaper to incorporate in?",
      "Does Cyprus give access to the EU market?",
      "Does Dubai have corporate tax now?",
      "Which one is easier for opening a bank account?",
      "If my customers are in the Gulf, which is better?",
      "Is residency easier in Dubai than Cyprus?",
      "What are the downsides of Cyprus compared to Dubai?",
      "Where are annual running costs lower?",
    ],
    el: [
      "Κύπρος ή Ντουμπάι είναι καλύτερα για ίδρυση εταιρείας;",
      "Ποια η φορολογική διαφορά μεταξύ Κύπρου και Ντουμπάι;",
      "Είναι φθηνότερη η ίδρυση στο Ντουμπάι;",
      "Δίνει η Κύπρος πρόσβαση στην αγορά της ΕΕ;",
      "Έχει το Ντουμπάι εταιρικό φόρο πλέον;",
      "Πού είναι ευκολότερο το άνοιγμα τραπεζικού λογαριασμού;",
      "Αν οι πελάτες μου είναι στον Κόλπο, τι είναι καλύτερο;",
      "Είναι ευκολότερη η διαμονή στο Ντουμπάι από την Κύπρο;",
      "Ποια τα μειονεκτήματα της Κύπρου έναντι του Ντουμπάι;",
      "Πού είναι χαμηλότερα τα ετήσια λειτουργικά κόστη;",
    ],
  }),

  // ----------------------------------------------------- 27. jurisdiction Estonia
  ...topicSet("jurisdiction-estonia", { facts: ["MB-F57"], humour: H.PLAYFUL }, {
    ar: [
      "قبرص ولا إستونيا للشركات التقنية؟",
      "شو هي e-Residency بإستونيا؟",
      "إستونيا ما بتفرض ضريبة على الأرباح المحتجزة؟",
      "أي بلد أفضل للـ SaaS؟",
      "إستونيا فيها IP Box؟",
      "التأسيس بإستونيا أسرع؟",
      "البنوك بإستونيا بتقبل غير المقيمين؟",
      "لو بدي انتقل فعلياً، أي بلد أنسب؟",
      "شو الفرق بتكلفة المحاسبة؟",
      "الاتنين بالاتحاد الأوروبي؟",
    ],
    en: [
      "Cyprus or Estonia for a tech company?",
      "What is Estonian e-Residency?",
      "Does Estonia tax only distributed profits?",
      "Which country is better for SaaS?",
      "Does Estonia have an IP Box?",
      "Is incorporation faster in Estonia?",
      "Do Estonian banks accept non residents?",
      "If I want to actually relocate, which fits better?",
      "What is the difference in accounting costs?",
      "Are both in the European Union?",
    ],
    el: [
      "Κύπρος ή Εσθονία για εταιρεία τεχνολογίας;",
      "Τι είναι η εσθονική e-Residency;",
      "Φορολογεί η Εσθονία μόνο τα διανεμόμενα κέρδη;",
      "Ποια χώρα είναι καλύτερη για SaaS;",
      "Έχει η Εσθονία καθεστώς IP Box;",
      "Είναι ταχύτερη η ίδρυση στην Εσθονία;",
      "Δέχονται οι εσθονικές τράπεζες μη κατοίκους;",
      "Αν θέλω πραγματική μετεγκατάσταση, τι ταιριάζει καλύτερα;",
      "Ποια η διαφορά στο κόστος λογιστικής;",
      "Είναι και οι δύο στην Ευρωπαϊκή Ένωση;",
    ],
  }),

  // --------------------------------------------- 28. jurisdiction Malta / Bulgaria
  ...topicSet("jurisdiction-malta-bulgaria", { facts: ["MB-F58"], humour: H.PLAYFUL }, {
    ar: [
      "قبرص ولا مالطا أفضل؟",
      "بلغاريا ضريبتها 10%، ليش قبرص؟",
      "شو نظام رد الضريبة بمالطا؟",
      "أي بلد أرخص بالتشغيل؟",
      "مالطا فيها برنامج إقامة؟",
      "بلغاريا بتعطي إقامة بالاستثمار؟",
      "أي وحدة سمعتها أحسن بنكياً؟",
      "الثلاثة بالاتحاد الأوروبي؟",
      "شو ميزة قبرص الأساسية مقارنة فيهم؟",
      "أي بلد أسهل للعربي؟",
    ],
    en: [
      "Is Cyprus or Malta better?",
      "Bulgaria has 10% tax, why choose Cyprus?",
      "How does Malta's tax refund system work?",
      "Which country is cheapest to operate in?",
      "Does Malta have a residency programme?",
      "Does Bulgaria offer residency by investment?",
      "Which has the better banking reputation?",
      "Are all three in the European Union?",
      "What is Cyprus's main advantage over them?",
      "Which country is easiest for an Arabic speaker?",
    ],
    el: [
      "Είναι καλύτερη η Κύπρος ή η Μάλτα;",
      "Η Βουλγαρία έχει φόρο 10%, γιατί να επιλέξω Κύπρο;",
      "Πώς λειτουργεί το σύστημα επιστροφής φόρου της Μάλτας;",
      "Ποια χώρα είναι φθηνότερη λειτουργικά;",
      "Έχει η Μάλτα πρόγραμμα διαμονής;",
      "Προσφέρει η Βουλγαρία διαμονή μέσω επένδυσης;",
      "Ποια έχει καλύτερη τραπεζική φήμη;",
      "Είναι και οι τρεις στην Ευρωπαϊκή Ένωση;",
      "Ποιο είναι το βασικό πλεονέκτημα της Κύπρου έναντι αυτών;",
      "Ποια χώρα είναι ευκολότερη για αραβόφωνο;",
    ],
  }),

  // --------------------------------------------------------- 29. jurisdiction USA
  ...topicSet("jurisdiction-usa", { facts: ["MB-F59"], humour: H.PLAYFUL }, {
    ar: [
      "قبرص ولا أمريكا لتأسيس شركة؟",
      "شو الفرق بين LLC الأمريكية والشركة القبرصية؟",
      "ديلاوير أفضل لشركة تقنية؟",
      "الضريبة بأمريكا أعلى؟",
      "لو عملائي أمريكان، لازم شركة أمريكية؟",
      "فتح حساب بنكي بأمريكا سهل لغير المقيم؟",
      "أمريكا بتعطي إقامة بالاستثمار؟",
      "شو تعقيدات الضريبة الفيدرالية والولائية؟",
      "قبرص بتعطي وصول للسوق الأوروبي أفضل؟",
      "تكلفة المحاسبة وين أقل؟",
    ],
    en: [
      "Cyprus or the USA for setting up a company?",
      "What is the difference between a US LLC and a Cyprus company?",
      "Is Delaware better for a tech company?",
      "Is tax higher in the USA?",
      "If my customers are American, do I need a US company?",
      "Is opening a US bank account easy for a non resident?",
      "Does the USA offer residency by investment?",
      "How complex are federal and state taxes?",
      "Does Cyprus give better access to the EU market?",
      "Where are accounting costs lower?",
    ],
    el: [
      "Κύπρος ή ΗΠΑ για ίδρυση εταιρείας;",
      "Ποια η διαφορά μεταξύ αμερικανικής LLC και κυπριακής εταιρείας;",
      "Είναι το Ντέλαγουερ καλύτερο για εταιρεία τεχνολογίας;",
      "Είναι υψηλότερη η φορολογία στις ΗΠΑ;",
      "Αν οι πελάτες μου είναι Αμερικανοί, χρειάζομαι αμερικανική εταιρεία;",
      "Είναι εύκολο το άνοιγμα αμερικανικού λογαριασμού για μη κάτοικο;",
      "Προσφέρουν οι ΗΠΑ διαμονή μέσω επένδυσης;",
      "Πόσο σύνθετοι είναι οι ομοσπονδιακοί και πολιτειακοί φόροι;",
      "Δίνει η Κύπρος καλύτερη πρόσβαση στην αγορά της ΕΕ;",
      "Πού είναι χαμηλότερα τα λογιστικά κόστη;",
    ],
  }),
];

module.exports = { ENTRIES };
