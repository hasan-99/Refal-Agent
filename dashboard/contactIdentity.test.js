import test from "node:test";
import assert from "node:assert/strict";
import { displayName } from "./contactIdentity.js";

test("conversation contact label prefers saved customer name over WhatsApp profile name", () => {
  const user = {
    profile: { name: "Rami Haddad", whatsappName: "Phone profile" },
    whatsapp: { pushName: "WhatsApp profile" }
  };

  assert.equal(displayName(user), "Rami Haddad");
});

test("manual name correction remains the highest-priority conversation label", () => {
  assert.equal(displayName({
    profile: { nameOverride: "Rami H.", name: "Rami Haddad" },
    whatsapp: { pushName: "WhatsApp profile" }
  }), "Rami H.");
});

test("WhatsApp name remains a fallback until the customer provides a name", () => {
  assert.equal(displayName({ whatsapp: { pushName: "WhatsApp profile" } }), "WhatsApp profile");
  assert.equal(displayName({ profile: { whatsappName: "Saved WhatsApp profile" } }), "Saved WhatsApp profile");
  assert.equal(displayName({}), "");
});

test("a greeting accidentally stored as a name falls back to the WhatsApp profile name", () => {
  assert.equal(displayName({ profile: { name: "مرحبا، شو خدماتكم", nameSource: "customer_stated" }, whatsapp: { pushName: "Hasan" } }), "Hasan");
});
