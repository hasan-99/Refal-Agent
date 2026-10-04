import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadTemperatureSummary, summarizeLeadTemperatures } from "./src/leadTemperatureSummary.js";

test("lead temperature summary renders zero counts and zero percentages for an empty lead list", () => {
  const html = renderToStaticMarkup(React.createElement(LeadTemperatureSummary, { leads: [] }));
  assert.match(html, /aria-label="Lead temperature distribution"/);
  for (const label of ["Hot", "Warm", "Cold", "New"]) {
    assert.match(html, new RegExp(`${label}: 0 leads`));
    assert.match(html, /0% of leads/);
  }
  assert.deepEqual(summarizeLeadTemperatures([]).map(({ count, percent }) => [count, percent]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
});

test("lead temperature summary groups unclassified leads as New and uses all leads as denominator", () => {
  const leads = [
    { leadTemperatureStatus: "hot" },
    { leadTemperatureStatus: "hot" },
    { leadTemperatureStatus: "warm" },
    { leadTemperatureStatus: "cold" },
    { leadTemperatureStatus: "unclassified" }
  ];
  const summary = summarizeLeadTemperatures(leads);
  assert.deepEqual(summary.map(({ label, count, percent }) => [label, count, percent]), [
    ["Hot", 2, 40], ["Warm", 1, 20], ["Cold", 1, 20], ["New", 1, 20]
  ]);
  const html = renderToStaticMarkup(React.createElement(LeadTemperatureSummary, { leads }));
  assert.match(html, /40% of leads/);
  assert.equal((html.match(/20% of leads/g) || []).length, 3);
});
