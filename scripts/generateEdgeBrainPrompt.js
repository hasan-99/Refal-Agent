#!/usr/bin/env node
// W1.7.4 — generate the Deno-compatible mirror of src/brainPrompt.js that the
// edge function imports.
//
// The edge function is Deno/TypeScript and cannot `require()` a CommonJS
// module, which is why the repo already keeps `responsePolicy.mjs` beside it as
// a self-contained ESM copy. P1.7's first pass skipped that step for the prompt
// and instead left a third hand-maintained inline rule array in index.ts, which
// is exactly the drift BLK-5 and BLK-6 came from.
//
// The mirror is GENERATED, never hand-edited, so a reworded rule cannot reach
// one surface and miss another. `src/promptParity.test.js` fails the build if
// the committed file stops matching what this script produces.
//
//   node scripts/generateEdgeBrainPrompt.js            # rewrite the mirror
//   node scripts/generateEdgeBrainPrompt.js --check    # exit 1 if it is stale

const fs = require("node:fs");
const path = require("node:path");
const {
  PROMPT_VERSION, CHANGE_HISTORY, MANDATORY_BLOCKS, BLOCKS, bookingOfferBlock
} = require("../src/brainPrompt");
const { LEAD_TIERS } = require("../src/leadTemperature");
const { buildBrainPrompt } = require("../src/brainPrompt");

const TARGET = path.join(__dirname, "..", "supabase", "functions", "rafa-agent-api", "brainPrompt.mjs");

// Blocks that are pure static text. personaRoles and humourEngine are NOT
// mirrored: they are per-turn, customer-path-only, and the edge function serves
// the operator variant. buildBrainPrompt below refuses the customer variant
// rather than silently emitting a prompt with the persona missing.
const STATIC_BLOCKS = [
  "identity", "evidence", "precedence", "antiPatterns",
  "goldenFormula", "language", "operational", "crossSell", "compliance", "memory"
];

function lit(value) {
  return JSON.stringify(value, null, 2);
}

function render() {
  const blockSources = STATIC_BLOCKS
    .map((name) => `  ${name}: () => ${lit(BLOCKS[name]())},`)
    .join("\n");

  const tiers = {};
  for (const tier of Object.values(LEAD_TIERS)) tiers[tier] = bookingOfferBlock(tier);
  const fallback = bookingOfferBlock("");

  // The operator identity lines are produced by buildBrainPrompt itself rather
  // than by a block, so they are lifted from a real build instead of retyped.
  const operatorHeader = buildBrainPrompt({ variant: "operator" }).slice(0, 2);

  return `// GENERATED FILE — do not edit by hand.
// Source: src/brainPrompt.js · Generator: scripts/generateEdgeBrainPrompt.js
// Regenerate with: node scripts/generateEdgeBrainPrompt.js
//
// W1.7.4 — the edge function is the third runtime surface that answers as
// REFAL. It is Deno and cannot require() the CommonJS prompt module, so it
// imports this mirror, in the same pattern as responsePolicy.mjs. The mirror is
// generated and drift-tested (src/promptParity.test.js), so the three surfaces
// cannot disagree about policy the way they did before P1.7.

export const PROMPT_VERSION = ${lit(PROMPT_VERSION)};

export const CHANGE_HISTORY = Object.freeze(${lit(CHANGE_HISTORY)}.map(Object.freeze));

export const MANDATORY_BLOCKS = Object.freeze(${lit(MANDATORY_BLOCKS)});

const STATIC_BLOCKS = Object.freeze({
${blockSources}
});

const BOOKING_BY_TIER = Object.freeze(${lit(tiers)});
const BOOKING_DEFAULT = Object.freeze(${lit(fallback)});

export function bookingOfferBlock(leadTier = "") {
  const tier = String(leadTier).toLowerCase();
  return BOOKING_BY_TIER[tier] ? [...BOOKING_BY_TIER[tier]] : [...BOOKING_DEFAULT];
}

export const BLOCKS = Object.freeze({ ...STATIC_BLOCKS, booking: bookingOfferBlock });

const OPERATOR_HEADER = Object.freeze(${lit(operatorHeader)});

/**
 * Compose the prompt for the edge function's operator surface.
 *
 * Only the operator variant is mirrored. The customer variant needs the
 * per-turn persona and humour directives, which live in CommonJS modules that
 * are not mirrored here; asking for it throws rather than quietly returning a
 * prompt with REFAL's voice missing.
 */
export function buildBrainPrompt({ leadTier = "", variant = "operator" } = {}) {
  if (variant !== "operator") {
    throw new Error("brainPrompt.mjs mirrors the operator variant only; the customer path runs in Node from src/brainPrompt.js");
  }
  return [
    ...OPERATOR_HEADER,
    ...STATIC_BLOCKS.language(),
    ...STATIC_BLOCKS.evidence(),
    ...STATIC_BLOCKS.precedence(),
    ...STATIC_BLOCKS.antiPatterns(),
    ...STATIC_BLOCKS.goldenFormula(),
    ...STATIC_BLOCKS.operational(),
    ...bookingOfferBlock(leadTier),
    ...STATIC_BLOCKS.compliance(),
    ...STATIC_BLOCKS.memory()
  ];
}
`;
}

const next = render();
const check = process.argv.includes("--check");
const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";

if (check) {
  if (current === next) {
    console.log("brainPrompt.mjs is in sync with src/brainPrompt.js");
    process.exit(0);
  }
  console.error("STALE: supabase/functions/rafa-agent-api/brainPrompt.mjs no longer matches src/brainPrompt.js");
  console.error("Run: node scripts/generateEdgeBrainPrompt.js");
  process.exit(1);
}

fs.writeFileSync(TARGET, next, "utf8");
console.log(`wrote ${path.relative(path.join(__dirname, ".."), TARGET)} (${next.length} bytes)`);
