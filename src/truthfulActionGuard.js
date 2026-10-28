"use strict";

// Deterministic post-draft guard (RAFA_TRUTHFUL_ACTION_STATES), in the same
// family as responsePolicy's unverified_handover_action /
// unverified_booking_action gates and run at the same point (before the
// factual-grounding gate and the semantic reviewer, so it costs no model call).
//
// It blocks a customer-facing claim unless the real state supports it:
//   handoff_notified / handoff_sent / handoff_accepted / human_joined / contact_promise
//                         -> the handoff state machine (sessionMemory.deriveHandoffState)
//   record_saved          -> a verified upsertLead success this session
//   ticket_or_crm_claim   -> never (REFAL has no ticket/CRM-case tool on the agent path)
//   booking_submitted / booking_confirmed -> the booking workflow state
//   response_time         -> approved evidence that states a response time (SLA)
//   security_claim        -> approved evidence on a security/hosting/retention topic
//   complaint_liability   -> never (no admission of fault, no refund/compensation promise)
//   outcome_guarantee     -> never (no guaranteed approval/permit/residency/account/refund)
//   memory_mechanics      -> never (no "I stored this in my memory")
//
// Negated or limiting clauses ("No specialist has been notified yet", "I can't
// confirm the hosting location") and questions are not claims and pass.
// Existing gates are untouched; this only adds rejections.
//
// Note: every regex uses the u flag; \p{L} is used for Arabic/Greek word
// continuations because \w is ASCII-only even in Unicode mode.

const { NEGATION, splitSentences, isQuestionText } = require("./sessionMemory");
const { redactPersonalData } = require("./ai");

const STATE_RANK = Object.freeze({ not_requested: 0, requested: 1, failed: 1, submitted: 2, queued: 3, accepted: 4, human_joined: 5, completed: 5 });

const CLAIMS = Object.freeze([
  { code: "handoff_notified", minHandoff: "accepted", patterns: [
    /\b(?:specialist|advis[eo]r|team|colleague|expert|manager|staff|someone|consultant)s?\b[^.!?\n]{0,40}\b(?:has|have|was|were|is|are)\s+(?:already\s+|now\s+)?(?:been\s+)?(?:notified|informed|alerted|contacted|assigned|told)\b/iu,
    /\b(?:i|we)(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:notified|informed|alerted|contacted|told)\s+(?:the|a|an|our|your)\s+(?:specialist|team|advis|expert|manager|staff|colleague|consultant)/iu,
    /(?:تم|تمّ)\s*(?:إبلاغ|ابلاغ|إعلام|اعلام|تنبيه|إخطار)\s*(?:ال)?(?:مختص|فريق|مستشار|إدارة|ادارة|موظف|قسم)/u,
    /(?:أبلغت|ابلغت|بلّغت|بلغت|خبّرت|خبرت|أعلمت|نبهت)\s*(?:ال)?(?:مختص|فريق|مستشار|إدارة|ادارة|زميل)/u,
    /(?:المختص|الفريق|الإدارة|الادارة)\s*(?:صار|صارت|أصبح)?\s*(?:عنده|عندها|على)\s*(?:علم|خبر)/u,
    /(?:ενημερώθηκε|ενημερώσαμε|ενημέρωσα|ειδοποιήθηκε|ειδοποίησα)\s+(?:ο\s+ειδικός|η\s+ομάδα|έναν\s+ειδικό|την\s+ομάδα)/iu,
    /(?:ο\s+ειδικός|η\s+ομάδα)\s+(?:έχει\s+)?(?:ενημερωθεί|ειδοποιηθεί)/iu
  ] },
  { code: "handoff_sent", minHandoff: "submitted", patterns: [
    /\b(?:your|the)\s+(?:case|file|request|details|conversation|inquiry|enquiry|query|notes?|information|message)\b[^.!?\n]{0,30}\b(?:was|were|has\s+been|have\s+been|is|are)\s+(?:now\s+|already\s+)?(?:sent|forwarded|passed|escalated|transferred|shared|submitted|handed|routed)\b/iu,
    /\b(?:your|the)\s+(?:case|file|request|details|notes?|information)\s+(?:is|are)\s+(?:now\s+|already\s+)?(?:with|in\s+the\s+hands\s+of)\s+(?:the|our)\s+(?:team|specialist|management|staff|advis)/iu,
    /\b(?:i|we)(?:['’]ve|\s+have)\s+(?:already\s+)?(?:passed|forwarded|sent|escalated|transferred|handed|shared|routed)\b[^.!?\n]{0,60}\b(?:team|specialist|management|staff|colleague|advis|expert)/iu,
    /\b(?:i|we)\s+(?:passed|forwarded|escalated|transferred|handed)\s+(?:this|it|your\s+\w+)\b/iu,
    /(?:ملفك|طلبك|حالتك|قضيتك|بياناتك|ملاحظاتك|استفسارك|رسالتك)\s*(?:صار|صارت|هو|هي|الآن|الان|حاليا|حالياً)?\s*(?:عند|مع|لدى|بيد|بين\s+يدي)\s*(?:ال)?(?:فريق|إدارة|ادارة|مختص|مختصين|موظفين|قسم)/u,
    /(?:تم|تمّ)\s*(?:إرسال|ارسال|تحويل|رفع|تمرير|نقل|توجيه)\s*(?:طلبك|ملفك|حالتك|بياناتك|استفسارك|ملاحظاتك|رسالتك|الطلب|الملف|المحادثة)/u,
    /(?:حوّلت|حولت|أرسلت|ارسلت|بعثت|رفعت|مرّرت|مررت|وجّهت|وجهت)\s*(?:طلبك|ملفك|حالتك|استفسارك|بياناتك|رسالتك|ملاحظاتك)/u,
    /(?:سجلت|سجّلت|دونت|دوّنت)\s*(?:ملاحظاتك|طلبك|بياناتك)\s*(?:عند|لدى|مع)\s*(?:ال)?(?:إدارة|ادارة|فريق|مختص)/u,
    /(?:طلبك|ملفك|حالتك)\s*(?:انرسل|اتحول|تحول|انبعث|وصل\s+(?:لل|إلى\s+ال|الى\s+ال)(?:فريق|إدارة|مختص))/u,
    /(?:το\s+αίτημά\s+σας|ο\s+φάκελός\s+σας|η\s+υπόθεσή\s+σας)\s+(?:έχει\s+)?(?:σταλεί|στάλθηκε|προωθήθηκε|διαβιβάστηκε|είναι\s+στην\s+ομάδα)/iu,
    /(?:προώθησα|έστειλα|διαβίβασα)\s+(?:το\s+αίτημά\s+σας|τον\s+φάκελό\s+σας|την\s+υπόθεσή\s+σας)/iu
  ] },
  { code: "handoff_accepted", minHandoff: "accepted", patterns: [
    /\b(?:team|specialist|colleague|advis[eo]r)s?\b[^.!?\n]{0,30}\b(?:has|have|is|are)\s+(?:already\s+)?(?:picked\s+up|accepted|reviewing|working\s+on|looking\s+into|handling)\s+(?:your|the|this)\b/iu,
    /(?:الفريق|المختص|الإدارة)\s*(?:استلم|استلمت|عم\s*يراجع|يراجع|عم\s*يشتغل\s+على|يتابع|بلّش\s+ب|بدأ\s+ب)\s*(?:طلبك|ملفك|حالتك)/u,
    /(?:η\s+ομάδα|ο\s+ειδικός)\s+(?:εξετάζει|ανέλαβε|χειρίζεται)\s+(?:το\s+αίτημά\s+σας|την\s+υπόθεσή\s+σας)/iu
  ] },
  { code: "human_joined", minHandoff: "human_joined", patterns: [
    /\b(?:a|our|the)\s+(?:human(?:\s+(?:agent|colleague|advis[eo]r))?|team\s+member|specialist|agent|colleague|advis[eo]r|person|representative)\s+(?:has|have)\s+(?:now\s+)?(?:joined|taken\s+over|entered)\b/iu,
    /\byou(?:['’]re|\s+are)\s+now\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:a|our)\s+(?:human|specialist|team\s+member|person)/iu,
    /(?:انضم|دخل|انضمت|دخلت)\s*(?:ال)?(?:مختص|موظف|زميل|مستشار|مستشارة|موظفة)/u,
    /(?:συνδέθηκε|μπήκε)\s+(?:ένας\s+|μια\s+)?(?:ειδικός|συνάδελφος|εκπρόσωπος)/iu
  ] },
  { code: "contact_promise", minHandoff: "accepted", patterns: [
    /\b(?:someone|a\s+specialist|the\s+specialist|the\s+team|our\s+team|a\s+colleague|an?\s+advis[eo]r|a\s+team\s+member|they)\s+will\s+(?:reply|respond|get\s+back|be\s+in\s+touch|answer|contact|call|reach\s+out|follow\s+up|message)/iu,
    /\byou(?:['’]ll|\s+will)\s+(?:hear|receive\s+a\s+(?:reply|call|response))\s+(?:back\s+)?(?:from|shortly|soon)/iu,
    /(?:حدا|شخص|المختص|الفريق|زميل|مستشار|موظف)\s*(?:رح|ح|راح|سوف|سي|س)\s*(?:يرد|يرجعلك|يرجع\s+لك|يتواصل|يتصل|يجاوب|يحكي\s+معك|يكلمك)/u,
    /(?:سيتواصل|سيرد|سيتصل|سيجيبك|بيتواصل|بيرد|بيتصل)(?=\s|$|[.!؟،])/u,
    /θα\s+(?:σας\s+)?(?:απαντήσει|καλέσει|επικοινωνήσει)/iu
  ] },
  { code: "record_saved", leadSavedAllows: true, patterns: [
    /\b(?:i|we)(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:saved|stored|recorded|logged|noted\s+down|filed|registered|added)\b[^.!?\n]{0,40}\b(?:details|information|info|data|notes?|preferences|request|case|file|lead|record|profile|number|name)\b/iu,
    /\b(?:your|the)\s+(?:details|information|data|notes?|preferences|lead|record|profile)\b[^.!?\n]{0,20}\b(?:has|have|was|were|is|are)\s+(?:now\s+)?(?:been\s+)?(?:saved|stored|recorded|logged|registered|added|on\s+file)\b/iu
  ] },
  { code: "ticket_or_crm_claim", patterns: [
    /\b(?:i|we)(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:created|opened|raised|logged|filed)\s+(?:a|an|your)\s+(?:ticket|case|support\s+request|crm\s+record|lead|file)\b/iu,
    /\b(?:your|a|the)\s+(?:ticket|case|support\s+request)\s+(?:number|#|id)\b|\b(?:ticket|case)\s+#?\d{3,}/iu,
    /\b(?:in|to|into)\s+(?:our|the)\s+(?:crm|system|database|records)\b[^.!?\n]{0,20}\b(?:saved|stored|recorded|added|logged)\b|\b(?:saved|stored|recorded|added|logged)\b[^.!?\n]{0,30}\b(?:in|to|into)\s+(?:our|the)\s+(?:crm|system|database|records)\b/iu,
    /(?:تم|تمّ)\s*(?:حفظ|تسجيل|تدوين|فتح|إنشاء|انشاء|إضافة|اضافة)\s*(?:بياناتك|معلوماتك|ملاحظاتك|تذكرة|ملف|تفاصيلك|تفضيلاتك|الملف|البيانات|طلب\s+دعم)/u,
    /(?:حفظت|سجلت|سجّلت|دونت|دوّنت|فتحت|خزنت|خزّنت)\s*(?:لك\s+)?(?:بياناتك|معلوماتك|ملاحظاتك|تفاصيلك|تذكرة|ملف|تفضيلاتك|رقمك|اسمك)/u,
    /(?:بياناتك|معلوماتك|ملاحظاتك|تفاصيلك)\s*(?:محفوظة|مسجلة|مسجّلة|انحفظت|تسجلت|عند\s+(?:ال)?(?:إدارة|ادارة|فريق))/u,
    /رقم\s*(?:التذكرة|تذكرتك|الحالة|طلبك|الطلب)/u,
    /(?:αποθήκευσα|κατέγραψα|καταχώρισα|άνοιξα)\s+(?:τα\s+στοιχεία\s+σας|ένα\s+αίτημα|ένα\s+εισιτήριο|τις\s+σημειώσεις|φάκελο)/iu,
    /τα\s+στοιχεία\s+σας\s+(?:αποθηκεύτηκαν|καταχωρίστηκαν|καταγράφηκαν)/iu
  ] },
  { code: "booking_submitted", minBooking: "pending_confirmation", patterns: [
    /\b(?:your|the)\s+(?:appointment|meeting|booking|call|consultation)\s+request\s+(?:has\s+been|was|is)\s+(?:now\s+)?(?:submitted|sent|received|pending|being\s+reviewed|under\s+review)/iu,
    /\b(?:i|we)(?:['’]ve|\s+have)\s+(?:submitted|sent|requested|placed)\s+(?:your|the|a)\s+(?:appointment|meeting|booking|consultation)/iu,
    /(?:تم|تمّ)\s*(?:إرسال|ارسال|تقديم|رفع)\s*طلب\s*(?:ال)?(?:موعد|حجز|اجتماع|استشارة)/u,
    /طلب\s*(?:موعدك|الموعد|الحجز|اجتماعك)\s*(?:قيد|تحت)\s*(?:المراجعة|الدراسة)/u
  ] },
  { code: "booking_confirmed", minBooking: "confirmed", patterns: [
    /\b(?:appointment|meeting|booking|call|consultation)\b[^.!?\n]{0,30}\b(?:is|has\s+been|was)\s+(?:now\s+)?(?:confirmed|booked|scheduled|reserved)\b/iu,
    /(?:تم|تمّ)\s*(?:تأكيد|حجز|تثبيت)\s*(?:ال)?(?:موعد|موعدك|اجتماع|الاجتماع|الاستشارة)/u
  ] },
  { code: "response_time", needsEvidence: "response_time", patterns: [
    /\b(?:reply|respond|get\s+back|contact|call|reach\s+out|follow\s+up|hear\s+back|be\s+in\s+touch|answer|review)\w*\b[^.!?\n]{0,50}\b(?:shortly|soon|immediately|right\s+away|asap|as\s+soon\s+as\s+possible|today|tonight|tomorrow|(?:with)?in\s+(?:an?|one|two|three|a\s+few|few|\d+)\s*(?:minutes?|hours?|days?|business\s+days?|working\s+days?))\b/iu,
    /\b(?:shortly|soon|immediately|right\s+away|today|(?:with)?in\s+(?:an?|one|two|a\s+few|\d+)\s*(?:minutes?|hours?|days?))\b[^.!?\n]{0,40}\b(?:reply|respond|get\s+back|contact|call|reach\s+out|follow\s+up|hear|answer)/iu,
    /(?:يرد|يردوا|نرد|يرجع|يرجعلك|يتواصل|يتواصلوا|نتواصل|يتصل|يحكي\s+معك|يجاوب|الرد|التواصل|سيرد|سيتواصل|بيرد|بيتواصل)[^.!؟\n]{0,40}(?:قريب[اًا]?|قريبًا|عن\s+قريب|بأسرع\s+وقت|فور[اًا]?|فورًا|حالا|حالاً|هلق|اليوم|بكرا|بكرة|غدا|غداً|خلال\s*(?:ساعة|ساعتين|ساعات|\d+\s*ساع|يوم|يومين|أيام|ايام|دقائق|دقيقة|\d+))/u,
    /(?:قريب[اًا]?|قريبًا|فور[اًا]?|فورًا|خلال\s*(?:ساعة|ساعتين|ساعات|يوم|يومين|دقائق|\d+))[^.!؟\n]{0,30}(?:يرد|يتواصل|يتصل|يرجعلك|نرد|نتواصل|الرد)/u,
    /(?:απαντήσ|επικοινωνήσ|καλέσ)\p{L}*[^.!;\n]{0,40}(?:σύντομα|άμεσα|σήμερα|αύριο|εντός\s+\d+|μέσα\s+σε\s+(?:\d+|μία|μια|ένα))/iu
  ] },
  { code: "security_claim", needsEvidence: "security", patterns: [
    /\b(?:encrypt\w*|end-to-end)\b|تشفير|مشفّر|مشفر|مشفرة|κρυπτογραφ\p{L}*/iu,
    /\bgdpr\b[^.!?\n]{0,30}\b(?:compliant|compliance|certified)\b|\b(?:compliant|compliance)\b[^.!?\n]{0,30}\bgdpr\b|متوافق\p{L}*\s+مع\s+(?:GDPR|اللائحة)|συμμορφ\p{L}*\s+με\s+(?:τον\s+)?GDPR/iu,
    /\b(?:hosted|stored|kept|located)\s+(?:securely\s+)?(?:in|on|within)\s+(?:the\s+)?(?:eu|europe|cyprus|our\s+own|secure)\b|\b(?:servers?|data\s+cent(?:er|re)s?)\s+(?:are\s+|is\s+)?(?:located\s+)?in\b|مستضاف\p{L}*\s+(?:في|ب)|(?:الخوادم|السيرفرات|البيانات|خوادمنا)\s+(?:موجودة|مخزنة|مخزّنة|مستضافة)\s+(?:في|ب)|φιλοξεν\p{L}+\s+(?:στην|στο)/iu,
    /\b(?:retain\w*|retention|kept\s+for|deleted\s+after|stored\s+for)\b[^.!?\n]{0,30}\b(?:\d+|days?|months?|years?)\b|(?:نحتفظ|يتم\s+الاحتفاظ|تُحذف|تحذف)\s+(?:بها|بالبيانات|بعد)[^.!؟\n]{0,20}(?:يوم|أيام|شهر|أشهر|سنة|سنوات|\d+)/iu,
    /\b(?:data\s+)?(?:isolation|isolated|segregated)\b|معزول\p{L}*|عزل\s+البيانات|απομονωμέν\p{L}*/iu,
    /\b(?:iso\s?27001|soc\s?2|pci[- ]?dss)\b|\bcertified\s+(?:secure|for\s+security)\b/iu,
    /\bpen(?:etration)?[- ]?test\w*\b|\bred[- ]team\w*\b|\bsecurity\s+audit\w*\b|اختبار(?:ات)?\s+(?:ال)?اختراق|δοκιμ\p{L}*\s+διείσδυσης/iu
  ] },
  { code: "complaint_liability", never: true, patterns: [
    /\b(?:it|this|that)\s+(?:was|is)\s+(?:entirely\s+|completely\s+|totally\s+)?(?:our|my)\s+fault\b|\bwe\s+(?:are|were)\s+(?:fully\s+|legally\s+|entirely\s+)?(?:responsible|liable|at\s+fault)\b|\bwe\s+(?:take|accept|admit)\s+(?:full\s+)?(?:responsibility|liability|fault)\b/iu,
    /\bwe\s+(?:will|['’]ll|shall)\s+(?:give\s+you\s+a\s+)?(?:refund|compensate|reimburse)\b|\byou\s+will\s+(?:get|receive|be\s+given)\s+(?:a\s+|your\s+)?(?:full\s+)?(?:refund|compensation|reimbursement|money\s+back)\b|\b(?:your\s+)?(?:refund|compensation)\s+(?:is|has\s+been)\s+(?:approved|guaranteed|processed|confirmed)\b/iu,
    /(?:الخطأ|الغلط)\s*(?:خطأنا|غلطنا|منا|من\s+عندنا|علينا)|نتحمل\s*(?:كامل\s*)?(?:ال)?مسؤولية|(?:نحن|احنا|إحنا)\s*(?:ال)?مسؤولين\s+عن|نعترف\s+(?:بالخطأ|بالغلط)/u,
    /(?:رح|راح|سوف|س)\s*(?:نرجعلك|نرجع\s+لك|نعوضك|نعوّضك|نسترد\s+لك|نرد\s+لك)|(?:سنعوضك|سنعوّضك|سنعيد\s+لك|ستسترد|راح\s+تسترد|رح\s+تسترد)|(?:تمت|تم)\s*(?:الموافقة\s+على\s+)?(?:استرداد\s+(?:أموالك|مبلغك)|تعويضك)/u,
    /(?:ήταν|είναι)\s+(?:δικό\s+μας|δικό\s+μου)\s+λάθος|(?:φέρουμε|αναλαμβάνουμε)\s+(?:την\s+)?(?:πλήρη\s+)?ευθύνη|θα\s+(?:σας\s+)?(?:επιστρέψουμε\s+τα\s+χρήματα|αποζημιώσουμε)/iu
  ] },
  { code: "outcome_guarantee", never: true, patterns: [
    /\bguarantee(?:d|s)?\b[^.!?\n]{0,40}\b(?:approval|approved|acceptance|residency|permit|visa|licen[cs]e|account|refund|success|outcome|result|returns?)\b|\b(?:approval|residency|permit|visa|bank\s+account|licen[cs]e|refund)\b[^.!?\n]{0,30}\b(?:is|are)\s+guaranteed\b/iu,
    /\b(?:will|would)\s+(?:definitely|certainly|surely|100%)\s+(?:be\s+)?(?:approved|accepted|granted|succeed)\b|\b100%\s+(?:approval|guaranteed|success)\b/iu,
    /(?:مضمون|مضمونة|نضمن|أضمن|اضمن|بنضمن)\s*[^.!؟\n]{0,30}(?:الموافقة|موافقة|القبول|قبول|الإقامة|إقامة|الترخيص|ترخيص|التأشيرة|فتح\s+الحساب|الحساب\s+البنكي|استرداد|نجاح|النتيجة)|(?:الموافقة|القبول|الإقامة|التأشيرة|الترخيص)\s+(?:مضمونة|مضمون|أكيدة)/u,
    /(?:أكيد|اكيد|بالتأكيد|حتما|حتماً|100%)\s*(?:رح|ح|راح|سوف|س)?\s*(?:تنقبل|يتقبل|يوافقوا|يوافقو|توافق\s+البنك|تحصل\s+على\s+(?:الموافقة|الإقامة)|تنجح)/u,
    /εγγυ\p{L}+[^.!;\n]{0,30}(?:έγκριση|άδεια|βίζα|λογαριασμ|επιστροφή)/iu
  ] },
  { code: "memory_mechanics", never: true, patterns: [
    /\b(?:session|conversation)\s+memory\b|\b(?:in|to|into)\s+(?:my|our|the)\s+memory\b|\bmemory\s+(?:object|store|state|bank)\b|\bcontext\s+window\b/iu,
    /\b(?:stored|saved|kept|recorded)\s+(?:this|that|it|your\s+\w+)\s+in\s+(?:my|the|our)\s+(?:memory|session|context|profile|system)\b/iu,
    /\b(?:i|we)(?:['’]ll|\s+will)\s+remember\s+(?:you|this|that|it)\s+(?:next\s+time|for\s+next\s+time|in\s+(?:the\s+)?future|across\s+(?:sessions|conversations)|forever)\b/iu,
    /(?:ذاكرة|الذاكرة|ذاكرتي)\s*(?:الجلسة|المحادثة)?|(?:حفظت|خزنت|خزّنت|سجلت)\s*(?:هذا|هيدا|هاد|ذلك)?\s*(?:في|ب)\s*(?:الذاكرة|ذاكرتي|الجلسة)|(?:رح|سوف|س)\s*(?:أتذكرك|اتذكرك)\s*(?:المرة\s+الجاية|المرة\s+القادمة|لاحقا|لاحقاً|دائما|دائماً)/u,
    /μνήμη\p{L}*/iu
  ] }
]);

const BOOKING_RANK = Object.freeze({ none: 0, suggested: 1, selected: 2, cancelled: 0, failed: 0, pending_confirmation: 3, confirmed: 4 });
const RESPONSE_TIME_EVIDENCE = /\b(?:within\s+\d+|response\s+time|reply\s+within|business\s+days?|working\s+days?|hours?\s+of)\b|خلال\s*\d+|خلال\s+(?:ساعة|يوم)|يوم\s+عمل|εντός\s+\d+|εργάσιμ/iu;
const SECURITY_EVIDENCE = /\b(?:encrypt\w*|gdpr|hosted|hosting|server|data\s+cent|retention|retain|isolat\w*|segregat\w*|iso\s?27001|soc\s?2|penetration|pen[- ]?test|red[- ]team|security\s+audit)\b|تشفير|مشفر|استضافة|مستضاف|خوادم|الاحتفاظ|عزل|اختراق|κρυπτογραφ|φιλοξεν|διείσδυσ/iu;
const NOT_NEGATION = /\bno\s+(?:problem|worries)\b|لا\s+مشكلة|ما\s+في\s+مشكل\S*/giu;

function clauseSplit(text) {
  return splitSentences(text).flatMap((sentence) => sentence.split(/\s*(?:[;؛]|,\s*(?:but|however)\b|،\s*(?:بس|لكن)|\s+(?:but|however|بس|لكن|ولكن|αλλά)\s+)\s*/iu))
    .map((part) => part.trim()).filter(Boolean);
}

function claimAllowed(claim, { handoff, booking, leadSaved, evidenceText }) {
  if (claim.never) return false;
  if (claim.minHandoff) return (STATE_RANK[handoff] ?? 0) >= (STATE_RANK[claim.minHandoff] ?? 99);
  if (claim.minBooking) return (BOOKING_RANK[booking] ?? 0) >= (BOOKING_RANK[claim.minBooking] ?? 99);
  if (claim.leadSavedAllows) return leadSaved === true;
  if (claim.needsEvidence === "response_time") return RESPONSE_TIME_EVIDENCE.test(evidenceText);
  if (claim.needsEvidence === "security") return SECURITY_EVIDENCE.test(evidenceText);
  return false;
}

/**
 * Finds unsupported action/status claims in a draft.
 *   actionState: { handoff, booking, leadSaved } (sessionMemory state.actions)
 *   evidenceItems: current-turn approved evidence (the same list the grounding gate uses)
 *   observations: current-turn tool rounds (a verified tool success this turn also counts)
 */
function findUnsupportedActionClaims(text, { actionState = {}, evidenceItems = [], observations = [] } = {}) {
  const evidenceText = (Array.isArray(evidenceItems) ? evidenceItems : []).map((item) => `${item?.title || ""} ${item?.section || ""} ${item?.content || ""}`).join("\n");
  const turnTools = (Array.isArray(observations) ? observations : []).filter((round) => round?.result?.ok === true);
  const leadSaved = actionState.leadSaved === true || turnTools.some((round) => round.tool === "upsertLead" && round.result.status === "confirmed");
  const toolBooking = turnTools.find((round) => ["requestBookingAction", "holdOrBookAppointment"].includes(round.tool));
  const booking = toolBooking?.result?.status === "confirmed" ? "confirmed"
    : toolBooking && ["pending", "pending_review"].includes(toolBooking.result.status) && (BOOKING_RANK[actionState.booking?.status] ?? 0) < 3 ? "pending_confirmation"
      : actionState.booking?.status || "none";
  const handoff = actionState.handoff?.status || "not_requested";
  const findings = [];
  for (const clause of clauseSplit(text)) {
    const negationProbe = clause.replace(NOT_NEGATION, " ");
    if (isQuestionText(clause) || NEGATION.test(negationProbe)) continue;
    for (const claim of CLAIMS) {
      if (!claim.patterns.some((pattern) => pattern.test(clause))) continue;
      if (claimAllowed(claim, { handoff, booking, leadSaved, evidenceText })) continue;
      findings.push({ code: claim.code, sentence: redactPersonalData(clause).slice(0, 300) });
    }
  }
  return { findings, state: { handoff, booking, leadSaved } };
}

/**
 * Gate form. Removes whole offending sentences when a substantive remainder
 * is left (no extra model call); otherwise rejects with
 * `truthful_action:<code>` reasons so the loop's existing correction/retry
 * and safe fallback handle it.
 */
function evaluateTruthfulActions(text, options = {}) {
  const { findings, state } = findUnsupportedActionClaims(text, options);
  if (!findings.length) return { valid: true, text, removed: [], state };
  const blocked = new Set(findings.map((finding) => finding.sentence));
  const sentences = splitSentences(text);
  const kept = sentences.filter((sentence) => !clauseSplit(sentence).some((clause) => blocked.has(redactPersonalData(clause).slice(0, 300))));
  const remainder = kept.join(" ").trim();
  const remainderClean = remainder && findUnsupportedActionClaims(remainder, options).findings.length === 0;
  const substantive = remainderClean && kept.some((sentence) => !isQuestionText(sentence)) && remainder.replace(/[\s\p{P}\p{Extended_Pictographic}]/gu, "").length >= 20;
  const codes = [...new Set(findings.map((finding) => finding.code))];
  if (substantive && kept.length < sentences.length) return { valid: true, text: remainder, removed: codes, state };
  return { valid: false, text, removed: [], state, reasons: codes.map((code) => `truthful_action:${code}`),
    blockedClaims: findings.map((finding) => ({ sentence: finding.sentence, claimClass: "action_state", reasons: [finding.code] })) };
}

function truthfulActionCorrection(reasons = [], state = {}) {
  const codes = reasons.filter((reason) => String(reason).startsWith("truthful_action:")).map((reason) => reason.slice("truthful_action:".length));
  if (!codes.length) return "";
  return `The draft states an action, status or assurance the system has not confirmed (${codes.join(", ")}). Real state now: handoff=${state.handoff || "not_requested"}, booking=${state.booking || "none"}. Describe only that real state in natural words (for example that the request is not connected to the team yet, or that a reply time is not confirmed). Never say a specialist was notified, a case/file/ticket/note was sent or saved, a booking is confirmed, or a reply will come at a certain time unless that state supports it. No admission of fault or refund/compensation promise, no guaranteed outcome, no security/hosting/retention claim without current approved evidence, and never describe memory or storage mechanics. Keep the supported answer and offer the real next step.`;
}

module.exports = { findUnsupportedActionClaims, evaluateTruthfulActions, truthfulActionCorrection, CLAIMS };
