const TABLES = Object.freeze([
  { id: "offers", label: "Offers", match: /\b(?:offer|promotion|promotional|package|formation price|price list|discount)\b|عرض|عروض|خصم|πακέτο|προσφορά|έκπτωση/iu },
  { id: "renewals", label: "Renewal fees", match: /\b(?:renewal|annual fee|secretary fee|registered address|accounting fee|audit fee)\b|تجديد|رسوم سنوية|سكرتارية|محاسبة|τέλος ανανέωσης|ετήσια χρέωση/iu },
  { id: "properties", label: "Property inventory", match: /\b(?:property|unit|listing|apartment|villa|real estate|property reference|unit reference)\b|عقار|عقارات|شقة|فيلا|رقم العقار|مرجع العقار|ακίνητο|διαμέρισμα|βίλα|αριθμός ακινήτου/iu },
  { id: "reservations", label: "Reservation rules", match: /\b(?:deposit|reservation|booking fee|down payment)\b|عربون|وديعة|حجز|مقدم|προκαταβολή|κράτηση/iu },
  { id: "governmentFees", label: "Government fees", match: /\b(?:government fee|third.party fee|registration fee|land registry|stamp duty|permit fee)\b|رسوم حكومية|رسوم التسجيل|دائرة الأراضي|رسوم الترخيص|κυβερνητικά τέλη|κτηματολόγιο|τέλος άδειας/iu }
]);

const CURRENCY_AMOUNT = /(?:[€$£]\s*\p{N}[\p{N}.,'’ ]*|\b(?:EUR|USD|GBP|CHF|AED|TRY|CYP)\s*\p{N}[\p{N}.,'’ ]*|\p{N}[\p{N}.,'’ ]*\s*(?:EUR|USD|GBP|CHF|AED|TRY|CYP)\b|\p{N}[\p{N}.,'’ ]*\s*(?:يورو|دولار|جنيه|ليرة|ευρώ|δολάρια|λίρες))/iu;
const PROPERTY_REFERENCE = /\b(?:property|unit|listing|apartment|villa)\s*(?:reference|ref(?:erence)?|#|no\.?|number)\s*[:#-]?\s*[a-z0-9][a-z0-9/_-]{2,}\b|\b(?:PROP|PROPERTY|UNIT|CY)[-_][A-Z0-9][A-Z0-9/_-]{2,}\b|(?:مرجع|رقم)\s*(?:العقار|الوحدة|الشقة)\s*[:#-]?\s*[\p{L}\p{N}][\p{L}\p{N}/_-]{2,}|(?:αριθμός|κωδικός)\s*(?:ακινήτου|διαμερίσματος)\s*[:#-]?\s*[\p{L}\p{N}][\p{L}\p{N}/_-]{2,}/iu;

export function detectCommercialKnowledgeWarning(value) {
  const text = String(value || "");
  const currencyAmount = CURRENCY_AMOUNT.test(text);
  const propertyReference = PROPERTY_REFERENCE.test(text);
  if (!currencyAmount && !propertyReference) return null;

  const matches = TABLES.filter((table) => table.match.test(text));
  const byId = new Map(TABLES.map((table) => [table.id, table]));
  const targetId = ["governmentFees", "reservations", "renewals", "properties", "offers"].find((id) =>
    matches.some((table) => table.id === id) || (id === "properties" && propertyReference)
  );
  const target = targetId ? byId.get(targetId) : null;
  return {
    currencyAmount,
    propertyReference,
    target: target ? { id: target.id, label: target.label } : null,
    tables: TABLES.map(({ id, label }) => ({ id, label }))
  };
}

export const COMMERCIAL_DATA_TABLES = TABLES.map(({ id, label }) => ({ id, label }));
