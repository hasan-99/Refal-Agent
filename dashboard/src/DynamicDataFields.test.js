import test from "node:test";
import assert from "node:assert/strict";
import { fieldsFor, KINDS } from "./DynamicDataFields.js";

const requiredByKind = {
  offers: ["code", "title_en", "amount", "valid_from", "effective_from", "valid_until", "review_status", "source_note"],
  renewals: ["item", "amount", "period", "effective_from", "valid_until", "review_status", "source_note"],
  properties: ["reference", "city", "type", "status", "price", "effective_from", "valid_until", "review_status", "source_note"],
  reservations: ["project_or_property_id", "deposit_mode", "deposit_value", "effective_from", "valid_until", "review_status", "source_note"],
  governmentFees: ["fee_type", "amount", "authority", "effective_from", "valid_until", "review_status", "source_note"]
};

test("commercial forms have unique field names and preserve every required field", () => {
  for (const { id } of KINDS) {
    const fields = fieldsFor(id);
    const names = fields.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length, `${id} contains duplicate controls`);
    for (const name of requiredByKind[id]) {
      assert.equal(fields.find((item) => item.name === name)?.required, true, `${id}.${name} must stay required`);
    }
  }
});
