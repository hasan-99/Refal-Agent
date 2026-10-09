// P1.6 — Policy precedence ladder (CX Wave 1C, adopted verbatim in Rule 2).
//
// When two sources disagree, this order decides. It is enforced in code, not
// left to the model, because "the model usually gets it right" is exactly the
// property that fails under adversarial or unusual input.
//
//   1. Privacy, security, and fail-closed tool rules      <- always wins
//   2. Owner-approved business policies and service facts
//   3. Current live data returned from trusted APIs
//   4. Conversation facts explicitly supplied by the customer
//   5. Approved retrieved knowledge
//   6. General model knowledge                            <- harmless general
//                                                            explanation only,
//                                                            NEVER a Refalco
//                                                            specific claim
//
// Lower rank number wins. The ladder is total: any two DIFFERENT levels have a
// defined winner, which is what makes the 15-pair gate in G2 meaningful.

const SOURCE_LEVELS = Object.freeze({
  PRIVACY_RULE: "privacy_rule",
  OWNER_POLICY: "owner_policy",
  LIVE_DATA: "live_data",
  CUSTOMER_STATEMENT: "customer_statement",
  APPROVED_KNOWLEDGE: "approved_knowledge",
  MODEL_KNOWLEDGE: "model_knowledge"
});

const RANK = Object.freeze({
  [SOURCE_LEVELS.PRIVACY_RULE]: 1,
  [SOURCE_LEVELS.OWNER_POLICY]: 2,
  [SOURCE_LEVELS.LIVE_DATA]: 3,
  [SOURCE_LEVELS.CUSTOMER_STATEMENT]: 4,
  [SOURCE_LEVELS.APPROVED_KNOWLEDGE]: 5,
  [SOURCE_LEVELS.MODEL_KNOWLEDGE]: 6
});

// W1.6.5 — a decision is logged as a short STABLE LABEL, never as prose
// reasoning. CX 15C: a chain-of-thought in a log is still a chain-of-thought,
// and it leaks into incident reports, dashboards and support tickets.
const DECISION_LABELS = Object.freeze({
  PRIVACY_WINS: "precedence:privacy_rule_wins",
  OWNER_POLICY_WINS: "precedence:owner_policy_wins",
  LIVE_DATA_WINS: "precedence:live_data_over_knowledge",
  CUSTOMER_WINS: "precedence:customer_statement_over_knowledge",
  KNOWLEDGE_WINS: "precedence:approved_knowledge_over_model",
  HIGHER_RANK_WINS: "precedence:higher_rank_wins",
  TIE_SAME_LEVEL: "precedence:same_level_conflict",
  TIE_RESOLVED_BY_DATE: "precedence:same_level_resolved_by_date",
  NO_CONFLICT: "precedence:no_conflict"
});

function rankOf(source) {
  const level = typeof source === "string" ? source : source?.level;
  const rank = RANK[level];
  if (!rank) throw new Error(`policyPrecedence: unknown source level "${level}"`);
  return rank;
}

function effectiveDate(source) {
  const raw = source?.effectiveDate ?? source?.valid_from ?? source?.approved_at;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * W1.6.1 — resolve a disagreement between two or more sources.
 *
 * Returns the winning source, a stable decision label, and the sources that
 * lost. Sources that merely agree are not a conflict.
 */
function resolveConflict(sources = []) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  if (!list.length) throw new Error("policyPrecedence: no sources supplied");
  if (list.length === 1) {
    return { winner: list[0], label: DECISION_LABELS.NO_CONFLICT, loser: [], stale: [], tied: false };
  }

  const ranked = [...list].sort((a, b) => rankOf(a) - rankOf(b));
  const best = rankOf(ranked[0]);
  const topTier = ranked.filter((source) => rankOf(source) === best);

  // W1.6.4 — two APPROVED sources that disagree with each other are NOT
  // resolved by picking the more convincing one. Say that they differ and cite
  // both, unless a dated revision settles it.
  if (topTier.length > 1) {
    const dated = topTier.filter((source) => effectiveDate(source) !== null);
    if (dated.length === topTier.length) {
      const newest = [...dated].sort((a, b) => effectiveDate(b) - effectiveDate(a));
      // Only a STRICTLY newer date resolves it; equal dates remain a genuine tie.
      if (effectiveDate(newest[0]) > effectiveDate(newest[1])) {
        return {
          winner: newest[0],
          label: DECISION_LABELS.TIE_RESOLVED_BY_DATE,
          loser: newest.slice(1),
          stale: newest.slice(1),
          tied: false
        };
      }
    }
    return {
      winner: null,
      label: DECISION_LABELS.TIE_SAME_LEVEL,
      loser: [],
      stale: [],
      tied: true,
      conflicting: topTier,
      // The caller must state that approved sources differ and cite both.
      mustDisclose: true
    };
  }

  const winner = ranked[0];
  const loser = ranked.slice(1);
  const level = typeof winner === "string" ? winner : winner.level;
  const loserLevels = loser.map((source) => (typeof source === "string" ? source : source.level));

  let label = DECISION_LABELS.HIGHER_RANK_WINS;
  if (level === SOURCE_LEVELS.PRIVACY_RULE) label = DECISION_LABELS.PRIVACY_WINS;
  else if (level === SOURCE_LEVELS.OWNER_POLICY) label = DECISION_LABELS.OWNER_POLICY_WINS;
  else if (level === SOURCE_LEVELS.LIVE_DATA && loserLevels.includes(SOURCE_LEVELS.APPROVED_KNOWLEDGE)) label = DECISION_LABELS.LIVE_DATA_WINS;
  else if (level === SOURCE_LEVELS.CUSTOMER_STATEMENT && loserLevels.includes(SOURCE_LEVELS.APPROVED_KNOWLEDGE)) label = DECISION_LABELS.CUSTOMER_WINS;
  else if (level === SOURCE_LEVELS.APPROVED_KNOWLEDGE && loserLevels.includes(SOURCE_LEVELS.MODEL_KNOWLEDGE)) label = DECISION_LABELS.KNOWLEDGE_WINS;

  return {
    winner,
    label,
    loser,
    // A knowledge chunk beaten by live data is not merely ignored, it is STALE
    // and should be flagged for refresh (W1.6.2).
    stale: level === SOURCE_LEVELS.LIVE_DATA
      ? loser.filter((source) => (typeof source === "string" ? source : source.level) === SOURCE_LEVELS.APPROVED_KNOWLEDGE)
      : [],
    tied: false
  };
}

// W1.6.3 — general model knowledge may explain a general concept, but must
// never produce a claim ABOUT Refalco. "VAT is a consumption tax" is fine from
// model knowledge; "Refalco charges 19% VAT" is not, at any level below 5.
const REFALCO_SPECIFIC_LATIN = /\b(?:refal(?:co)?(?:\s+group)?)\b|\b(?:our|we|us)\b[^.!?]{0,40}\b(?:charge|offer|price|fee|package|service|office|team|client)\w*\b/iu;
const REFALCO_SPECIFIC_OTHER = /(?:ريفال|شركتنا|مجموعتنا|أسعارنا|خدماتنا|باقتنا|فريقنا)|(?:η εταιρεία μας|ο όμιλός μας|οι τιμές μας|οι υπηρεσίες μας|η ομάδα μας)/iu;

function isRefalcoSpecificClaim(text) {
  const value = String(text || "");
  return REFALCO_SPECIFIC_LATIN.test(value) || REFALCO_SPECIFIC_OTHER.test(value);
}

/**
 * W1.6.3 gate. A statement sourced from general model knowledge is permitted
 * only while it stays general.
 */
function assertModelKnowledgeIsGeneral(text, level) {
  if (level !== SOURCE_LEVELS.MODEL_KNOWLEDGE) return { ok: true, label: DECISION_LABELS.NO_CONFLICT };
  if (isRefalcoSpecificClaim(text)) {
    return { ok: false, label: "precedence:model_knowledge_refalco_claim_blocked" };
  }
  return { ok: true, label: "precedence:model_knowledge_general_ok" };
}

module.exports = {
  SOURCE_LEVELS,
  RANK,
  DECISION_LABELS,
  resolveConflict,
  isRefalcoSpecificClaim,
  assertModelKnowledgeIsGeneral
};
