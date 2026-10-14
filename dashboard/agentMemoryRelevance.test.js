import test from "node:test";
import assert from "node:assert/strict";
import { meaningfulWords, selectRelevantPinnedMemories } from "./agentMemoryRelevance.js";

test("normalizes common English question phrasing without discarding multilingual terms", () => {
  assert.deepEqual(meaningfulWords("What does Hasan like doing?"), ["hasan", "like"]);
  assert.deepEqual(meaningfulWords("Τι αρέσει στον Χασάν;"), ["τι", "αρέσει", "στον", "χασάν"]);
});

test("a pinned memory is retrieved when the RPC lexical search misses a natural-language variant", () => {
  const memory = { id: "memory-1", label: "Hasan preferences", content: "Hasan likes coding.", pinned: true };
  assert.deepEqual(selectRelevantPinnedMemories("What does Hasan like doing?", [memory]), [memory]);
});

test("fallback retrieval does not return unpinned or unrelated memories", () => {
  const memories = [
    { id: "unrelated", content: "Hasan prefers morning meetings", pinned: true },
    { id: "unpinned", content: "Hasan likes coding", pinned: false }
  ];
  assert.deepEqual(selectRelevantPinnedMemories("What does Hasan like doing?", memories), []);
});

test("fallback retrieval ranks relevant pinned memories and respects the result limit", () => {
  const memories = [
    { id: "partial", content: "Hasan prefers coding classes", pinned: true },
    { id: "strong", content: "Hasan likes coding", pinned: true },
    { id: "other", content: "Hasan prefers morning meetings", pinned: true }
  ];
  assert.deepEqual(selectRelevantPinnedMemories("Hasan likes coding", memories, 1).map((memory) => memory.id), ["strong"]);
});
