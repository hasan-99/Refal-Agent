"use strict";

// Golden Evaluation Set — Corporate domain, topics 1-8.
// 10 questions per topic per language. Natively authored, not translated:
// Arabic is Levantine/Syrian per AR-L1, English business casual per AR-L2,
// Greek professional business register per AR-L3.

const { topicSet, REFUSAL_CLASSES: R, HUMOUR_LEVELS: H } = require("./brainGoldenSetSchema");

const ENTRIES = [
  // ---------------------------------------------------------------- 1. lifecycle
  // The topic owns exactly one fact, the ten stage lifecycle, so most questions
  // here resolve to it. Two do not: "how long does registration take" is answered
  // by MB-F2 and "can I close it later" by MB-F18, both cited from the lifecycle
  // documents under brainFactMap's `supporting` list.
  ...topicSet("company-lifecycle", {
    facts: ["MB-F1"], humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F1"],   // 1. the steps from scratch
      ["MB-F2"],   // 2. how long registration takes (formation-package fact, cited)
      ["MB-F1"],   // 3. what happens after registration
      ["MB-F1"],   // 4. do not know where to start
      ["MB-F1"],   // 5. must I be in Cyprus
      ["MB-F1"],   // 6. who signs
      ["MB-F1"],   // 7. name reservation vs registration
      ["MB-F1"],   // 8. incorporating from abroad
      ["MB-F18"],  // 9. closing later (dormant-and-liquidation fact, cited)
      ["MB-F1"],   // 10. what to know before starting
    ],
  }, {
    ar: [
      "شو الخطوات من الصفر لتأسيس شركة بقبرص؟",
      "قديش بياخد وقت تسجيل الشركة؟",
      "بعد ما تنفتح الشركة شو بصير؟ في التزامات سنوية؟",
      "بدي افتح شركة بس ما بعرف من وين ابلش",
      "هل لازم اكون موجود بقبرص وقت التأسيس؟",
      "مين بيوقع الأوراق، أنا ولا انتو؟",
      "شو الفرق بين حجز الاسم والتسجيل الفعلي؟",
      "كيف بفتح شركة وانا بره قبرص؟",
      "لو بدي اسكر الشركة بعدين، سهلة؟",
      "في شي ضروري لازم اعرفه قبل ما ابلش؟",
    ],
    en: [
      "What are the steps to set up a company in Cyprus from scratch?",
      "How long does company registration usually take?",
      "What happens after the company is registered? Are there annual obligations?",
      "I want to incorporate but I don't know where to start.",
      "Do I need to be physically in Cyprus to register?",
      "Who signs the documents, me or your team?",
      "What is the difference between reserving a name and actual registration?",
      "Can I open a Cyprus company while living abroad?",
      "If I want to close the company later, is that straightforward?",
      "What should I know before I begin the process?",
    ],
    el: [
      "Ποια είναι τα βήματα για την ίδρυση εταιρείας στην Κύπρο;",
      "Πόσο χρόνο χρειάζεται συνήθως η εγγραφή εταιρείας;",
      "Τι γίνεται μετά την εγγραφή; Υπάρχουν ετήσιες υποχρεώσεις;",
      "Θέλω να ιδρύσω εταιρεία αλλά δεν ξέρω από πού να ξεκινήσω.",
      "Πρέπει να βρίσκομαι στην Κύπρο κατά την εγγραφή;",
      "Ποιος υπογράφει τα έγγραφα, εγώ ή η ομάδα σας;",
      "Ποια η διαφορά ανάμεσα στην κράτηση ονόματος και την εγγραφή;",
      "Μπορώ να ανοίξω κυπριακή εταιρεία ενώ ζω στο εξωτερικό;",
      "Αν θελήσω να κλείσω την εταιρεία αργότερα, είναι απλό;",
      "Τι πρέπει να γνωρίζω πριν ξεκινήσω τη διαδικασία;",
    ],
  }),

  // ------------------------------------------------------- 2. formation package
  // MB-F2..MB-F8 are the seven inclusions, MB-F9 is the headline price (served
  // live, never frozen). A price question expects MB-F9; a "what is included"
  // question expects the inclusions it actually names.
  ...topicSet("formation-package", {
    facts: ["MB-F9"], hook: "MB-X1", humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F9"],                                                                  // 1. what does it cost
      ["MB-F2", "MB-F3", "MB-F4", "MB-F5", "MB-F6", "MB-F7", "MB-F8"],            // 2. what is included
      ["MB-F9"],                                                                  // 3. hidden costs
      ["MB-F9"],                                                                  // 4. inclusive of VAT
      ["MB-F6", "MB-F7", "MB-F9"],                                                // 5. cheaper competitor (MB-O2)
      ["MB-F9"],                                                                  // 6. too expensive (MB-O1)
      ["MB-F6", "MB-F7"],                                                         // 7. second year: the 4 month items renew
      ["MB-F9"],                                                                  // 8. payment plan
      ["MB-F6", "MB-F7"],                                                         // 9. secretary and registered address
      ["MB-F9"],                                                                  // 10. send it all on WhatsApp (MB-O4)
    ],
  }, {
    ar: [
      "قديش بتكلف الشركة بقبرص؟",
      "شو شامل عرض الـ999 يورو؟",
      "في مصاريف مخفية غير الـ999؟",
      "الـ999 شامل ضريبة القيمة المضافة؟",
      { q: "لقيت عرض بـ500 يورو، ليش عندكم اغلى؟", objection: "MB-O2", humour: H.PLAYFUL },
      { q: "الـ999 غالي بالنسبة إلي", objection: "MB-O1", humour: H.PLAYFUL },
      "شو بدفع بالسنة التانية؟",
      "في خطة تقسيط للمبلغ؟",
      "السكرتارية والعنوان المسجل داخلين بالسعر؟",
      { q: "ابعتلي كل التفاصيل عالواتساب", objection: "MB-O4", humour: H.PLAYFUL },
    ],
    en: [
      "How much does it cost to set up a company in Cyprus?",
      "What exactly is included in the 999 euro package?",
      "Are there hidden costs beyond the 999 euro?",
      "Is the 999 euro inclusive of VAT?",
      { q: "I found an offer at 500 euro, why are you more expensive?", objection: "MB-O2" },
      { q: "999 euro feels expensive to me.", objection: "MB-O1" },
      "What do I pay in the second year?",
      "Do you offer a payment plan?",
      "Are the secretary and registered office included in the price?",
      { q: "Just send me everything on WhatsApp.", objection: "MB-O4" },
    ],
    el: [
      "Πόσο κοστίζει η ίδρυση εταιρείας στην Κύπρο;",
      "Τι ακριβώς περιλαμβάνει το πακέτο των 999 ευρώ;",
      "Υπάρχουν κρυφά κόστη πέρα από τα 999 ευρώ;",
      "Τα 999 ευρώ περιλαμβάνουν ΦΠΑ;",
      { q: "Βρήκα προσφορά στα 500 ευρώ, γιατί είστε ακριβότεροι;", objection: "MB-O2" },
      { q: "Τα 999 ευρώ μου φαίνονται ακριβά.", objection: "MB-O1" },
      "Τι πληρώνω τον δεύτερο χρόνο;",
      "Προσφέρετε δυνατότητα δόσεων;",
      "Η γραμματειακή υποστήριξη και η έδρα περιλαμβάνονται στην τιμή;",
      { q: "Στείλτε μου τα πάντα στο WhatsApp.", objection: "MB-O4" },
    ],
  }),

  // --------------------------------------------------------- 3. company structures
  ...topicSet("company-structures", { facts: ["MB-F10"], humour: H.PLAYFUL }, {
    ar: [
      "شو أنواع الشركات بقبرص؟",
      "شو الفرق بين شركة محدودة وفرع؟",
      "أي نوع شركة مناسب لنشاط تجاري عادي؟",
      "ممكن اكون المالك الوحيد للشركة؟",
      "كم بدي شريك عشان افتح شركة؟",
      "في حد أدنى لرأس المال؟",
      "شركة قابضة ولا شركة تشغيلية، شو الفرق؟",
      "ممكن اغير نوع الشركة بعدين؟",
      "شو يعني Private Limited Company؟",
      "في فرق لو الشركاء من بره الاتحاد الأوروبي؟",
    ],
    en: [
      "What types of companies exist in Cyprus?",
      "What is the difference between a limited company and a branch?",
      "Which company type suits a normal trading business?",
      "Can I be the sole owner of the company?",
      "How many partners do I need to open a company?",
      "Is there a minimum share capital requirement?",
      "Holding company or operating company, what is the difference?",
      "Can I change the company type later?",
      "What does Private Limited Company actually mean?",
      "Does it matter if the shareholders are outside the EU?",
    ],
    el: [
      "Τι τύποι εταιρειών υπάρχουν στην Κύπρο;",
      "Ποια η διαφορά μεταξύ λιμιτεδ εταιρείας και υποκαταστήματος;",
      "Ποιος τύπος εταιρείας ταιριάζει σε μια συνηθισμένη εμπορική δραστηριότητα;",
      "Μπορώ να είμαι ο μοναδικός ιδιοκτήτης της εταιρείας;",
      "Πόσους εταίρους χρειάζομαι για να ανοίξω εταιρεία;",
      "Υπάρχει ελάχιστο μετοχικό κεφάλαιο;",
      "Εταιρεία συμμετοχών ή λειτουργική εταιρεία, ποια η διαφορά;",
      "Μπορώ να αλλάξω τον τύπο της εταιρείας αργότερα;",
      "Τι σημαίνει στην πράξη Private Limited Company;",
      "Έχει σημασία αν οι μέτοχοι είναι εκτός ΕΕ;",
    ],
  }),

  // -------------------------------------------------- 4. shareholder vs director
  // MB-F11 shareholder = owner, MB-F12 director = executive officer,
  // MB-F13 REFAL's one line phrasing including "can be the same person".
  ...topicSet("shareholder-vs-director", {
    facts: ["MB-F11", "MB-F12"], humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F11", "MB-F12", "MB-F13"],  // 1. what is the difference
      ["MB-F13"],                      // 2. can I be both
      ["MB-F12"],                      // 3. must the director be resident
      ["MB-F12"],                      // 4. who decides
      ["MB-F11"],                      // 5. shareholder liable for debts
      ["MB-F12"],                      // 6. appoint another director
      ["MB-F12"],                      // 7. director's powers
      ["MB-F12"],                      // 8. how many directors
      ["MB-F11"],                      // 9. how are shares split
      ["MB-F11", "MB-F12"],            // 10. legal responsibility of each role
    ],
  }, {
    ar: [
      "شو الفرق بين المساهم والمدير؟",
      "ممكن اكون مساهم ومدير بنفس الوقت؟",
      "المدير لازم يكون مقيم بقبرص؟",
      "مين بياخد القرارات بالشركة؟",
      "المساهم مسؤول عن ديون الشركة؟",
      "ممكن احط حدا تاني مدير بدالي؟",
      "شو صلاحيات المدير بالضبط؟",
      "كم مدير لازم يكون بالشركة؟",
      "لو عندي شريك، كيف بتتوزع الأسهم؟",
      "في فرق بالمسؤولية القانونية بين الاتنين؟",
    ],
    en: [
      "What is the difference between a shareholder and a director?",
      "Can I be both shareholder and director at the same time?",
      "Does the director have to be resident in Cyprus?",
      "Who actually makes the decisions in the company?",
      "Is a shareholder liable for the company's debts?",
      "Can I appoint someone else as director instead of me?",
      "What exactly are the director's powers?",
      "How many directors does a company need?",
      "If I have a partner, how are the shares split?",
      "Is there a difference in legal responsibility between the two roles?",
    ],
    el: [
      "Ποια η διαφορά μεταξύ μετόχου και διευθυντή;",
      "Μπορώ να είμαι ταυτόχρονα μέτοχος και διευθυντής;",
      "Πρέπει ο διευθυντής να είναι κάτοικος Κύπρου;",
      "Ποιος λαμβάνει στην πράξη τις αποφάσεις στην εταιρεία;",
      "Ευθύνεται ο μέτοχος για τα χρέη της εταιρείας;",
      "Μπορώ να ορίσω κάποιον άλλο ως διευθυντή αντί για εμένα;",
      "Ποιες ακριβώς είναι οι εξουσίες του διευθυντή;",
      "Πόσους διευθυντές χρειάζεται μια εταιρεία;",
      "Αν έχω εταίρο, πώς μοιράζονται οι μετοχές;",
      "Υπάρχει διαφορά στη νομική ευθύνη μεταξύ των δύο ρόλων;",
    ],
  }),

  // ------------------------------------------------------- 5. ownership changes
  ...topicSet("ownership-changes", { facts: ["MB-F14"], humour: H.WARM }, {
    ar: [
      "كيف بنقل أسهم لشريك جديد؟",
      "بدي اطلع شريك من الشركة، شو الخطوات؟",
      "في ضريبة على نقل الأسهم؟",
      "لازم موافقة باقي الشركاء؟",
      "قديش بياخد وقت تغيير الملكية؟",
      "ممكن ادخل مستثمر جديد بالشركة؟",
      "شو الأوراق المطلوبة لتغيير المساهمين؟",
      "بدي اغير المدير، كيف؟",
      "لو شريكي مش موافق، شو بصير؟",
      "ممكن انقل الشركة كلها لشخص تاني؟",
    ],
    en: [
      "How do I transfer shares to a new partner?",
      "I want to remove a partner from the company, what are the steps?",
      "Is there any tax on transferring shares?",
      "Do the other shareholders need to approve?",
      "How long does a change of ownership take?",
      "Can I bring a new investor into the company?",
      "What documents are needed to change shareholders?",
      "I want to change the director, how is that done?",
      "What happens if my partner does not agree?",
      "Can I transfer the whole company to someone else?",
    ],
    el: [
      "Πώς μεταβιβάζω μετοχές σε νέο εταίρο;",
      "Θέλω να αποχωρήσει ένας εταίρος, ποια είναι τα βήματα;",
      "Υπάρχει φορολογία στη μεταβίβαση μετοχών;",
      "Χρειάζεται έγκριση από τους υπόλοιπους μετόχους;",
      "Πόσο διαρκεί η αλλαγή ιδιοκτησίας;",
      "Μπορώ να εντάξω νέο επενδυτή στην εταιρεία;",
      "Ποια έγγραφα απαιτούνται για αλλαγή μετόχων;",
      "Θέλω να αλλάξω τον διευθυντή, πώς γίνεται;",
      "Τι συμβαίνει αν ο εταίρος μου διαφωνεί;",
      "Μπορώ να μεταβιβάσω ολόκληρη την εταιρεία σε άλλον;",
    ],
  }),

  // -------------------------------------------- 6. registered vs physical office
  // MB-F15 is the address versus workspace distinction. "Can I use my home
  // address" is answered by MB-F7, the Registered Address itself, which
  // formation-package owns and this topic cites.
  ...topicSet("registered-vs-physical-office", {
    facts: ["MB-F15"], hook: "MB-X5", humour: H.PLAYFUL,
    factsByIndex: [
      ["MB-F15"],  // 1. registered address vs physical office
      ["MB-F15"],  // 2. do I need a real office
      ["MB-F15"],  // 3. is the registered address enough
      ["MB-F15"],  // 4. what substance means
      ["MB-F15"],  // 5. genuinely moving operations
      ["MB-F15"],  // 6. offices for rent
      ["MB-F15"],  // 7. will the bank ask
      ["MB-F7"],   // 8. home address (formation-package fact, cited)
      ["MB-F15"],  // 9. tax difference with a real office
      ["MB-F15"],  // 10. relocating and working from Cyprus
    ],
  }, {
    ar: [
      "شو الفرق بين العنوان المسجل والمكتب الفعلي؟",
      "لازم يكون عندي مكتب حقيقي بقبرص؟",
      "العنوان المسجل بكفي للتسجيل؟",
      "شو يعني Substance؟",
      "لو بدي انقل الشغل فعلياً لقبرص شو بحتاج؟",
      "عندكم مكاتب للإيجار؟",
      "البنك بيطلب عنوان فعلي؟",
      "ممكن استخدم عنوان بيتي للشركة؟",
      "في فرق ضريبي لو عندي مكتب فعلي؟",
      "بدنا ننتقل ونشتغل من قبرص فعلياً، شو الخيارات؟",
    ],
    en: [
      "What is the difference between a registered address and a physical office?",
      "Do I need a real office in Cyprus?",
      "Is a registered address enough for registration?",
      "What does substance actually mean?",
      "If I want to genuinely move operations to Cyprus, what do I need?",
      "Do you offer offices for rent?",
      "Will the bank ask for a physical address?",
      "Can I use my home address for the company?",
      "Is there a tax difference if I have a real office?",
      "We want to relocate and actually work from Cyprus, what are the options?",
    ],
    el: [
      "Ποια η διαφορά μεταξύ έδρας και φυσικού γραφείου;",
      "Χρειάζομαι πραγματικό γραφείο στην Κύπρο;",
      "Αρκεί μια διεύθυνση έδρας για την εγγραφή;",
      "Τι σημαίνει στην πράξη ουσία (substance);",
      "Αν θέλω να μεταφέρω πραγματικά τις δραστηριότητες στην Κύπρο, τι χρειάζομαι;",
      "Προσφέρετε γραφεία προς ενοικίαση;",
      "Θα ζητήσει η τράπεζα φυσική διεύθυνση;",
      "Μπορώ να χρησιμοποιήσω τη διεύθυνση του σπιτιού μου;",
      "Υπάρχει φορολογική διαφορά αν έχω πραγματικό γραφείο;",
      "Θέλουμε να μετεγκατασταθούμε και να εργαζόμαστε από την Κύπρο, ποιες είναι οι επιλογές;",
    ],
  }),

  // ---------------------------------------------------- 7. privacy vs concealment
  ...topicSet("privacy-vs-concealment", { facts: ["MB-F16"], humour: H.WARM, refusal: R.NONE }, {
    ar: [
      "أسماء الملاك بتكون علنية؟",
      "في طريقة ما يظهر اسمي بالسجل؟",
      "شو الفرق بين الخصوصية والإخفاء؟",
      "مين بيقدر يشوف بيانات الشركة؟",
      "سمعت في nominee services، شو هي؟",
      { q: "بدي اخفي اسمي تماماً عن أي جهة حكومية", refusal: R.OUT_OF_SCOPE, humour: H.SERIOUS },
      "البنك بيعرف مين المالك الحقيقي؟",
      "شو يعني UBO؟",
      "معلوماتي بتنحمى كيف؟",
      "هل في سجل عام للمساهمين بقبرص؟",
    ],
    en: [
      "Are the owners' names publicly visible?",
      "Is there a way to keep my name off the register?",
      "What is the difference between privacy and concealment?",
      "Who can actually see the company's details?",
      "I heard about nominee services, what are they?",
      { q: "I want to completely hide my name from any government authority.", refusal: R.OUT_OF_SCOPE, humour: H.SERIOUS },
      "Will the bank know who the real owner is?",
      "What does UBO mean?",
      "How is my information protected?",
      "Is there a public shareholder register in Cyprus?",
    ],
    el: [
      "Είναι δημόσια ορατά τα ονόματα των ιδιοκτητών;",
      "Υπάρχει τρόπος να μην εμφανίζεται το όνομά μου στο μητρώο;",
      "Ποια η διαφορά μεταξύ ιδιωτικότητας και απόκρυψης;",
      "Ποιος μπορεί να δει τα στοιχεία της εταιρείας;",
      "Άκουσα για υπηρεσίες nominee, τι είναι;",
      { q: "Θέλω να κρύψω εντελώς το όνομά μου από κάθε κρατική αρχή.", refusal: R.OUT_OF_SCOPE, humour: H.SERIOUS },
      "Θα γνωρίζει η τράπεζα ποιος είναι ο πραγματικός ιδιοκτήτης;",
      "Τι σημαίνει UBO;",
      "Πώς προστατεύονται τα στοιχεία μου;",
      "Υπάρχει δημόσιο μητρώο μετόχων στην Κύπρο;",
    ],
  }),

  // ------------------------------------------------- 8. dormant and liquidation
  // MB-F17 dormant still carries reporting obligations, MB-F18 liquidation has
  // formal procedures. Each question asks about one or the other.
  ...topicSet("dormant-and-liquidation", {
    facts: ["MB-F17", "MB-F18"], humour: H.WARM,
    factsByIndex: [
      ["MB-F17", "MB-F18"],  // 1. dormant instead of closing
      ["MB-F17"],            // 2. what is a dormant company
      ["MB-F17"],            // 3. annual cost while dormant
      ["MB-F18"],            // 4. how to liquidate
      ["MB-F18"],            // 5. how long liquidation takes
      ["MB-F17"],            // 6. never used it, still fees
      ["MB-F18"],            // 7. voluntary vs compulsory
      ["MB-F17"],            // 8. obligations while dormant
      ["MB-F17"],            // 9. reactivate after dormancy
      ["MB-F18"],            // 10. debts during liquidation
    ],
  }, {
    ar: [
      "ممكن اخلي الشركة خاملة بدل ما اسكرها؟",
      "شو يعني شركة dormant؟",
      "قديش بتكلف الشركة الخاملة بالسنة؟",
      "كيف بصفي الشركة نهائياً؟",
      "قديش بياخد وقت التصفية؟",
      "لو ما استعملت الشركة، لازم ادفع رسوم؟",
      "في فرق بين التصفية الطوعية والإجبارية؟",
      "لسه عندي التزامات لو الشركة خاملة؟",
      "ممكن ارجع افعّل الشركة بعد ما تخمل؟",
      "شو بصير بالديون وقت التصفية؟",
    ],
    en: [
      "Can I make the company dormant instead of closing it?",
      "What does a dormant company actually mean?",
      "How much does a dormant company cost per year?",
      "How do I liquidate the company permanently?",
      "How long does liquidation take?",
      "If I never use the company, do I still pay fees?",
      "What is the difference between voluntary and compulsory liquidation?",
      "Do I still have obligations if the company is dormant?",
      "Can I reactivate the company after it has gone dormant?",
      "What happens to the debts during liquidation?",
    ],
    el: [
      "Μπορώ να κάνω την εταιρεία αδρανή αντί να την κλείσω;",
      "Τι σημαίνει στην πράξη αδρανής εταιρεία;",
      "Πόσο κοστίζει μια αδρανής εταιρεία ετησίως;",
      "Πώς εκκαθαρίζω οριστικά την εταιρεία;",
      "Πόσο διαρκεί η εκκαθάριση;",
      "Αν δεν χρησιμοποιήσω ποτέ την εταιρεία, πληρώνω τέλη;",
      "Ποια η διαφορά εκούσιας και αναγκαστικής εκκαθάρισης;",
      "Έχω υποχρεώσεις αν η εταιρεία είναι αδρανής;",
      "Μπορώ να επανενεργοποιήσω την εταιρεία μετά την αδράνεια;",
      "Τι γίνεται με τα χρέη κατά την εκκαθάριση;",
    ],
  }),
];

module.exports = { ENTRIES };
