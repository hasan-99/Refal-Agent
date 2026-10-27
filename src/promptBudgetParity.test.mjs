import assert from "node:assert/strict";
import test from "node:test";
import nodeBudget from "./promptBudget.js";
import * as edgeBudget from "../supabase/functions/rafa-agent-api/promptBudget.mjs";

test("Node and Edge prompt guards use identical ceilings and upper bounds", () => {
  assert.equal(nodeBudget.MAX_PROMPT_TOKEN_CEILING, edgeBudget.MAX_PROMPT_TOKEN_CEILING);
  assert.equal(nodeBudget.PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE, edgeBudget.PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE);
  assert.equal(nodeBudget.PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE, edgeBudget.PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE);

  const fixtures = [
    { messages: [{ role: "system", content: "policy" }, { role: "user", content: "Where is the office?" }] },
    { messages: [{ role: "user", content: "مرحبا، ما هي الخدمات؟" }] },
    { messages: [{ role: "user", content: "Καλημέρα, ποιες υπηρεσίες έχετε;" }] },
    { messages: [{ role: "assistant", tool_calls: [{ id: "c1", function: { arguments: "{\\\"query\\\":\\\"formation\\\"}" } }] }] },
    { messages: Array.from({ length: 3000 }, () => ({ role: "user", content: "" })) },
    { model: "decision-model", max_tokens: 300, response_format: { json_schema: { name: "decision", schema: { type: "object" } } }, messages: [{ role: "user", content: "Continue" }] }
  ];
  for (const messages of fixtures) {
    assert.equal(nodeBudget.promptTokenUpperBound(messages), edgeBudget.promptTokenUpperBound(messages));
    assert.equal(nodeBudget.isPromptWithinTokenCeiling(messages), edgeBudget.isPromptWithinTokenCeiling(messages));
  }
});

test("Node and Edge prompt guards agree at the exact configured boundary", () => {
  const ceiling = nodeBudget.MAX_PROMPT_TOKEN_CEILING;
  const makeMessages = (content) => ({ model: "model", messages: [{ role: "user", content }] });
  let low = 0;
  let high = ceiling;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (nodeBudget.promptTokenUpperBound(makeMessages("x".repeat(mid))) <= ceiling) low = mid;
    else high = mid - 1;
  }
  for (const length of [low, low + 1]) {
    const messages = makeMessages("x".repeat(length));
    assert.equal(nodeBudget.promptTokenUpperBound(messages), edgeBudget.promptTokenUpperBound(messages));
    assert.equal(nodeBudget.isPromptWithinTokenCeiling(messages), edgeBudget.isPromptWithinTokenCeiling(messages));
  }
});
