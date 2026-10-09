"use strict";

// Golden Evaluation Set — Real estate, development and legal, topics 19-24.

const { topicSet, REFUSAL_CLASSES: R, HUMOUR_LEVELS: H } = require("./brainGoldenSetSchema");

const ENTRIES = [
  // ------------------------------------------------- 19. property buyer journey
  // MB-F45 is the ten stage journey, MB-F50 the absolute reservation deposit
  // guardrail: never guess or state a deposit amount, it comes from the live
  // property database.
  ...topicSet("property-buyer-journey", {
    facts: ["MB-F45"], hook: "MB-X3", humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F45"],              // 1. the steps to buy
      ["MB-F45"],              // 2. can a foreigner buy
      ["MB-F45"],              // 3. fees at purchase
      ["MB-F45"],              // 4. title transfer duration
      ["MB-F45"],              // 5. do I need a lawyer
      ["MB-F45"],              // 6. the sale contract and its registration
      ["MB-F45", "MB-F50"],    // 7. is there a reservation deposit
      ["MB-F50"],              // 8. exactly how much is it (personalized)
      ["MB-F45"],              // 9. buying in the company's name
      ["MB-F45"],              // 10. my budget is 350k, what next
    ],
  }, {
    ar: [
      "شو خطوات شراء عقار بقبرص؟",
      "كأجنبي، بقدر اشتري عقار؟",
      "شو الرسوم عند الشراء؟",
      "قديش بياخد وقت نقل الملكية؟",
      "بحتاج محامي للشراء؟",
      "شو يعني عقد البيع وتسجيله؟",
      "في عربون عند الحجز؟",
      { q: "قديش العربون بالضبط؟", refusal: R.PERSONALIZED, facts: ["MB-F50"] },
      "ممكن اشتري باسم الشركة بدل اسمي؟",
      "ميزانيتي حوالي 350 ألف يورو، شو بتنصحوني؟",
    ],
    en: [
      "What are the steps to buy property in Cyprus?",
      "As a foreigner, can I buy property?",
      "What fees apply at purchase?",
      "How long does the title transfer take?",
      "Do I need a lawyer for the purchase?",
      "What is the sale contract and its registration?",
      "Is there a reservation deposit?",
      { q: "Exactly how much is the reservation deposit?", refusal: R.PERSONALIZED, facts: ["MB-F50"] },
      "Can I buy in the company's name instead of my own?",
      "My budget is around 350,000 euro, what would you suggest?",
    ],
    el: [
      "Ποια είναι τα βήματα για αγορά ακινήτου στην Κύπρο;",
      "Ως αλλοδαπός, μπορώ να αγοράσω ακίνητο;",
      "Ποια τέλη ισχύουν κατά την αγορά;",
      "Πόσο διαρκεί η μεταβίβαση τίτλου;",
      "Χρειάζομαι δικηγόρο για την αγορά;",
      "Τι είναι το συμβόλαιο πώλησης και η κατάθεσή του;",
      "Υπάρχει προκαταβολή κράτησης;",
      { q: "Πόσο ακριβώς είναι η προκαταβολή κράτησης;", refusal: R.PERSONALIZED, facts: ["MB-F50"] },
      "Μπορώ να αγοράσω στο όνομα της εταιρείας αντί στο δικό μου;",
      "Ο προϋπολογισμός μου είναι περίπου 350.000 ευρώ, τι θα προτείνατε;",
    ],
  }),

  // ------------------------------------------------------ 20. offplan vs completed
  // MB-F46 completed property (a home or fast rental yield), MB-F47 off plan
  // (easier payment plan, future delivery date).
  ...topicSet("offplan-vs-completed", {
    facts: ["MB-F46", "MB-F47"], humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F46", "MB-F47"],    // 1. what is the difference
      ["MB-F46", "MB-F47"],    // 2. which is better for residency
      ["MB-F47"],              // 3. risks of off plan
      ["MB-F47"],              // 4. payment structure under construction
      ["MB-F47"],              // 5. first sale from the developer
      ["MB-F47"],              // 6. when do I get the keys
      ["MB-F46", "MB-F47"],    // 7. will the price rise (guarantee)
      ["MB-F47"],              // 8. construction warranty
      ["MB-F47"],              // 9. developer delays delivery
      ["MB-F46"],              // 10. is completed usually dearer
    ],
  }, {
    ar: [
      "شو الفرق بين عقار على الخارطة وجاهز؟",
      "أيهما أفضل للإقامة الدائمة؟",
      "شو مخاطر الشراء على الخارطة؟",
      "كيف بتكون الدفعات بالعقار قيد الإنشاء؟",
      "شو يعني البيع الأول من المطور؟",
      "متى بستلم المفتاح؟",
      { q: "سعر العقار رح يرتفع خلال سنتين؟", refusal: R.GUARANTEE, humour: H.WARM },
      "في ضمان على البناء؟",
      "لو تأخر المطور بالتسليم شو بصير؟",
      "العقار الجاهز أغلى عادةً؟",
    ],
    en: [
      "What is the difference between off plan and completed property?",
      "Which is better for permanent residency?",
      "What are the risks of buying off plan?",
      "How are the payments structured for a property under construction?",
      "What does first sale from the developer mean?",
      "When do I get the keys?",
      { q: "Will the property price go up over the next two years?", refusal: R.GUARANTEE, humour: H.WARM },
      "Is there a warranty on the construction?",
      "What happens if the developer delays delivery?",
      "Is completed property usually more expensive?",
    ],
    el: [
      "Ποια η διαφορά μεταξύ ακινήτου υπό κατασκευή και έτοιμου;",
      "Ποιο είναι καλύτερο για μόνιμη διαμονή;",
      "Ποιοι είναι οι κίνδυνοι αγοράς υπό κατασκευή;",
      "Πώς διαρθρώνονται οι πληρωμές σε ακίνητο υπό κατασκευή;",
      "Τι σημαίνει πρώτη πώληση από τον κατασκευαστή;",
      "Πότε παραλαμβάνω τα κλειδιά;",
      { q: "Θα ανέβει η τιμή του ακινήτου τα επόμενα δύο χρόνια;", refusal: R.GUARANTEE, humour: H.WARM },
      "Υπάρχει εγγύηση στην κατασκευή;",
      "Τι γίνεται αν ο κατασκευαστής καθυστερήσει την παράδοση;",
      "Είναι συνήθως ακριβότερο το έτοιμο ακίνητο;",
    ],
  }),

  // ------------------------------------------------------------- 21. property VAT
  // MB-F48 is the 19% base and the conditional 5% reduced rate, MB-F49 the
  // boundary: the team calculates it precisely, no loose generic numbers.
  ...topicSet("property-vat", {
    facts: ["MB-F48"], humour: H.WARM,
    factsByIndex: [
      ["MB-F48"],              // 1. is there VAT on buying
      ["MB-F48"],              // 2. what is the rate
      ["MB-F48"],              // 3. reduced rate for a first home
      ["MB-F48", "MB-F49"],    // 4. conditions for the reduced rate
      ["MB-F48", "MB-F49"],    // 5. buying in the company's name
      ["MB-F48"],              // 6. VAT on resale property
      ["MB-F48", "MB-F49"],    // 7. VAT on land
      ["MB-F48", "MB-F49"],    // 8. will I definitely qualify (guarantee)
      ["MB-F49"],              // 9. transfer fees on top
      ["MB-F48", "MB-F49"],    // 10. is the 300k inclusive of VAT
    ],
  }, {
    ar: [
      "في ضريبة قيمة مضافة على شراء العقار؟",
      "قديش نسبة الـVAT على العقار؟",
      "في نسبة مخفضة للسكن الأول؟",
      "شو شروط الـVAT المخفض؟",
      "لو اشتريت باسم الشركة، شو بتغير بالـVAT؟",
      "العقار المستعمل عليه VAT؟",
      "الأرض عليها ضريبة قيمة مضافة؟",
      { q: "رح اتأهل للنسبة المخفضة أكيد؟", refusal: R.GUARANTEE, humour: H.WARM },
      "في رسوم نقل ملكية غير الـVAT؟",
      "الـ300 ألف للإقامة شاملة الـVAT؟",
    ],
    en: [
      "Is there VAT on buying property?",
      "What is the VAT rate on property?",
      "Is there a reduced rate for a first home?",
      "What are the conditions for reduced VAT?",
      "If I buy in the company's name, what changes for VAT?",
      "Does resale property carry VAT?",
      "Is there VAT on land?",
      { q: "Will I definitely qualify for the reduced rate?", refusal: R.GUARANTEE, humour: H.WARM },
      "Are there transfer fees on top of VAT?",
      "Is the 300,000 for residency inclusive of VAT?",
    ],
    el: [
      "Υπάρχει ΦΠΑ στην αγορά ακινήτου;",
      "Ποιος είναι ο συντελεστής ΦΠΑ στα ακίνητα;",
      "Υπάρχει μειωμένος συντελεστής για πρώτη κατοικία;",
      "Ποιες είναι οι προϋποθέσεις για μειωμένο ΦΠΑ;",
      "Αν αγοράσω στο όνομα της εταιρείας, τι αλλάζει στον ΦΠΑ;",
      "Έχει ΦΠΑ η μεταπώληση ακινήτου;",
      "Υπάρχει ΦΠΑ στη γη;",
      { q: "Θα δικαιούμαι σίγουρα τον μειωμένο συντελεστή;", refusal: R.GUARANTEE, humour: H.WARM },
      "Υπάρχουν τέλη μεταβίβασης πέρα από τον ΦΠΑ;",
      "Οι 300.000 για τη διαμονή περιλαμβάνουν ΦΠΑ;",
    ],
  }),

  // ------------------------------------------------------------ 22. Cyprus cities
  // MB-F51 Limassol, MB-F52 Larnaca, MB-F53 Paphos, MB-F54 Nicosia. MB-F55 is
  // the ROI boundary: refuse the invented yield, ask for budget and area, and
  // say plainly that nobody can guarantee a future price.
  ...topicSet("cyprus-cities", {
    facts: ["MB-F51", "MB-F52", "MB-F53", "MB-F54"], humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F51", "MB-F52", "MB-F53", "MB-F54", "MB-F55"],  // 1. best city to invest in
      ["MB-F51", "MB-F52"],                                // 2. Limassol vs Larnaca
      ["MB-F52", "MB-F53", "MB-F54"],                      // 3. cheapest place to live
      ["MB-F53"],                                          // 4. is Paphos good for families
      ["MB-F54"],                                          // 5. does Nicosia have a coast
      ["MB-F51", "MB-F54"],                                // 6. where business is concentrated
      ["MB-F52"],                                          // 7. closest to the airport
      ["MB-F51", "MB-F52", "MB-F53", "MB-F54", "MB-F55"],  // 8. do prices differ by city
      ["MB-F51", "MB-F52", "MB-F53", "MB-F54"],            // 9. where the international schools are
      ["MB-F51", "MB-F52", "MB-F53", "MB-F54"],            // 10. Ayia Napa, outside the four
    ],
  }, {
    ar: [
      "أي مدينة أفضل للاستثمار العقاري؟",
      "شو الفرق بين ليماسول ولارنكا؟",
      "وين أرخص مكان للسكن؟",
      "بافوس مناسبة للعائلات؟",
      "نيقوسيا فيها بحر؟",
      "وين بتتركز الشركات والأعمال؟",
      "أي مدينة الأقرب للمطار؟",
      "في فرق بأسعار العقارات بين المدن؟",
      "وين في مدارس دولية؟",
      "أيا نابا للسكن الدائم كيف؟",
    ],
    en: [
      "Which city is best for property investment?",
      "What is the difference between Limassol and Larnaca?",
      "Where is the cheapest place to live?",
      "Is Paphos suitable for families?",
      "Does Nicosia have a coastline?",
      "Where are most businesses concentrated?",
      "Which city is closest to the airport?",
      "Do property prices differ much between cities?",
      "Where are the international schools?",
      "What is Ayia Napa like for permanent living?",
    ],
    el: [
      "Ποια πόλη είναι καλύτερη για επένδυση σε ακίνητα;",
      "Ποια η διαφορά μεταξύ Λεμεσού και Λάρνακας;",
      "Πού είναι φθηνότερα να ζει κανείς;",
      "Είναι η Πάφος κατάλληλη για οικογένειες;",
      "Έχει η Λευκωσία παραλία;",
      "Πού συγκεντρώνονται οι περισσότερες επιχειρήσεις;",
      "Ποια πόλη είναι πιο κοντά στο αεροδρόμιο;",
      "Διαφέρουν πολύ οι τιμές ακινήτων μεταξύ πόλεων;",
      "Πού βρίσκονται τα διεθνή σχολεία;",
      "Πώς είναι η Αγία Νάπα για μόνιμη διαμονή;",
    ],
  }),

  // --------------------------------------------- 23. landowners and construction
  // MB-F56 the millions-at-stake silent filter, MB-F57 the landowner JV
  // indicators, MB-F58 REFAL's land questions (location, area, building
  // density, existing permits), MB-F59 the escalation to the development team.
  // MB-F60..MB-F62 cover construction tenders, which these ten questions do not
  // reach: see FIX-28 notes.
  ...topicSet("landowners-and-construction", {
    facts: ["MB-F56"], humour: H.WARM,
    factsByIndex: [
      ["MB-F56", "MB-F57", "MB-F58"],  // 1. I own land, what are my options
      ["MB-F58"],                      // 2. which permits are required
      ["MB-F58"],                      // 3. what planning permission means
      ["MB-F58"],                      // 4. how long permits take
      ["MB-F57", "MB-F59"],            // 5. the joint development agreement
      ["MB-F57", "MB-F58", "MB-F59"],  // 6. partnering a developer with my land
      ["MB-F58", "MB-F59"],            // 7. guarantee the building permit
      ["MB-F58"],                      // 8. permitted building density
      ["MB-F56"],                      // 9. tax on developing land
      ["MB-F56"],                      // 10. do I need a Cyprus company
      ["MB-F60"],                      // 11. we need a contractor / we have a tender
      ["MB-F61"],                      // 12. the four tender questions (BOQ, plans)
      ["MB-F62"],                      // 13. give me a ballpark price (boundary)
    ],
  }, {
    ar: [
      "عندي أرض بقبرص، شو خياراتي للتطوير؟",
      "شو رخص البناء المطلوبة؟",
      "شو يعني رخصة تخطيط؟",
      "قديش بتاخد وقت الرخص؟",
      "شو هو عقد المشاركة بالتطوير؟",
      "ممكن اشارك مطور بأرضي؟",
      { q: "بتضمنولي الحصول على رخصة البناء؟", refusal: R.GUARANTEE, humour: H.SERIOUS },
      "شو معامل البناء المسموح؟",
      "في ضريبة على تطوير الأرض؟",
      "بحتاج شركة قبرصية للتطوير؟",
      "نحتاج مقاول رئيسي لمشروع كبير بقبرص، بتتعاملوا مع مناقصات إنشائية؟",
      "عندنا مناقصة إنشائية والمخططات المعمارية و BOQ جاهزين، شو بتحتاجوا منا؟",
      { q: "ممكن تعطونا أسعار مبدئية أو تقديرات أولية قبل ما نرسل المناقصة؟", refusal: R.PERSONALIZED, humour: H.SERIOUS },
    ],
    en: [
      "I own land in Cyprus, what are my development options?",
      "What building permits are required?",
      "What does planning permission mean?",
      "How long do the permits take?",
      "What is a joint development agreement?",
      "Can I partner with a developer using my land?",
      { q: "Can you guarantee I will get the building permit?", refusal: R.GUARANTEE, humour: H.SERIOUS },
      "What is the permitted building density?",
      "Is there tax on developing land?",
      "Do I need a Cyprus company to develop?",
      "We need a main contractor for a large project in Cyprus, is this something your group handles?",
      "We are tendering a large build and the architectural plans and BOQ are ready, what do you need from us?",
      { q: "Can you share rough prices or preliminary estimates for the tender before we go to the next stage?", refusal: R.PERSONALIZED, humour: H.SERIOUS },
    ],
    el: [
      "Έχω γη στην Κύπρο, ποιες είναι οι επιλογές ανάπτυξης;",
      "Ποιες οικοδομικές άδειες απαιτούνται;",
      "Τι σημαίνει πολεοδομική άδεια;",
      "Πόσο διαρκούν οι άδειες;",
      "Τι είναι η συμφωνία κοινής ανάπτυξης;",
      "Μπορώ να συνεργαστώ με κατασκευαστή με τη γη μου;",
      { q: "Μπορείτε να εγγυηθείτε ότι θα πάρω την οικοδομική άδεια;", refusal: R.GUARANTEE, humour: H.SERIOUS },
      "Ποιος είναι ο επιτρεπόμενος συντελεστής δόμησης;",
      "Υπάρχει φόρος στην ανάπτυξη γης;",
      "Χρειάζομαι κυπριακή εταιρεία για την ανάπτυξη;",
      "Χρειαζόμαστε εργολάβο για μεγάλο έργο στην Κύπρο, αναλαμβάνετε τέτοια έργα;",
      "Έχουμε κατασκευαστικό διαγωνισμό με αρχιτεκτονικά σχέδια και BOQ, τι χρειάζεστε από εμάς;",
      { q: "Μπορείτε να μου δώσετε μια χονδρική τιμή ή μια προκαταρκτική εκτίμηση για τον διαγωνισμό;", refusal: R.PERSONALIZED, humour: H.SERIOUS },
    ],
  }),

  // ------------------------------------------------------- 24. legal, IP, contracts
  // MB-F63 trademarks (CY and EU), MB-F64 shareholders agreements, MB-F65
  // service / development / employment agreements, MB-F66 T&Cs and GDPR.
  ...topicSet("legal-ip-contracts", {
    facts: ["MB-F63"], hook: "MB-X6", humour: H.WARM,
    factsByIndex: [
      ["MB-F63"],              // 1. how to register a trademark
      ["MB-F63"],              // 2. does it protect across Europe
      ["MB-F63"],              // 3. company registration vs brand registration
      ["MB-F63"],              // 4. what a trademark costs
      ["MB-F63", "MB-F66"],    // 5. new brand: trademark plus T&Cs / GDPR
      ["MB-F65"],              // 6. employment contracts for staff
      ["MB-F64"],              // 7. review my partnership agreement
      ["MB-F64", "MB-F65"],    // 8. is this binding in my case (personalized)
      ["MB-F63", "MB-F65"],    // 9. IP rights in software
      ["MB-F63"],              // 10. industrial design protection
    ],
  }, {
    ar: [
      "كيف بسجل علامة تجارية بقبرص؟",
      "العلامة التجارية بتحمي بكل أوروبا؟",
      "شو الفرق بين تسجيل الشركة وتسجيل البراند؟",
      "قديش بتكلف العلامة التجارية؟",
      "عندي براند جديد، شو بنصحوني؟",
      "بحتاج عقود عمل لموظفيني؟",
      "ممكن تراجعوا عقد شراكة إلي؟",
      { q: "هل هاد العقد قانوني وملزم بحالتي؟", refusal: R.PERSONALIZED, humour: H.SERIOUS },
      "شو حقوق الملكية الفكرية للبرمجيات؟",
      "في حماية للتصميم الصناعي؟",
    ],
    en: [
      "How do I register a trademark in Cyprus?",
      "Does the trademark protect me across Europe?",
      "What is the difference between registering the company and the brand?",
      "How much does a trademark cost?",
      "I have a new brand, what would you advise?",
      "Do I need employment contracts for my staff?",
      "Can you review a partnership agreement for me?",
      { q: "Is this contract legally binding in my situation?", refusal: R.PERSONALIZED, humour: H.SERIOUS },
      "What are the IP rights for software?",
      "Is there protection for industrial design?",
    ],
    el: [
      "Πώς καταχωρώ εμπορικό σήμα στην Κύπρο;",
      "Προστατεύει το σήμα σε ολόκληρη την Ευρώπη;",
      "Ποια η διαφορά μεταξύ εγγραφής εταιρείας και σήματος;",
      "Πόσο κοστίζει ένα εμπορικό σήμα;",
      "Έχω νέα επωνυμία, τι θα προτείνατε;",
      "Χρειάζομαι συμβάσεις εργασίας για το προσωπικό μου;",
      "Μπορείτε να ελέγξετε μια συμφωνία συνεργασίας;",
      { q: "Είναι αυτή η σύμβαση νομικά δεσμευτική στην περίπτωσή μου;", refusal: R.PERSONALIZED, humour: H.SERIOUS },
      "Ποια είναι τα δικαιώματα πνευματικής ιδιοκτησίας για λογισμικό;",
      "Υπάρχει προστασία για βιομηχανικό σχέδιο;",
    ],
  }),
];

module.exports = { ENTRIES };
