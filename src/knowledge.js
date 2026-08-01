const fs = require("node:fs");

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadCompany(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findCompanyAnswer(company, text) {
  const normalized = normalize(text);

  if (!normalized) {
    return company.fallbackAnswer;
  }

  if (["about", "company", "info", "information"].includes(normalized)) {
    return `${company.companyName}: ${company.shortDescription}`;
  }

  if (["services", "service"].includes(normalized)) {
    return `Services:\n- ${company.services.join("\n- ")}`;
  }

  for (const faq of company.faqs || []) {
    const found = (faq.keywords || []).some((keyword) => {
      return normalized.includes(normalize(keyword));
    });

    if (found) return faq.answer;
  }

  return company.fallbackAnswer;
}

module.exports = { findCompanyAnswer, loadCompany, normalize };
