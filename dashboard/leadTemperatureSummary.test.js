import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadTemperatureSummary, summarizeLeadTemperatures } from "./src/leadTemperatureSummary.js";

test("lead temperature summary renders zero counts and zero percentages for an empty lead list", () => {
  const html = renderToStaticMarkup(React.createElement(LeadTemperatureSummary, { leads: [] }));
  assert.match(html, /aria-label="Lead temperatures for contacts with conversation history"/);
  for (const label of ["Hot", "Warm", "Cold", "New"]) {
    assert.match(html, new RegExp(`${label}: 0 chat contacts`));
    assert.match(html, /0% of chat contacts/);
  }
  assert.deepEqual(summarizeLeadTemperatures([]).map(({ count, percent }) => [count, percent]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
});

test("lead temperature summary excludes retained leads without conversation history", () => {
  const leads = [
    { leadTemperatureStatus: "hot", conversationCount: 1 },
    { leadTemperatureStatus: "hot", conversationCount: 2 },
    { leadTemperatureStatus: "warm", conversationCount: 3 },
    { leadTemperatureStatus: "cold", conversationCount: 1 },
    { leadTemperatureStatus: "unclassified", conversationCount: 1 },
    { leadTemperatureStatus: "warm", conversationCount: 0 }
  ];
  const summary = summarizeLeadTemperatures(leads);
  assert.deepEqual(summary.map(({ label, count, percent }) => [label, count, percent]), [
    ["Hot", 2, 40], ["Warm", 1, 20], ["Cold", 1, 20], ["New", 1, 20]
  ]);
  const html = renderToStaticMarkup(React.createElement(LeadTemperatureSummary, { leads }));
  assert.match(html, /40% of chat contacts/);
  assert.equal((html.match(/20% of chat contacts/g) || []).length, 3);
  assert.match(html, /Warm: 1 chat contacts/);
  const afterDeletion = summarizeLeadTemperatures(leads.map((lead) => ({ ...lead, conversationCount: 0 })));
  assert.deepEqual(afterDeletion.map(({ count, percent }) => [count, percent]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
});
