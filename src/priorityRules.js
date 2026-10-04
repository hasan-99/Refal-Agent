const TRIGGERS = Object.freeze({
  urgent: [
    ["safety_or_threat", /\b(threat|unsafe|danger|injury|police|fraud|scam|stolen|data breach|immediately)\b|تهديد|خطر|احتيال|سرقة|شرطة|عاجل/iu],
    ["severe_complaint", /\b(lawsuit|lawyer|regulator|formal complaint|media|press)\b|محامي|شكوى رسمية|إعلام|صحافة/iu]
  ],
  high: [
    ["complaint", /\b(complaint|complain|unhappy|dissatisfied|bad service|problem with your service)\b|شكوى|غير راض|مشكلة بالخدمة|παράπονο|δυσαρεστη/iu],
    ["existing_client", /\b(existing|current) client|already a client|my account|my contract|\bmy case\s+(?:status|reference|number|was submitted|already exists)\b|عميل حالي|حسابي|ملفي|عقدي|πελάτης|λογαριασμό μου/iu],
    ["material_business_opportunity", /\b(land|development|construction tender|institutional investor|family office|large investment|strategic partnership|major developer|corporate expansion)\b|أرض|تطوير|مناقصة|مستثمر مؤسسي|شراكة استراتيجية|επένδυση|ανάπτυξη/iu],
    ["sensitive_or_complex", /\b(legal|tax|immigration|visa|permit|license|bank approval|residency)\b|قانوني|ضريبة|هجرة|تأشيرة|تصريح|ترخيص|φορολογ|μετανάστε/iu]
  ]
});

function assessPriority({ text = "", intent, intents = [], metadata = {} } = {}) {
  const content = String(text || "");
  const intentList = [...new Set((Array.isArray(intent) ? intent : [intent, ...intents]).filter(Boolean).map((value) => String(value).toLowerCase().replace(/[\s-]+/g, "_")))];
  const triggers = [];
  for (const [name, pattern] of [...TRIGGERS.urgent, ...TRIGGERS.high]) if (pattern.test(content)) triggers.push(name);
  const customerNeedsSpecialHandling = intentList.some((value) => ["complaint", "existing_client"].includes(value));
  for (const value of intentList) if (["complaint", "existing_client"].includes(value)) {
    const trigger = value === "complaint" ? "complaint" : "existing_client";
    if (!triggers.includes(trigger)) triggers.push(trigger);
  }
  if (metadata.securityIncident === true && !triggers.includes("safety_or_threat")) triggers.push("safety_or_threat");
  const urgent = triggers.some((trigger) => ["safety_or_threat", "severe_complaint"].includes(trigger));
  const priorityBusinessIntent = intentList.some((value) => ["development", "construction", "land", "investment", "partnership"].includes(value));
  const handoverRequired = triggers.length > 0 || customerNeedsSpecialHandling;
  return { level: urgent ? "urgent" : triggers.length || priorityBusinessIntent ? "high" : "normal", triggers, handoverRequired };
}

function detectPriorityTriggers({ message = "", text = "", intent, intents = [], complaint = false, existingClient = false, metadata = {} } = {}) {
  const result = assessPriority({ text: [message, text].filter(Boolean).join(" "), intent, intents, metadata });
  if (complaint && !result.triggers.includes("complaint")) result.triggers.push("complaint");
  if (existingClient && !result.triggers.includes("existing_client")) result.triggers.push("existing_client");
  return result.triggers.map((id) => ({ id, priority: ["safety_or_threat", "severe_complaint"].includes(id) ? "urgent" : "high" }));
}

function evaluatePriority(input = {}) {
  const result = assessPriority(input);
  return { isPriority: result.handoverRequired, priority: result.level, triggers: detectPriorityTriggers(input), reasons: result.triggers };
}

module.exports = { TRIGGERS, assessPriority, detectPriorityTriggers, evaluatePriority };
