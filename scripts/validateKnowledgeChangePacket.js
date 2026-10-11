"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DOMAINS, TRUST_TIERS, topicBySlug } = require("../src/brainTaxonomy");

const REGULATED_DOMAINS = new Set([DOMAINS.LEGAL, DOMAINS.TAX, DOMAINS.RESIDENCY, DOMAINS.COMPLIANCE]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  if (!nonEmpty(value) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(value)) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const normalized = date.toISOString().replace(/\.000Z$/u, "Z");
  if (value.length === 10) return normalized.slice(0, 10) === value;
  return value.endsWith(".000Z") ? `${normalized.slice(0, -1)}.000Z` === value : normalized === value;
}

/**
 * Validate intake metadata before staff save a knowledge revision.
 * This is a local completeness check; it does not grant approval or make a
 * claim safe to publish. The dashboard/database review decision remains the
 * authority for customer-facing use.
 */
function validateKnowledgeChangePacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return ["Packet must be a JSON object."];
  }

  for (const field of ["changeId", "title", "summary", "owner", "submittedBy", "topic", "domain", "language", "effectiveFrom", "expiresAt"]) {
    if (!nonEmpty(packet[field])) errors.push(`${field} is required.`);
  }
  if (packet.status !== "draft") errors.push("status must be 'draft'; intake must not publish knowledge.");
  if (!Object.values(DOMAINS).includes(packet.domain)) errors.push(`domain must be one of: ${Object.values(DOMAINS).join(", ")}.`);
  if (!["en", "ar", "el"].includes(packet.language)) errors.push("language must be en, ar, or el.");
  const topic = nonEmpty(packet.topic) ? topicBySlug(packet.topic.trim()) : null;
  if (nonEmpty(packet.topic) && !topic) errors.push("topic must be an existing knowledge topic slug.");
  if (topic && topic.domain !== packet.domain) errors.push(`topic ${topic.slug} belongs to ${topic.domain}, not ${packet.domain}.`);

  if (!packet.source || typeof packet.source !== "object" || Array.isArray(packet.source)) {
    errors.push("source must include a reference and source type.");
  } else {
    if (!nonEmpty(packet.source.reference)) errors.push("source.reference is required.");
    if (!nonEmpty(packet.source.type)) errors.push("source.type is required.");
  }

  if (!packet.reviewer || typeof packet.reviewer !== "object" || Array.isArray(packet.reviewer)) {
    errors.push("reviewer must identify a qualified reviewer before submission.");
  } else {
    if (!nonEmpty(packet.reviewer.name)) errors.push("reviewer.name is required.");
    if (!nonEmpty(packet.reviewer.qualification)) errors.push("reviewer.qualification is required.");
    if (nonEmpty(packet.submittedBy) && nonEmpty(packet.reviewer.name)
      && namesMayReferToSamePerson(packet.submittedBy, packet.reviewer.name)) {
      errors.push("reviewer.name must differ from submittedBy; review must be independent.");
    }
  }

  const regulated = REGULATED_DOMAINS.has(packet.domain) || topic?.tier === TRUST_TIERS.REGULATED || packet.sensitive === true;
  if (regulated && !nonEmpty(packet.subjectExpert)) {
    errors.push("subjectExpert is required for taxonomy-regulated or explicitly sensitive claims.");
  }

  if (nonEmpty(packet.effectiveFrom) && !isIsoDate(packet.effectiveFrom)) errors.push("effectiveFrom must be a valid ISO date or UTC timestamp.");
  if (nonEmpty(packet.expiresAt) && !isIsoDate(packet.expiresAt)) errors.push("expiresAt must be a valid ISO date or UTC timestamp.");
  if (isIsoDate(packet.effectiveFrom) && isIsoDate(packet.expiresAt) && Date.parse(packet.expiresAt) <= Date.parse(packet.effectiveFrom)) {
    errors.push("expiresAt must be later than effectiveFrom.");
  }

  return errors;
}

function personNameTokens(value) {
  return String(value).normalize("NFKD").toLocaleLowerCase("und")
    .replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function namesMayReferToSamePerson(left, right) {
  const leftTokens = personNameTokens(left);
  const rightTokens = personNameTokens(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const covers = (shorter, longer) => shorter.every((token) => longer.some((candidate) =>
    token === candidate || (token.length === 1 && candidate.startsWith(token))
  ));
  return covers(leftTokens, rightTokens) || covers(rightTokens, leftTokens);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    process.stderr.write("Usage: node scripts/validateKnowledgeChangePacket.js <packet.json>\n");
    return 2;
  }
  const file = path.resolve(process.cwd(), argv[0]);
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`Invalid packet JSON: ${error.message}\n`);
    return 2;
  }
  const errors = validateKnowledgeChangePacket(packet);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`FAIL ${error}\n`);
    return 1;
  }
  process.stdout.write(`PASS intake metadata complete for ${packet.changeId}; remains DRAFT and unavailable to REFAL until independently reviewed and approved.\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { validateKnowledgeChangePacket, main, isIsoDate };
