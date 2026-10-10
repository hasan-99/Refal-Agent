import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSalesOfferMetadata, validateSpecialistOfferMetadata } from "./salesOfferMetadata.mjs";

test("sales offer persistence accepts only a hook type and the six known ids", () => {
  for (const id of ["H1_IP_BOX", "H2_RESIDENCY", "H3_RELOCATION", "H4_SUBSTANCE", "H5_TRADEMARK", "H6_PR_TO_PROPERTY"]) {
    assert.deepEqual(validateSalesOfferMetadata({ type: "hook", id }), { type: "hook", id });
  }
});

test("sales offer persistence rejects arbitrary fields and forged offer types", () => {
  for (const value of [null, [], { type: "hook", id: "H7" }, { type: "booking", id: "H1_IP_BOX" }, { type: "hook", id: "H1_IP_BOX", consent: true }]) {
    assert.equal(validateSalesOfferMetadata(value), null);
  }
});

test("specialist offer persistence accepts only consent-required offers with a valid timestamp", () => {
  const value = { offered: true, consentRequired: true, offeredAt: "2026-10-10T12:00:00.000Z" };
  assert.deepEqual(validateSpecialistOfferMetadata(value), value);
  for (const invalid of [null, [], {}, { ...value, offered: false }, { ...value, consentRequired: false },
    { ...value, offeredAt: "tomorrow" }, { ...value, phone: "+35700000000" }]) {
    assert.equal(validateSpecialistOfferMetadata(invalid), null);
  }
});
