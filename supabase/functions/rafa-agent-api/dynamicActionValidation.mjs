const LEAD_FIELDS = new Set(["name", "nationality", "residenceCountry", "primaryGoal", "budgetAmount", "budgetCurrency"]);
const CURRENCY_ALIASES = Object.freeze({ EUR: ["eur", "euro", "euros", "€", "يورو", "ευρώ"], GBP: ["gbp", "pound", "pounds", "£", "جنيه", "λίρες"], USD: ["usd", "dollar", "dollars", "$", "دولار", "δολار", "δολάρια"], CHF: ["chf", "franc", "francs"], AED: ["aed", "dirham", "dirhams", "درهم"] });

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function normalizedDigits(value) {
  return String(value ?? "").replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/\D/gu, "");
}

function validateCustomerLeadFields(profile, sourceMessage) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || !Object.keys(profile).length) return false;
  const source = normalizedText(sourceMessage);
  if (!source) return false;
  const rawSource = String(sourceMessage).normalize("NFKC").toLocaleLowerCase();
  for (const [field, value] of Object.entries(profile)) {
    if (!LEAD_FIELDS.has(field)) return false;
    if (typeof value === "boolean") return false;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || field !== "budgetAmount" || !normalizedDigits(source).includes(normalizedDigits(value))) return false;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) return false;
    if (field === "budgetCurrency") {
      const currency = value.trim().toUpperCase();
      if (!Object.hasOwn(CURRENCY_ALIASES, currency)) return false;
      if (!CURRENCY_ALIASES[currency].some((alias) => rawSource.includes(alias.toLocaleLowerCase()))) return false;
      continue;
    }
    const candidate = normalizedText(value);
    if (candidate.length < 2 || !source.includes(candidate)) return false;
  }
  const amount = profile.budgetAmount;
  const currency = profile.budgetCurrency;
  if ((amount === undefined) !== (currency === undefined)) return false;
  if (amount !== undefined) {
    const asciiDigits = rawSource.replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/٬/gu, ",").replace(/٫/gu, ".");
    const amountMatch = [...asciiDigits.matchAll(/\d[\d,.]*/gu)].find((match) => Number(match[0].replace(/,/g, "")) === amount);
    if (!amountMatch) return false;
    const closestCurrency = Object.entries(CURRENCY_ALIASES).flatMap(([code, aliases]) => aliases.flatMap((alias) => {
      const index = asciiDigits.indexOf(alias.toLocaleLowerCase());
      return index < 0 ? [] : [{ code, distance: Math.abs(index - amountMatch.index) }];
    })).sort((a, b) => a.distance - b.distance)[0];
    if (!closestCurrency || closestCurrency.code !== currency || closestCurrency.distance > 40) return false;
  }
  return true;
}

export { validateCustomerLeadFields };
