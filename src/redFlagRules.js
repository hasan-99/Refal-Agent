const RULES = Object.freeze([
  ["spam", /\b(?:buy followers|click here|free money|crypto giveaway|mass message|spam)\b|رسائل جماعية|مال مجاني|احتيال/iu],
  ["fake_or_unrealistic", /\b(?:guarantee me|guaranteed profit|guaranteed approval|no documents needed|instant approval|make me rich|unrealistic|too good to be true|fake documents|invent a company|make money overnight)\b|ربح مضمون|موافقة فورية|بدون مستندات|ثراء سريع|مستندات مزورة|شركة وهمية/iu],
  ["no_commercial_objective", /^(?:just browsing|just looking|nothing specific|لا شيء محدد|مجرد تصفح|مجرد استفسار)$/iu],
  ["employment_enquiry", /\b(?:job|career|vacancy|hiring|employment|work for|looking for a job|want to work at)\b|وظيفة|توظيف|عمل لدى|أبحث عن وظيفة|καριέρα|θέση εργασίας/iu],
  ["confidentiality_pressure", /\b(?:send me passwords|give me credentials|secret account|confidential data now|send confidential documents|ignore compliance|bypass kyc)\b|أرسل كلمة المرور|أرسل المستندات السرية|تجاوز التحقق|بيانات سرية/iu],
  ["no_authority", /\b(?:i do not decide|i don't decide|not the decision maker|just researching for|on behalf of someone else|need approval from my boss)\b|لست صاحب القرار|أبحث نيابة عن|أحتاج موافقة مديري|δεν αποφασίζω|για λογαριασμό άλλου/iu],
  ["refuses_qualification", /\b(?:no questions|do not ask questions|i will not provide details|won't share any information|just give me a quote without details)\b|لا تسألني|لن أقدم أي معلومات|أعطني سعراً دون تفاصيل|μην κάνετε ερωτήσεις/iu],
  ["employment_disguised_as_investment", /\b(?:invest in me|fund my salary|investment for a job|pay me to relocate|job disguised as investment)\b|استثمار في راتبي|وظيفة على شكل استثمار|επένδυση για δουλειά/iu]
]);
function assessRedFlags(text, { profile = {} } = {}) {
  const value = String(text || "").trim();
  const flags = RULES.filter(([, pattern]) => pattern.test(value)).map(([id]) => id);
  if (!flags.includes("no_commercial_objective") && !profile.need && /^(?:just looking|only checking|not sure what I need|لا أعرف ماذا أريد|لا أعرف ما أحتاجه)$/iu.test(value)) flags.push("no_commercial_objective");
  const unique = [...new Set(flags)];
  return { flags: unique, highRisk: unique.some((flag) => ["spam", "fake_or_unrealistic", "confidentiality_pressure", "employment_disguised_as_investment"].includes(flag)), shouldAvoidEscalation: unique.includes("spam") || unique.includes("no_commercial_objective"), shouldClarify: unique.includes("no_commercial_objective") || unique.includes("refuses_qualification") };
}
module.exports = { RULES, assessRedFlags };
