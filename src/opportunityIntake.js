const TYPES = Object.freeze({
  COMPANY_FORMATION: "company_formation",
  REAL_ESTATE: "real_estate",
  LAND_DEVELOPMENT: "land_development",
  CONSTRUCTION: "construction",
  INVESTMENT: "investment",
  PARTNERSHIP: "partnership",
  APPOINTMENT: "appointment"
});

const FIELDS = Object.freeze({
  company_formation: ["businessActivity", "existingBusiness", "countryOfResidence", "shareholderStructure", "numberOfShareholders", "corporateShareholders", "targetMarkets", "expectedOperations", "employees", "vatNeeds", "accountingNeeds", "bankingNeeds", "officeNeeds", "timeline"],
  real_estate: ["purpose", "propertyType", "location", "budget", "financing", "investmentObjective", "expectedYield", "timeline", "residencyConsideration"],
  land_development: ["location", "plotSize", "planningZone", "buildingDensity", "permits", "currentStatus", "cooperationStructure", "budget", "timeline"],
  construction: ["projectType", "location", "approximateSize", "projectStage", "planningPermit", "buildingPermit", "architecturalDrawings", "structuralDrawings", "boq", "tenderStatus", "expectedStartDate", "approximateProjectValue", "decisionProcess"],
  investment: ["country", "sector", "project", "developmentStage", "capitalRequirement", "investmentStructure", "ownership", "existingInvestors", "refalcoRole", "documentsAvailable", "revenueModel", "timeline"],
  partnership: ["company", "country", "sector", "proposedPartnership", "commercialModel", "refalcoRole", "decisionMakers", "projectSize", "timeline"],
  appointment: ["name", "phone", "email", "company", "topic", "language", "timezone", "format"]
});

function clean(value, max = 500) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function typeForIntents(intents = []) {
  const values = new Set(intents);
  if (values.has("company_formation") || values.has("accounting") || values.has("vat") || values.has("corporate_services")) return TYPES.COMPANY_FORMATION;
  if (values.has("land_owner") || values.has("property_development") || values.has("land_development")) return TYPES.LAND_DEVELOPMENT;
  if (values.has("construction_tender") || values.has("construction") || values.has("project_management")) return TYPES.CONSTRUCTION;
  if (values.has("real_estate_purchase") || values.has("real_estate_investment") || values.has("real_estate")) return TYPES.REAL_ESTATE;
  if (values.has("investment_opportunity") || values.has("investment_partnership") || values.has("investment")) return TYPES.INVESTMENT;
  if (values.has("strategic_partnership") || values.has("business_proposal") || values.has("partnership")) return TYPES.PARTNERSHIP;
  if (values.has("appointment")) return TYPES.APPOINTMENT;
  return null;
}
function intakeTypesForIntents(intents = []) {
  return [...new Set(intents.map((intent) => typeForIntents([intent])).filter(Boolean))];
}
function inferFacts(type, text) {
  const value = clean(text);
  if (!type || !value) return {};
  const facts = {};
  const locationMatch = value.match(/\b(?:in|at|located in)\s+([A-Za-z][\w -]{2,50}?)(?=\s+(?:with|for|and|where)\b|[,.]|$)/i) || value.match(/(?:في|بمدينة|في مدينة)\s+([\u0600-\u06ffA-Za-z][\u0600-\u06ffA-Za-z -]{1,50}?)(?=\s+(?:مع|و|بميزانية)|[،,.]|$)/iu) || value.match(/(?:στη|σε|στην)\s+([\u0370-\u03ffA-Za-z][\u0370-\u03ffA-Za-z -]{1,50}?)(?=\s+(?:με|και)(?=\s|$)|[,.]|$)/iu);
  if (locationMatch) facts.location = clean(locationMatch[1], 100);
  if (/\b(?:budget|worth|value|capital)\s*(?:is|of|:)?\s*([$€£]?\s?[\d,.]+\s*(?:m|million|k|thousand)?)\b/i.test(value)) facts.budget = clean(value.match(/\b(?:budget|worth|value|capital)\s*(?:is|of|:)?\s*([$€£]?\s?[\d,.]+\s*(?:m|million|k|thousand)?)\b/i)[1], 80);
  if (!facts.budget && /([$€£]\s?[\d,.]+\s*(?:m|million|k|thousand)?)\s+(?:value|budget|capital)\b/i.test(value)) facts.budget = clean(value.match(/([$€£]\s?[\d,.]+\s*(?:m|million|k|thousand)?)\s+(?:value|budget|capital)\b/i)[1], 80);
  if (!facts.budget) {
    const localBudget = value.match(/(?:ميزانية|قيمة|رأس المال|προϋπολογισμός|κεφάλαιο|αξία)\s*(?:هي|هو|:)?\s*([€$£]?\s*[\d,.]+\s*(?:مليون|ألف|million|thousand|εκ.?|χιλ.)?)/iu);
    if (localBudget) facts.budget = clean(localBudget[1], 80);
  }
  if (/\b(?:next week|next month|within \w+ months?|urgent|immediately|as soon as possible)\b/i.test(value)) facts.timeline = clean(value.match(/\b(?:next week|next month|within \w+ months?|urgent|immediately|as soon as possible)\b/i)[0], 80);
  if (!facts.timeline && /(?:الأسبوع القادم|الشهر القادم|خلال\s+\S+\s+أشهر|عاجل|فورًا|το επόμενο μήνα|άμεσα|επείγον)/iu.test(value)) facts.timeline = clean(value.match(/(?:الأسبوع القادم|الشهر القادم|خلال\s+\S+\s+أشهر|عاجل|فورًا|το επόμενο μήνα|άμεσα|επείγον)/iu)[0], 80);
  if (/\b(?:we own|i own|landowner|my plot)\b/i.test(value)) facts.currentStatus = "landowner_statement";
  if (/(?:أملك|نملك|مالك أرض|ιδιοκτήτης|έχω οικόπεδο)/iu.test(value)) facts.currentStatus = "landowner_statement";
  if (/\b(?:owner|director|ceo|investor|decision maker|principal)\b/i.test(value)) facts.decisionMakers = "customer_stated_decision_authority";
  if (/(?:المالك|المدير|الرئيس التنفيذي|المستثمر|صاحب القرار|ιδιοκτήτης|διευθυντής|επενδυτής)/iu.test(value)) facts.decisionMakers = "customer_stated_decision_authority";
  const labeled = (patterns, max = 240) => {
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) return clean(match[1], max);
    }
    return null;
  };
  if (type === TYPES.COMPANY_FORMATION) {
    facts.businessActivity = facts.businessActivity || labeled([/\b(?:business activity|activity|business type|sector)\s*[:=-]\s*([^.;,\n]+)/i, /(?:النشاط التجاري|نوع النشاط|القطاع)\s*[:：=-]\s*([^،؛,.\n]+)/iu, /(?:δραστηριότητα|κλάδος)\s*[:=-]\s*([^,.;\n]+)/iu]);
    facts.existingBusiness = facts.existingBusiness || labeled([/\b(?:existing|new)\s+business\s*[:=-]?\s*([^.;,\n]+)/i, /(?:شركة قائمة|شركة جديدة)\s*[:：=-]?\s*([^،؛,.\n]+)/iu]);
    facts.countryOfResidence = facts.countryOfResidence || labeled([/\b(?:country of residence|resident in|residing in)\s*[:=-]?\s*([^.;,\n]+)/i, /(?:بلد الإقامة|مقيم في)\s*[:：=-]?\s*([^،؛,.\n]+)/iu, /(?:χώρα κατοικίας|κάτοικος)\s*[:=-]?\s*([^,.;\n]+)/iu]);
    facts.shareholderStructure = facts.shareholderStructure || labeled([/\b(?:shareholder structure|ownership structure|shareholders?)\s*[:=-]\s*([^.;,\n]+)/i, /(?:هيكل المساهمين|المساهمون)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.numberOfShareholders = labeled([/\b(?:number of shareholders|shareholders?)\s*[:=-]\s*(\d+)/i, /(?:عدد المساهمين)\s*[:：=-]?\s*(\d+)/iu]) || (/(?:\b\d+\s+shareholders?\b|\bshareholders?\s+\d+\b)/i.test(value) ? (value.match(/\d+/) || [])[0] : null);
    facts.corporateShareholders = facts.corporateShareholders || labeled([/\b(?:corporate shareholders?|company shareholders?)\s*[:=-]\s*([^.;,\n]+)/i, /(?:مساهمون اعتباريون|شركة مساهمة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.targetMarkets = facts.targetMarkets || labeled([/\b(?:target markets?|target countries?)\s*[:=-]\s*([^.;\n]+)/i, /(?:الأسواق المستهدفة|الدول المستهدفة)\s*[:：=-]\s*([^،؛.\n]+)/iu]);
    facts.expectedOperations = facts.expectedOperations || labeled([/\b(?:expected operations?|operations in|will operate)\s*[:=-]?\s*([^.;\n]+)/i, /(?:العمليات المتوقعة|سيعمل في)\s*[:：=-]?\s*([^،؛.\n]+)/iu]);
    facts.employees = facts.employees || labeled([/\b(?:employees?|staff)\s*[:=-]\s*(\d+(?:\s*[-–]\s*\d+)?)/i, /(?:الموظفون|عدد الموظفين)\s*[:：=-]?\s*(\d+(?:\s*[-–]\s*\d+)?)/iu]);
    facts.vatNeeds = facts.vatNeeds || labeled([/\b(?:vat|vat registration)\s*(?:needs?|required)?\s*[:=-]\s*([^.;,\n]+)/i, /(?:ضريبة القيمة المضافة|تسجيل ضريبة القيمة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.accountingNeeds = facts.accountingNeeds || labeled([/\baccounting\s*(?:needs?|requirements?)\s*[:=-]\s*([^.;,\n]+)/i, /(?:احتياجات المحاسبة|متطلبات المحاسبة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.bankingNeeds = facts.bankingNeeds || labeled([/\bbanking\s*(?:needs?|requirements?)\s*[:=-]\s*([^.;,\n]+)/i, /(?:الاحتياجات المصرفية|متطلبات البنك)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.officeNeeds = facts.officeNeeds || labeled([/\boffice\s*(?:needs?|requirements?)\s*[:=-]\s*([^.;,\n]+)/i, /(?:احتياجات المكتب|متطلبات المكتب)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
  }
  if (type === TYPES.REAL_ESTATE) {
    facts.purpose = facts.purpose || labeled([/\b(?:purpose|use)\s*[:=-]\s*([^.;,\n]+)/i, /(?:الغرض|الاستخدام)\s*[:：=-]\s*([^،؛,.\n]+)/iu, /(?:σκοπός|χρήση)\s*[:=-]\s*([^,.;\n]+)/iu]);
    facts.propertyType = facts.propertyType || labeled([/\b(?:property type|type of property)\s*[:=-]\s*([^.;,\n]+)/i, /(?:نوع العقار)\s*[:：=-]\s*([^،؛,.\n]+)/iu, /(?:τύπος ακινήτου)\s*[:=-]\s*([^,.;\n]+)/iu]);
    facts.financing = facts.financing || labeled([/\b(?:financing|finance|cash or financing)\s*[:=-]\s*([^.;,\n]+)/i, /(?:التمويل|نقد أو تمويل)\s*[:：=-]\s*([^،؛,.\n]+)/iu, /(?:χρηματοδότηση|μετρητά)\s*[:=-]\s*([^,.;\n]+)/iu]);
    facts.investmentObjective = facts.investmentObjective || labeled([/\b(?:investment objective|objective|goal)\s*[:=-]\s*([^.;,\n]+)/i, /(?:هدف الاستثمار|الهدف)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.expectedYield = facts.expectedYield || labeled([/\b(?:expected yield|yield|return target)\s*[:=-]\s*([^.;,\n]+)/i, /(?:العائد المتوقع|هدف العائد)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.residencyConsideration = facts.residencyConsideration || labeled([/\b(?:residency|residency consideration)\s*[:=-]\s*([^.;,\n]+)/i, /(?:الإقامة|متطلبات الإقامة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
  }
  if (type === TYPES.LAND_DEVELOPMENT) {
    facts.plotSize = facts.plotSize || labeled([/\b(?:plot size|land size|site area)\s*[:=-]\s*([^.;,\n]+)/i, /(?:مساحة الأرض|مساحة القطعة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.planningZone = facts.planningZone || labeled([/\b(?:planning zone|zone)\s*[:=-]\s*([^.;,\n]+)/i, /(?:المنطقة التخطيطية|المنطقة)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.buildingDensity = facts.buildingDensity || labeled([/\b(?:building density|building coefficient|density)\s*[:=-]\s*([^.;,\n]+)/i, /(?:كثافة البناء|معامل البناء)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.permits = facts.permits || labeled([/\b(?:permits?|planning permission)\s*[:=-]\s*([^.;,\n]+)/i, /(?:التراخيص|رخصة التخطيط)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
    facts.cooperationStructure = facts.cooperationStructure || labeled([/\b(?:cooperation|partnership structure|sale|joint development|land exchange)\s*[:=-]\s*([^.;,\n]+)/i, /(?:هيكل التعاون|شراكة|بيع|تطوير مشترك|مبادلة الأرض)\s*[:：=-]\s*([^،؛,.\n]+)/iu]);
  }
  if (type === TYPES.CONSTRUCTION) {
    const aliases = { projectType: [/\bproject type\s*[:=-]\s*([^.;,\n]+)/i, /نوع المشروع\s*[:：=-]\s*([^،؛,.\n]+)/iu], approximateSize: [/\b(?:project size|approximate size|area)\s*[:=-]\s*([^.;,\n]+)/i, /(?:حجم المشروع|المساحة التقريبية)\s*[:：=-]\s*([^،؛,.\n]+)/iu], projectStage: [/\b(?:project stage|stage)\s*[:=-]\s*([^.;,\n]+)/i, /(?:مرحلة المشروع|المرحلة)\s*[:：=-]\s*([^،؛,.\n]+)/iu], planningPermit: [/\bplanning permit\s*[:=-]\s*([^.;,\n]+)/i, /تصريح التخطيط\s*[:：=-]\s*([^،؛,.\n]+)/iu], buildingPermit: [/\bbuilding permit\s*[:=-]\s*([^.;,\n]+)/i, /رخصة البناء\s*[:：=-]\s*([^،؛,.\n]+)/iu], architecturalDrawings: [/\barchitectural drawings?\s*[:=-]\s*([^.;,\n]+)/i, /المخططات المعمارية\s*[:：=-]\s*([^،؛,.\n]+)/iu], structuralDrawings: [/\bstructural drawings?\s*[:=-]\s*([^.;,\n]+)/i, /المخططات الإنشائية\s*[:：=-]\s*([^،؛,.\n]+)/iu], boq: [/\b(?:boq|bill of quantities)\s*[:=-]\s*([^.;,\n]+)/i, /جدول الكميات\s*[:：=-]\s*([^،؛,.\n]+)/iu], tenderStatus: [/\btender status\s*[:=-]\s*([^.;,\n]+)/i, /حالة المناقصة\s*[:：=-]\s*([^،؛,.\n]+)/iu], expectedStartDate: [/\b(?:expected start|start date)\s*[:=-]\s*([^.;,\n]+)/i, /تاريخ البدء المتوقع\s*[:：=-]\s*([^،؛,.\n]+)/iu], approximateProjectValue: [/\b(?:project value|approximate project value)\s*[:=-]\s*([^.;,\n]+)/i, /قيمة المشروع التقريبية\s*[:：=-]\s*([^،؛,.\n]+)/iu], decisionProcess: [/\bdecision process\s*[:=-]\s*([^.;,\n]+)/i, /عملية اتخاذ القرار\s*[:：=-]\s*([^،؛,.\n]+)/iu] };
    for (const [field, patterns] of Object.entries(aliases)) facts[field] = facts[field] || labeled(patterns);
  }
  if (type === TYPES.INVESTMENT) {
    const aliases = { country: [/\bcountry\s*[:=-]\s*([^.;,\n]+)/i, /الدولة\s*[:：=-]\s*([^،؛,.\n]+)/iu], sector: [/\bsector\s*[:=-]\s*([^.;,\n]+)/i, /القطاع\s*[:：=-]\s*([^،؛,.\n]+)/iu], project: [/\bproject\s*[:=-]\s*([^.;,\n]+)/i, /المشروع\s*[:：=-]\s*([^،؛,.\n]+)/iu], developmentStage: [/\bdevelopment stage\s*[:=-]\s*([^.;,\n]+)/i, /مرحلة التطوير\s*[:：=-]\s*([^،؛,.\n]+)/iu], capitalRequirement: [/\bcapital requirement\s*[:=-]\s*([^.;,\n]+)/i, /متطلبات رأس المال\s*[:：=-]\s*([^،؛,.\n]+)/iu], investmentStructure: [/\binvestment structure\s*[:=-]\s*([^.;,\n]+)/i, /هيكل الاستثمار\s*[:：=-]\s*([^،؛,.\n]+)/iu], ownership: [/\bownership\s*[:=-]\s*([^.;,\n]+)/i, /الملكية\s*[:：=-]\s*([^،؛,.\n]+)/iu], existingInvestors: [/\bexisting investors?\s*[:=-]\s*([^.;,\n]+)/i, /المستثمرون الحاليون\s*[:：=-]\s*([^،؛,.\n]+)/iu], refalcoRole: [/\b(?:business role|expected business role)\s*[:=-]\s*([^.;,\n]+)/i, /دور الشركة\s*[:：=-]\s*([^،؛,.\n]+)/iu], documentsAvailable: [/\bdocuments? available\s*[:=-]\s*([^.;,\n]+)/i, /المستندات المتاحة\s*[:：=-]\s*([^،؛,.\n]+)/iu], revenueModel: [/\brevenue model\s*[:=-]\s*([^.;,\n]+)/i, /نموذج الإيرادات\s*[:：=-]\s*([^،؛,.\n]+)/iu] };
    for (const [field, patterns] of Object.entries(aliases)) facts[field] = facts[field] || labeled(patterns);
  }
  if (type === TYPES.PARTNERSHIP) {
    const aliases = { company: [/\bcompany\s*[:=-]\s*([^.;,\n]+)/i, /الشركة\s*[:：=-]\s*([^،؛,.\n]+)/iu], sector: [/\bsector\s*[:=-]\s*([^.;,\n]+)/i, /القطاع\s*[:：=-]\s*([^،؛,.\n]+)/iu], proposedPartnership: [/\b(?:proposed partnership|partnership proposal)\s*[:=-]\s*([^.;,\n]+)/i, /اقتراح الشراكة\s*[:：=-]\s*([^،؛,.\n]+)/iu], commercialModel: [/\bcommercial model\s*[:=-]\s*([^.;,\n]+)/i, /النموذج التجاري\s*[:：=-]\s*([^،؛,.\n]+)/iu], refalcoRole: [/\b(?:business role|expected role)\s*[:=-]\s*([^.;,\n]+)/i, /دور الشركة\s*[:：=-]\s*([^،؛,.\n]+)/iu], decisionMakers: [/\bdecision makers?\s*[:=-]\s*([^.;,\n]+)/i, /صناع القرار\s*[:：=-]\s*([^،؛,.\n]+)/iu], projectSize: [/\bproject size\s*[:=-]\s*([^.;,\n]+)/i, /حجم المشروع\s*[:：=-]\s*([^،؛,.\n]+)/iu] };
    for (const [field, patterns] of Object.entries(aliases)) facts[field] = facts[field] || labeled(patterns);
  }
  if (type === TYPES.APPOINTMENT) {
    const aliases = { name: [/\b(?:my name is|name)\s*[:=-]?\s*([^.;,\n]+)/i, /(?:اسمي|الاسم)\s*[:：=-]?\s*([^،؛,.\n]+)/iu], email: [/\b(?:email|e-mail)\s*[:=-]\s*([^\s,;]+@[^\s,;]+)/i, /(?:البريد الإلكتروني|الإيميل)\s*[:：=-]\s*([^\s،؛,]+)/iu], company: [/\bcompany\s*[:=-]\s*([^.;,\n]+)/i, /(?:الشركة)\s*[:：=-]\s*([^،؛,.\n]+)/iu], topic: [/\b(?:topic|purpose|meeting about)\s*[:=-]\s*([^.;,\n]+)/i, /(?:موضوع الاجتماع|الغرض)\s*[:：=-]\s*([^،؛,.\n]+)/iu] };
    for (const [field, patterns] of Object.entries(aliases)) facts[field] = facts[field] || labeled(patterns);
  }
  return facts;
}
function updateIntake(existing = null, { intents = [], text = "", source = "customer_provided", now = new Date().toISOString() } = {}) {
  const type = existing?.type || typeForIntents(intents);
  if (!type) return existing || null;
  const allowed = new Set(FIELDS[type] || []);
  const facts = Object.fromEntries(Object.entries(inferFacts(type, text)).filter(([key, value]) => allowed.has(key) && value != null && value !== ""));
  const data = { ...(existing?.data || {}), ...facts };
  const provenance = { ...(existing?.provenance || {}) };
  for (const key of Object.keys(facts)) provenance[key] = source;
  return { type, data, provenance, status: "in_progress", updatedAt: now, missingFields: (FIELDS[type] || []).filter((field) => data[field] == null || data[field] === "") };
}
module.exports = { TYPES, FIELDS, typeForIntents, intakeTypesForIntents, inferFacts, updateIntake };
