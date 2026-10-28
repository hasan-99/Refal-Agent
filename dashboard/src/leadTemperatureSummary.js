import { createElement } from "react";
import { leadTemperatureStatus } from "../performance.js";

const TEMPERATURES = [
  ["hot", "Hot", "#d56d56"],
  ["warm", "Warm", "#d7a343"],
  ["cold", "Cold", "#5797b7"],
  ["unclassified", "New", "#8b9da6"]
];

export function summarizeLeadTemperatures(leads = []) {
  const activeLeads = leads.filter((lead) => Number(lead.conversationCount) > 0);
  const counts = { hot: 0, warm: 0, cold: 0, unclassified: 0 };
  for (const lead of activeLeads) counts[leadTemperatureStatus(lead)] += 1;
  return TEMPERATURES.map(([key, label]) => ({
    key,
    label,
    count: counts[key],
    percent: activeLeads.length ? Math.round((counts[key] / activeLeads.length) * 100) : 0
  }));
}

export function LeadTemperatureSummary({ leads = [] }) {
  return createElement("section", { className: "conversation-temperature-summary", "aria-label": "Lead temperatures for contacts with conversation history" },
    summarizeLeadTemperatures(leads).map(({ key, label, count, percent }) => createElement("div", {
      className: `conversation-temperature-stat ${key}`,
      key
    },
    createElement("div", {
      className: "conversation-temperature-ring",
      style: { "--temperature-color": TEMPERATURES.find(([temperature]) => temperature === key)[2], "--temperature-progress": `${percent}%` },
      role: "img",
      "aria-label": `${label}: ${count} chat contacts`
    }, createElement("span", null, count.toLocaleString())),
    createElement("span", null,
      createElement("strong", null, label),
      createElement("small", null, `${percent}% of chat contacts`)
    )))
  );
}
