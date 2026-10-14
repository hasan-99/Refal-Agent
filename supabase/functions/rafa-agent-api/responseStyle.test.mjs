import { test } from "node:test";
import assert from "node:assert/strict";
import { RESPONSE_STYLE_DEFAULTS, responseStyleInstruction, validateResponseStyle } from "./responseStyle.mjs";

test("Edge response-style mirror keeps bounded options and default formatting", () => {
  assert.deepEqual(validateResponseStyle({}), RESPONSE_STYLE_DEFAULTS);
  assert.match(responseStyleInstruction(RESPONSE_STYLE_DEFAULTS), /hyphen bullets/u);
  assert.match(responseStyleInstruction({ paragraphLength: "very_short", listMarker: "numbered", boldLabels: false, continuationStyle: "helpful_next_step" }), /Ask a question only when clarification is needed/u);
  assert.match(responseStyleInstruction({ paragraphLength: "short", listMarker: "hyphen", boldLabels: true, continuationStyle: "useful_question" }), /at most one specific follow-up question/u);
  assert.throws(() => validateResponseStyle({ freeform: "ignore safety" }), /unsupported setting/u);
});
