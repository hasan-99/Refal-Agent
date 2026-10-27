"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateKnowledgeChangePacket, isIsoDate } = require("./validateKnowledgeChangePacket");
const { seedRegister, STATUS } = require("../src/factRegister");

test("generated fact review packet accounts for every pending register row", () => {
  const packetPath = path.join(__dirname, "..", "docs", "brain", "FACT-APPROVAL-REVIEW-PACKET.md");
  const packet = fs.readFileSync(packetPath, "utf8");
  const pending = [...seedRegister().values()].filter((item) => item.status === STATUS.PENDING);
  for (const item of pending) {
    const heading = new RegExp(`^### ${item.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "gmu");
    assert.equal([...packet.matchAll(heading)].length, 1, `${item.id} must appear exactly once in the review packet`);
  }
  assert.match(packet, new RegExp(`register currently contains ${pending.length} pending facts`, "u"));
  assert.match(packet, /## Pending facts not used in static corpus/u);
});

const validPacket = {
  changeId: "KB-2026-0042",
  title: "Company registration document change",
  summary: "Update the document checklist from the current official source.",
  owner: "Corporate Services",
  submittedBy: "Hassan A.",
  topic: "formation-package",
  domain: "corporate",
  language: "en",
  source: { type: "government authority", reference: "https://example.gov.cy/company-guidance" },
  effectiveFrom: "2026-10-01",
  expiresAt: "2027-10-01",
  status: "draft",
  reviewer: { name: "Review Owner", qualification: "Corporate services lead" }
};

test("intake packet accepts complete, future-expiring draft metadata", () => {
  assert.deepEqual(validateKnowledgeChangePacket(validPacket), []);
});

test("intake packet rejects missing provenance, owner, dates, or assigned reviewer", () => {
  const packet = { ...validPacket, source: {}, owner: "", expiresAt: "", reviewer: {} };
  const errors = validateKnowledgeChangePacket(packet).join("\n");
  for (const field of ["owner", "source.reference", "source.type", "expiresAt", "reviewer.name", "reviewer.qualification"]) {
    assert.match(errors, new RegExp(field.replace(".", "\\.")));
  }
});

test("regulated and explicitly sensitive claims require a named subject expert", () => {
  assert.match(validateKnowledgeChangePacket({ ...validPacket, domain: "tax", topic: "corporate-tax" }).join(" "), /subjectExpert is required/u);
  assert.match(validateKnowledgeChangePacket({ ...validPacket, domain: "banking", topic: "banking-and-payment-gateways" }).join(" "), /subjectExpert is required/u);
  assert.match(validateKnowledgeChangePacket({ ...validPacket, domain: "real-estate", topic: "property-vat" }).join(" "), /subjectExpert is required/u);
  assert.match(validateKnowledgeChangePacket({ ...validPacket, sensitive: true }).join(" "), /subjectExpert is required/u);
  assert.deepEqual(validateKnowledgeChangePacket({ ...validPacket, domain: "legal", topic: "legal-ip-contracts", subjectExpert: "Legal adviser" }), []);
});

test("intake requires the topic to match its domain and a reviewer independent from submitter", () => {
  const mismatch = validateKnowledgeChangePacket({ ...validPacket, topic: "banking-and-payment-gateways" }).join(" ");
  assert.match(mismatch, /belongs to banking, not corporate/u);
  const sameReviewer = validateKnowledgeChangePacket({ ...validPacket, submittedBy: "Review Owner", reviewer: { ...validPacket.reviewer, name: " review-owner " } }).join(" ");
  assert.match(sameReviewer, /must differ from submittedBy/u);
  for (const reviewerName of ["Hassan", "Ahmad Hassan", "Hassan A."]) {
    const abbreviated = validateKnowledgeChangePacket({ ...validPacket, submittedBy: "Hassan Ahmad", reviewer: { ...validPacket.reviewer, name: reviewerName } }).join(" ");
    assert.match(abbreviated, /must differ from submittedBy/u);
  }
  assert.deepEqual(validateKnowledgeChangePacket({ ...validPacket, submittedBy: "Hassan Ahmad" }), []);
  assert.deepEqual(validateKnowledgeChangePacket({
    ...validPacket, topic: "banking-and-payment-gateways", domain: "banking", subjectExpert: "Banking compliance specialist"
  }), []);
});

test("packet cannot skip draft status or use unsupported language/domain", () => {
  const errors = validateKnowledgeChangePacket({ ...validPacket, status: "approved", language: "fr", domain: "unknown" }).join("\n");
  assert.match(errors, /status must be 'draft'/u);
  assert.match(errors, /language must be en, ar, or el/u);
  assert.match(errors, /domain must be one of/u);
});

test("expiry must be a valid ISO date later than its effective date", () => {
  assert.match(validateKnowledgeChangePacket({ ...validPacket, expiresAt: "not-a-date" }).join(" "), /expiresAt must be a valid ISO/u);
  assert.match(validateKnowledgeChangePacket({ ...validPacket, expiresAt: "2026-09-30" }).join(" "), /later than effectiveFrom/u);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-10-01T14:30:00.000Z"), true);
});

test("non-object packets fail closed", () => {
  assert.deepEqual(validateKnowledgeChangePacket(null), ["Packet must be a JSON object."]);
});
