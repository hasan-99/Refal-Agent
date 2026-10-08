"use strict";

// P0.4 / W0.4.1 + W0.4.2 — the FROZEN knowledge taxonomy.
//
// 25 MB topics + 4 jurisdiction comparison topics = 29 topics.
// 29 topics x 3 languages = 87 knowledge sources.
//
// This file is the single source of truth for topic slugs. Changing a slug is a
// breaking change: canonical_url is unique and not null in the database, so a
// renamed slug orphans every stored revision for that topic.

// ---------------------------------------------------------------- trust tiers
// The tier decides HOW MUCH provenance Rule 2 demands before a fact may be said.
const TRUST_TIERS = Object.freeze({
  // Law, regulator or government authority. Wrong = legal/compliance exposure.
  // Requires: named reviewer + authority source URL + effective date + expiry.
  REGULATED: "regulated",
  // Refalco's own commercial terms. Wrong = a mis-sold price.
  // Requires: owner approval + effective date + expiry.
  COMMERCIAL: "commercial",
  // General explanatory content. Wrong = a confused customer, no legal exposure.
  // Requires: reviewer + verified date.
  EXPLANATORY: "explanatory",
});

const VOLATILITY = Object.freeze({ STABLE: "STABLE", VOLATILE: "VOLATILE" });

// Review cadence in days, derived, never hand-set, so it cannot drift per row.
function reviewCadenceDays(volatility, trustTier) {
  if (volatility === VOLATILITY.VOLATILE) return 30;
  if (trustTier === TRUST_TIERS.REGULATED) return 180;
  return 365;
}

const DOMAINS = Object.freeze({
  CORPORATE: "corporate",
  COMPLIANCE: "compliance",
  TAX: "tax",
  BANKING: "banking",
  RESIDENCY: "residency",
  REAL_ESTATE: "real-estate",
  DEVELOPMENT: "development",
  LEGAL: "legal",
  IDENTITY: "identity",
  COMPARISON: "comparison",
});

const RAW_TOPICS = [
  // # 1-8 Corporate
  { n: 1, slug: "company-lifecycle", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.1" },
  { n: 2, slug: "formation-package", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.COMMERCIAL, mbRef: "2.1" },
  { n: 3, slug: "company-structures", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.1" },
  { n: 4, slug: "shareholder-vs-director", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.1" },
  { n: 5, slug: "ownership-changes", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.1" },
  { n: 6, slug: "registered-vs-physical-office", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.1" },
  { n: 7, slug: "privacy-vs-concealment", domain: DOMAINS.COMPLIANCE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.1" },
  { n: 8, slug: "dormant-and-liquidation", domain: DOMAINS.CORPORATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.1" },
  // # 9-13 Tax
  { n: 9, slug: "corporate-tax", domain: DOMAINS.TAX, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.REGULATED, mbRef: "2.2" },
  { n: 10, slug: "ip-box", domain: DOMAINS.TAX, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.REGULATED, mbRef: "2.2" },
  { n: 11, slug: "dividends-vs-salary", domain: DOMAINS.TAX, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.2" },
  { n: 12, slug: "holding-vs-trading", domain: DOMAINS.TAX, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.2" },
  { n: 13, slug: "vat-and-eori", domain: DOMAINS.TAX, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.2" },
  // # 14 Banking
  { n: 14, slug: "banking-and-payment-gateways", domain: DOMAINS.BANKING, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.3" },
  // # 15-18 Residency
  { n: 15, slug: "permanent-residency", domain: DOMAINS.RESIDENCY, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.REGULATED, mbRef: "2.4" },
  { n: 16, slug: "non-dom-status", domain: DOMAINS.RESIDENCY, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.REGULATED, mbRef: "2.4" },
  { n: 17, slug: "source-of-funds-vs-wealth", domain: DOMAINS.COMPLIANCE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.4" },
  { n: 18, slug: "relocation-checklist", domain: DOMAINS.RESIDENCY, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.4" },
  // # 19-22 Real estate
  { n: 19, slug: "property-buyer-journey", domain: DOMAINS.REAL_ESTATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.5" },
  { n: 20, slug: "offplan-vs-completed", domain: DOMAINS.REAL_ESTATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.5" },
  { n: 21, slug: "property-vat", domain: DOMAINS.REAL_ESTATE, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.REGULATED, mbRef: "2.5" },
  { n: 22, slug: "cyprus-cities", domain: DOMAINS.REAL_ESTATE, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.5" },
  // # 23-24 Legal / development
  { n: 23, slug: "landowners-and-construction", domain: DOMAINS.DEVELOPMENT, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.6" },
  { n: 24, slug: "legal-ip-contracts", domain: DOMAINS.LEGAL, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.REGULATED, mbRef: "2.6" },
  // # 25 Identity
  { n: 25, slug: "company-profile", domain: DOMAINS.IDENTITY, volatility: VOLATILITY.VOLATILE, tier: TRUST_TIERS.COMMERCIAL, mbRef: "2.0" },
  // # 26-29 Jurisdiction comparisons
  { n: 26, slug: "jurisdiction-dubai", domain: DOMAINS.COMPARISON, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "3.3" },
  { n: 27, slug: "jurisdiction-estonia", domain: DOMAINS.COMPARISON, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "3.3" },
  { n: 28, slug: "jurisdiction-malta-bulgaria", domain: DOMAINS.COMPARISON, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "3.3" },
  { n: 29, slug: "jurisdiction-usa", domain: DOMAINS.COMPARISON, volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "3.3" },
];

const LANGUAGES = Object.freeze(["ar", "en", "el"]);

// W0.4.2 — source URI convention.
// canonical_url is UNIQUE NOT NULL, so every topic/language pair needs a stable,
// collision-free URI. Scheme: refal://kb/<domain>/<slug>/<lang>
function canonicalUrl(topicSlug, lang) {
  const topic = TOPICS.find((t) => t.slug === topicSlug);
  if (!topic) throw new Error(`Unknown topic slug: ${topicSlug}`);
  if (!LANGUAGES.includes(lang)) throw new Error(`Unknown language: ${lang}`);
  return `refal://kb/${topic.domain}/${topic.slug}/${lang}`;
}

const CANONICAL_URL_PATTERN = /^refal:\/\/kb\/[a-z-]+\/[a-z0-9-]+\/(?:ar|en|el)$/u;

const TOPICS = Object.freeze(RAW_TOPICS.map((t) => Object.freeze({
  ...t,
  reviewCadenceDays: reviewCadenceDays(t.volatility, t.tier),
})));

// A VOLATILE topic must never be served from a frozen knowledge chunk. Each one
// is either backed by an M4 dynamic table or carries a hard expiry (MB-DYN1..6).
const VOLATILE_BACKING = Object.freeze({
  "formation-package": "refal_offers_and_pricing",   // the €999 offer, M4 P4.1
  "corporate-tax": "expiry-policy",                   // 15% from 2026, authority-sourced
  "ip-box": "expiry-policy",
  "permanent-residency": "expiry-policy",             // €300,000 thresholds
  "non-dom-status": "expiry-policy",                  // 17 year window
  "property-vat": "expiry-policy",                    // reduced 5% conditions
  "company-profile": "refal_company_profile",         // credibility numbers, M4
});

function topicBySlug(slug) { return TOPICS.find((t) => t.slug === slug) || null; }
function topicsByDomain(domain) { return TOPICS.filter((t) => t.domain === domain); }
function volatileTopics() { return TOPICS.filter((t) => t.volatility === VOLATILITY.VOLATILE); }
function expectedSourceCount() { return TOPICS.length * LANGUAGES.length; }

module.exports = {
  TRUST_TIERS, VOLATILITY, DOMAINS, TOPICS, LANGUAGES, VOLATILE_BACKING,
  CANONICAL_URL_PATTERN, canonicalUrl, reviewCadenceDays,
  topicBySlug, topicsByDomain, volatileTopics, expectedSourceCount,
};
