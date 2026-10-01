const { assessPriority } = require("./priorityRules");
const { separateCustomerAndInternalMessages } = require("./handover");

function classifyComplaint(text = "") {
  const value = String(text || "");
  const isComplaint = /\b(complaint|complain|unhappy|dissatisfied|bad service|disappointed|problem|issue|wrong|delay)\b|شكوى|أشتكي|غير راض|مشكلة|تأخير|παράπονο|δυσαρεστημένος|πρόβλημα/iu.test(value);
  if (!isComplaint) return { isComplaint: false, severity: "none", triggers: [] };
  const priority = assessPriority({ text: value, intent: "complaint" });
  return { isComplaint: true, severity: priority.level, triggers: priority.triggers };
}

function complaintResponse(language = "english") {
  if (language === "arabic") return "أفهم أن هذا الأمر مزعج. سنسجل ملاحظتك ونوجّهها إلى الفريق المختص للمراجعة. ما التفاصيل الأساسية التي تريد مشاركتها؟";
  if (language === "greek") return "Κατανοώ ότι αυτό είναι ενοχλητικό. Θα καταγράψουμε το θέμα και θα το προωθήσουμε στην αρμόδια ομάδα για εξέταση. Ποια είναι η βασική λεπτομέρεια που θέλετε να μοιραστείτε;";
  return "I understand this has been frustrating. We’ll record the concern and send it to the appropriate team for review. What is the main detail you would like to share?";
}

function handleComplaint({ text = "", language = "english", customer = {}, notes = "" } = {}) {
  const classification = classifyComplaint(text);
  if (!classification.isComplaint) return { ...classification, messages: null, handoverRequired: false };
  const messages = separateCustomerAndInternalMessages({
    customerMessage: complaintResponse(language),
    internalMessage: `Complaint received. Severity: ${classification.severity}. Customer: ${String(customer.name || "not provided").slice(0, 120)}. Details: ${String(notes || text).replace(/\s+/g, " ").trim().slice(0, 1000)}`
  });
  return { ...classification, handoverRequired: true, messages };
}

module.exports = { classifyComplaint, complaintResponse, handleComplaint };
