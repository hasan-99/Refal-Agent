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
  return findCompanyAnswerMatch(company, text).answer;
}

function findCompanyAnswerMatch(company, text) {
  const normalized = normalize(text);

  if (!normalized) {
    return { answer: company.fallbackAnswer, matched: false };
  }

  if (["about", "company", "info", "information"].includes(normalized)) {
    return {
      answer: `${company.companyName}: ${company.shortDescription}`,
      matched: true
    };
  }

  if (["services", "service"].includes(normalized)) {
    return {
      answer: `Services:\n- ${company.services.join("\n- ")}`,
      matched: true
    };
  }

  for (const faq of company.faqs || []) {
    const found = (faq.keywords || []).some((keyword) => {
      return normalized.includes(normalize(keyword));
    });

    if (found) return { answer: faq.answer, matched: true };
  }

  return { answer: company.fallbackAnswer, matched: false };
}

module.exports = { findCompanyAnswer, findCompanyAnswerMatch, loadCompany, normalize };
