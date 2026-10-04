import { createElement } from "react";
import { leadTemperatureStatus } from "../performance.js";

const TEMPERATURES = [
  ["hot", "Hot", "#d56d56"],
  ["warm", "Warm", "#d7a343"],
  ["cold", "Cold", "#5797b7"],
  ["unclassified", "New", "#8b9da6"]
];

export function summarizeLeadTemperatures(leads = []) {
  const counts = { hot: 0, warm: 0, cold: 0, unclassified: 0 };
  for (const lead of leads) counts[leadTemperatureStatus(lead)] += 1;
  return TEMPERATURES.map(([key, label]) => ({
    key,
    label,
    count: counts[key],
    percent: leads.length ? Math.round((counts[key] / leads.length) * 100) : 0
  }));
}

export function LeadTemperatureSummary({ leads = [] }) {
  return createElement("section", { className: "conversation-temperature-summary", "aria-label": "Lead temperature distribution" },
    summarizeLeadTemperatures(leads).map(({ key, label, count, percent }) => createElement("div", {
      className: `conversation-temperature-stat ${key}`,
      key
    },
    createElement("div", {
      className: "conversation-temperature-ring",
      style: { "--temperature-color": TEMPERATURES.find(([temperature]) => temperature === key)[2], "--temperature-progress": `${percent}%` },
      role: "img",
      "aria-label": `${label}: ${count} leads`
    }, createElement("span", null, count.toLocaleString())),
    createElement("span", null,
      createElement("strong", null, label),
      createElement("small", null, `${percent}% of leads`)
    )))
  );
}
