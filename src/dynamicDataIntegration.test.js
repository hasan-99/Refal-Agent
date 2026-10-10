"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TOOL_REGISTRY } = require("./agentTools");
const { buildDecisionMessages } = require("./agentDecision");

test("CF-05: changed current offers win, while expired or missing offers suppress frozen prices", async () => {
  const now = Date.now();
  const knowledge = [{
    chunk_id: "approved-formation-doc", sourceRef: "approved-formation-doc",
    document_id: "formation-doc", document_title: "Company formation package",
    heading: "What is included",
    content: "The Cyprus company formation package includes incorporation and name reservation. The historical published package price was EUR 899.",
    review_status: "approved", valid_until: new Date(now + 86400000 * 365).toISOString()
  }];
  const currentOffer = (overrides = {}) => ({
    code: "formation-package", title_en: "Cyprus company formation package", amount: 999, currency: "EUR",
    vat_note: "plus VAT", inclusions: ["Company incorporation", "Company name reservation"], eligibility: null,
    active: true, review_status: "approved", effective_from: new Date(now - 86400000).toISOString(),
    valid_until: new Date(now + 86400000 * 30).toISOString(), verified_at: new Date(now - 86400000).toISOString(),
    updated_at: new Date(now - 3600000).toISOString(), ...overrides
  });
  const scenarios = [
    { name: "current original price", response: { ok: true, status: "available", data: [currentOffer()] }, expectedPrice: "999", expectedInclusions: true },
    { name: "changed live price", response: { ok: true, status: "available", data: [currentOffer({ amount: 1249 })] }, expectedPrice: "1249", expectedInclusions: true },
    { name: "expired offer", response: { ok: true, status: "available", data: [currentOffer({ valid_until: new Date(now - 1000).toISOString() })] }, expectedPrice: null },
    { name: "missing offer", response: { ok: false, status: "unavailable", data: [] }, expectedPrice: null }
  ];
  for (const scenario of scenarios) {
    const store = {
      async searchKnowledge() { return knowledge; },
      async lookupDynamicData() { return scenario.response; }
    };
    const retrieved = await TOOL_REGISTRY.searchApprovedKnowledge.run({ query: "Cyprus company formation package inclusions and current price" }, { store });
    const offer = await TOOL_REGISTRY.lookupActiveOffer.run({ code: "formation-package" }, { store });
    const messages = buildDecisionMessages({ currentMessage: "What is included in the current company formation package and how much is it?", recentConversation: [] }, [
      { step: 1, tool: "searchApprovedKnowledge", args: { query: "formation package" }, result: retrieved },
      { step: 2, tool: "lookupActiveOffer", args: { code: "formation-package" }, result: offer }
    ]);
    const prompt = messages.map((message) => message.content).join("\n");
    assert.equal(prompt.includes("EUR 899"), false, scenario.name);
    if (scenario.expectedPrice) {
      assert.ok(prompt.includes(scenario.expectedPrice), scenario.name);
      assert.match(prompt, /Company name reservation/u);
    } else {
      assert.match(prompt, /unavailable/u, scenario.name);
      assert.match(prompt, /Stale approved chunks excluded by source precedence: approved-formation-doc/u, scenario.name);
    }
  }
});
