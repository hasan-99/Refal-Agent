import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROMPT_TOKEN_CEILING,
  PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE,
  PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE,
  isPromptWithinTokenCeiling,
  promptTokenUpperBound
} from "./promptBudget.mjs";

test("Edge prompt budget counts serialized UTF-8 bytes conservatively for EN, AR, EL, emoji and combining marks", () => {
  for (const content of ["English", "مرحبا بالعالم", "Καλημέρα", "😀", "e\u0301"]) {
    const messages = [{ role: "user", content }];
    assert.equal(promptTokenUpperBound(messages), Buffer.byteLength(JSON.stringify(messages), "utf8")
      + PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE);
  }
});

test("Edge prompt budget accepts the exact content-byte boundary and rejects the next byte", () => {
  const base = [{ role: "user", content: "" }];
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8")
    + PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE;
  const maxContentBytes = MAX_PROMPT_TOKEN_CEILING - overhead;
  assert.equal(isPromptWithinTokenCeiling([{ role: "user", content: "x".repeat(maxContentBytes) }]), true);
  assert.equal(isPromptWithinTokenCeiling([{ role: "user", content: "x".repeat(maxContentBytes + 1) }]), false);
});

test("Edge prompt budget accounts for unbounded message count and structured fields", () => {
  const manyMessages = Array.from({ length: 3000 }, () => ({ role: "user", content: "" }));
  assert.equal(isPromptWithinTokenCeiling(manyMessages), false);
  const structured = [{ role: "assistant", tool_calls: [{ function: { arguments: "x".repeat(40000) } }] }];
  assert.equal(isPromptWithinTokenCeiling(structured), false);
});
