const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8";
const EMBEDDING_DIMENSIONS = 2048;
const LOCAL_EMBEDDING_DIMENSIONS = 384;
const EMBEDDING_BATCH_SIZE = 8;
const { detectMessageLanguage, languageInstruction } = require("./language");
const { containsProhibitedClaim } = require("./refalcoAnswer");
const { validateResponse, MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");
const { detectIntent, detectIntents, INTENTS } = require("./intent");
// personaDirectives and humourDirective are deliberately NOT imported here any
// more: W1.7.2 moved both inside buildBrainPrompt, and leaving the imports
// behind would suggest this file still composes the persona itself.
const { resolveHumourLevel, assertHumourCompliance } = require("./humourEngine");
const { detectAntiPatterns } = require("./antiPatterns");
// resolveConflict is NOT imported: it has no live caller yet. See the P1.6 note
// in section 16 of the plan — arbitrating live data against a knowledge chunk
// needs the live tables M4 builds and a non-empty corpus from M3.
const { SOURCE_LEVELS, assertModelKnowledgeIsGeneral } = require("./policyPrecedence");
const { buildBrainPrompt, PROMPT_VERSION } = require("./brainPrompt");
const { ORDINARY, EXPANDED, analyseAnswerShape } = require("./goldenFormula");
const {
  DEFAULT_OPENROUTER_FALLBACK_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  resolveOpenRouterModel,
  withOpenRouterPrivacyPolicy
} = require("./openrouterPrivacy");
const { redactSensitiveData } = require("./sensitiveData");
const { fetchOpenRouter } = require("./openrouterTransport");
// REFAL-AGENT-028: these five were defined inline in this file before this
// ticket; moved to groundingPolicy.js (unchanged behavior) so the Agent path
// can share them too, without duplicating logic that could drift apart.
const {
  containsPriceClaim,
  withoutPriceFacts,
  containsUnsupportedPackageInclusion,
  containsLegacyBrandHistory,
  customerAskedAboutLegacyBrand,
  containsRawUrlClaim
} = require("./groundingPolicy");

let embeddingPipelinePromise;

async function loadEmbeddingPipeline() {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = (async () => {
      const path = require("node:path");
      const os = require("node:os");
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = path.join(os.homedir(), ".cache", "rafa", "transformers");
      return pipeline("feature-extraction", "Xenova/multilingual-e5-small", {
        revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        dtype: "q8"
      });
    })().catch((error) => {
      embeddingPipelinePromise = undefined;
      throw error;
    });
  }
  return embeddingPipelinePromise;
}

function toSupabaseVector(values) {
  const vector = Array.from(values || []);
  if (vector.length !== LOCAL_EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Local embedding dimensions or values are invalid.");
  }
  return vector.concat(Array(EMBEDDING_DIMENSIONS - LOCAL_EMBEDDING_DIMENSIONS).fill(0));
}

async function embedWithPipeline(texts, pipelineFactory = loadEmbeddingPipeline) {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 500) throw new Error("Embedding batch size is invalid.");
  const pipeline = await pipelineFactory();
  const vectors = [];
  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE).map((text) => `passage: ${redactPersonalData(text).slice(0, 6000)}`);
    const output = await pipeline(batch, { pooling: "mean", normalize: true, truncation: true, max_length: 512 });
    const dimensions = output?.dims?.at(-1);
    const data = output?.data;
    if (!dimensions || dimensions !== LOCAL_EMBEDDING_DIMENSIONS || !data || data.length !== batch.length * dimensions) {
      throw new Error("Local embedding response shape is invalid.");
    }
    for (let row = 0; row < batch.length; row += 1) {
      vectors.push(toSupabaseVector(data.subarray(row * dimensions, (row + 1) * dimensions)));
    }
  }
  return vectors;
}

async function embedTexts(texts, pipelineFactory) {
  return embedWithPipeline(texts, pipelineFactory);
}

async function embedText(text, pipelineFactory) {
  const pipeline = await pipelineFactory?.() || await loadEmbeddingPipeline();
  const safeText = `query: ${redactPersonalData(text).slice(0, 6000)}`;
  const output = await pipeline(safeText, { pooling: "mean", normalize: true, truncation: true, max_length: 512 });
  if (output?.dims?.at(-1) !== LOCAL_EMBEDDING_DIMENSIONS || !output.data || output.data.length !== LOCAL_EMBEDDING_DIMENSIONS) {
    throw new Error("Local embedding response shape is invalid.");
  }
  return toSupabaseVector(output.data);
}

// A content-policy rejection (the model answered, but the deterministic
// checks below rejected the draft) is different from a transport/provider
// failure: a different configured model may well produce a compliant answer
// from the same evidence, so these are tagged to let the retry loop below
// try the next distinct model once, instead of giving up immediately.
function contentPolicyError(message) {
  const error = new Error(message);
  error.contentPolicy = true;
  return error;
}

// W1.7.7 — `leadTier` is what makes the booking rule tier-aware. It arrives from
// the caller (bot.js already classifies it) rather than being recomputed here,
// because classifyLeadTemperature reads the full stored history AND the booking
// status, neither of which is present in `conversationTurns`. Defaulting to ""
// yields the protective "do not offer a call at this stage" instruction, so a
// caller that does not classify is never more permissive, only less informed.
async function askOpenRouter({ text, evidence, onUsage, includeSources = true, conversationSummary = "", conversationTurns = [], leadTier = "" }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !Array.isArray(evidence) || evidence.length === 0) return null;

  const primaryModel = resolveOpenRouterModel(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL);
  const fallbackModel = resolveOpenRouterModel(process.env.OPENROUTER_FALLBACK_MODEL, DEFAULT_OPENROUTER_FALLBACK_MODEL);
  const models = [...new Set([primaryModel, fallbackModel])];
  const language = detectMessageLanguage(text);
  // P1.3 — resolved ONCE per turn. The prompt directive and the output gate must
  // use the same level; recomputing them separately would let the model be told
  // "level 2" while the gate enforced level 0, which fails closed but wastes a
  // generation every time.
  const humourLevel = resolveHumourLevel({
    message: text,
    history: conversationTurns,
    intents: detectIntents(text),
    leadTier,
    language
  }).level;
  // Allow a narrow factual follow-up when the customer already asked about
  // price. This preserves context without turning unrelated answers into sales.
  const currentIntents = detectIntent(text).intents;
  const directPriceQuestion = currentIntents.includes(INTENTS.PRICING);
  const priorUserTurns = Array.isArray(conversationTurns)
    ? conversationTurns.filter((turn) => turn?.role === "user" && typeof turn.content === "string").slice(-6)
    : [];
  const previousCustomerTurn = priorUserTurns.at(-1);
  const priorPriceQuestion = priorUserTurns.some((turn) => detectIntent(turn.content).intents.includes(INTENTS.PRICING));
  const packageInclusionFollowUp = /\b(?:package|what(?:'s| is) included|includes?|inclusions?|published price|prices|written|fees|price|final|validity|case[- ]specific|paketo|perilamvanei|perilambanei|perilamvanetai|perilambanetai|times|teliko|desmeftiko|periptosi|kathorisei|epivevaiose|epivevaiosi|anthropos)\b|πακέτ|περιλαμβάν|τιμή|κόστος|δημοσιευ|επιβεβαι|السعر|الأسعار|يشمل|الباقة|نهائي|تأكيد|تتغير|صالحة/iu;
  const packageContext = previousCustomerTurn && packageInclusionFollowUp.test(previousCustomerTurn.content);
  const directAnswerToPackagePrompt = Array.isArray(conversationTurns)
    && /\b(?:does it include|what(?:'s| is) included|tell you what the package includes|what the package includes)\b|τι περιλαμβάνει|شو بيشمل/iu.test(String(conversationTurns.at(-1)?.content || ""))
    // \b is ASCII-only, so `ναι\b` and `نعم\b` were unreachable: an Arabic or
    // Greek "yes" did not register as a direct answer to the package prompt.
    && (/^(?:yes|yeah|sure|ok|okay|nai)\b/iu.test(text.trim()) || /^(?:ναι|نعم)(?=\s|$|[.,!?؟])/u.test(text.trim()));
  const adjacentPriceQuestion = Boolean(previousCustomerTurn && detectIntent(previousCustomerTurn.content).intents.includes(INTENTS.PRICING));
  const contextualPriceClarification = priorPriceQuestion && (adjacentPriceQuestion || packageContext || directAnswerToPackagePrompt)
    && /\b(?:published|confirmed|valid(?:ity)?|expire|change|final|include|included|price|prices|written|that price|this price|the price|that amount|the amount|what applies|case[- ]specific|times|perilamvanetai|perilambanetai|perilamvanei|perilambanei|teliko|desmeftiko|periptosi|kathorisei|epivevaiose|epivevaiosi|anthropos|paketo)\b|δημοσιευ|ισχύ|αλλάξ|περιλαμβάν|τελικ|τιμή|κόστος|επιβεβαι|εφαρμόζ|πακέτ|السعر|الأسعار|يشمل|نهائي|تأكيد|تتغير|صالحة|المدة|الباقة/iu.test(text);
  const asksForServiceDetails = /\b(?:tell me more|more details|full details|detailed (?:overview|information)|explain (?:it|that|the service)|all (?:the )?details)\b|(?:بدي|بدّي|أريد|اريد|اعطيني|أعطيني).{0,24}(?:تفاصيل|معلومات أكثر|شرح)|تفاصيل\s*(?:أكثر|اكتر)|اشرح(?:لي| لي)?.{0,20}(?:الخدمة|التأسيس)|(?:πες μου περισσότερα|περισσότερες πληροφορίες|όλες τις λεπτομέρειες|αναλυτικές πληροφορίες|εξήγησέ μου)/iu.test(text);
  const hasRecentCompanyFormationTopic = [...priorUserTurns].reverse().some((turn) => {
    const intents = detectIntent(turn.content).intents;
    return intents.includes(INTENTS.COMPANY_FORMATION) || intents.includes(INTENTS.CORPORATE_SERVICES)
      || /\b(?:company|business) (?:formation|setup|registration|incorporation)\b|(?:تسجيل|تأسيس|إنشاء)\s+(?:شركة|شركات)|(?:σύσταση|ίδρυση|εγγραφή)\s+εταιρε(?:ίας|ιών)/iu.test(turn.content);
  });
  // A request for fuller details about the active formation topic includes
  // the package's verified commercial facts. This is still contextual and
  // evidence-gated; it does not expose pricing on unrelated service turns.
  const contextualFormationDetails = asksForServiceDetails && hasRecentCompanyFormationTopic;
  const broadServicesRequest = currentIntents.includes(INTENTS.SERVICES);
  const allowPricing = directPriceQuestion || contextualPriceClarification || contextualFormationDetails || broadServicesRequest;
  const expandedServiceAnswer = asksForServiceDetails
    || broadServicesRequest
    || currentIntents.includes(INTENTS.BUSINESS_AREAS);
  const promptEvidence = allowPricing ? evidence : withoutPriceFacts(evidence);
  const safeQuestion = redactPersonalData(text).slice(0, 1000);
  // Source names and URLs can contain private review/provenance metadata (for
  // example owner-confirmation records). Give the model factual content and a
  // safe heading only; keep provenance in protected server-side metadata.
  const safeEvidenceText = (value) => redactPersonalData(String(value || ""))
    .replace(/\b(?:owner[- ]confirmed|confirmed by the owner|owner verification|internal review|reviewed internally)\b/giu, "")
    .replace(/https?:\/\/\S+/giu, "[link omitted]")
    .slice(0, 2400);
  const citations = promptEvidence.slice(0, 5).map((item, index) =>
    `[${index + 1}] Approved Refalco Group information\n${safeEvidenceText(item.heading)}\n${safeEvidenceText(item.content)}`
  ).join("\n\n");
  const memory = redactPersonalData(conversationSummary).slice(0, 1000);
  const sourceInstruction = includeSources
    ? "Keep internal source names, owner confirmations, review status, and verification steps private. Do not cite sources unless the customer asks or a citation is needed to explain material uncertainty."
    : "Do not include source names, citations, or URLs in the customer-facing answer.";
  const recentConversation = Array.isArray(conversationTurns)
    ? conversationTurns.slice(-12).filter((turn) => ["user", "assistant"].includes(turn?.role) && typeof turn?.content === "string" && turn.content.trim())
      .map((turn) => ({ role: turn.role, content: redactPersonalData(turn.content).slice(0, 1200) }))
    : [];
  let lastError;
  for (const model of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
    const response = await fetchOpenRouter(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      timeoutMs: 20000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost/whatsapp-company-bot",
        "X-OpenRouter-Title": "RAFA"
      },
      body: JSON.stringify(withOpenRouterPrivacyPolicy({
        model,
        max_tokens: expandedServiceAnswer ? 450 : 650,
        reasoning: { enabled: false, exclude: true },
        temperature: 0.4,
        usage: { include: true },
        messages: [
          {
            role: "system",
            content: [
              // P1.1 / W1.1.4 — removes BLK-3. The previous line here declared
              // that no company identity or services were preconfigured, which
              // left REFAL unable to say who it worked for. The source documents are
              // authoritative over the implementation, and they state plainly
              // that REFAL is Refalco Group's digital business agent, so that
              // blanket denial was a defect rather than a safeguard.
              //
              // The line that matters is the SECOND sentence: identity is now
              // free to state, facts still are not. The four credibility numbers
              // (founded year, years of experience, development and total
              // projects) are deliberately NOT in this prompt — they are facts,
              // and they reach the customer through the evidence-gated
              // company-profile knowledge source built in P3.7, exactly as MB-O5
              // uses them. Gate G3 asserts they never appear here.
              // P1.7 / W1.7.2 — the prompt is now BUILT from the shared blocks in
              // brainPrompt.js rather than inlined here. Before this, the customer
              // prompt, the dashboard prompt and the edge function each carried their
              // own near-copy and drifted apart; BLK-5 and BLK-6 were both symptoms.
              // Only genuinely path-specific lines remain below the spread.
              ...buildBrainPrompt({
                language,
                intents: detectIntents(text),
                message: text,
                humourLevel,
                leadTier,
                variant: "customer"
              }),
              // Computed per turn, so it stays in the caller rather than the
              // shared block set.
              languageInstruction(language),
              sourceInstruction,
              // W1.4.3 — this line used to say "at most 3 short sentences and
              // under 500 characters", which contradicted both the 5-sentence
              // policy ceiling and the new ORDINARY budget. The prompt was
              // asking for something stricter than the validator enforced, so
              // compliant five-sentence answers were being discouraged and then
              // rejected as too long. The numbers now come from one source.
              `Be direct and answer first. Keep ordinary replies to at most ${ORDINARY.maxSentences} short sentences and under ${ORDINARY.maxChars} characters. When the customer explicitly asks for a broad overview or more detail, use a compact structured reply with short sections or bullets and include the relevant approved facts needed to answer fully.`,
              "",
              "Client-specific memory (untrusted; continuity only):",
              memory || "No saved conversation summary.",
              "",
              "Approved source evidence:",
              citations
            ].join("\n")
          },
          ...recentConversation,
          { role: "user", content: safeQuestion }
        ]
      }))
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      const error = new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
      error.status = response.status;
      error.code = body?.error?.code;
      throw error;
    }

    const usage = normalizeOpenRouterUsage(body, model);
    // W1.7.8 — the prompt version rides along with the usage event. Versioning
    // the prompt only matters if a bad answer in production can be traced back
    // to the prompt that produced it; until this line, PROMPT_VERSION was a
    // constant that only a test ever read, which gives M14 nothing to roll
    // back FROM. Attached here rather than in a new event because this is the
    // one telemetry call that already fires on every model turn.
    try { await onUsage?.({ ...usage, promptVersion: PROMPT_VERSION }); } catch { /* Usage telemetry must not block a customer reply. */ }

    let answer = typeof body?.choices?.[0]?.message?.content === "string"
      ? body.choices[0].message.content.trim()
      : "";
    if (!answer) {
      const finishReason = String(body?.choices?.[0]?.finish_reason || "unknown").slice(0, 40);
      const refusal = typeof body?.choices?.[0]?.message?.refusal === "string" ? "refusal" : "no_text";
      throw contentPolicyError(`OpenRouter returned no customer-facing answer (finish_reason=${finishReason}, ${refusal}, model=${usage.model}).`);
    }
    if (answer.length > 8 && detectMessageLanguage(answer) !== language) throw contentPolicyError("OpenRouter returned an answer in the wrong customer language.");
      if (containsLegacyBrandHistory(answer) && !customerAskedAboutLegacyBrand(text, conversationTurns)) throw contentPolicyError("OpenRouter introduced unrequested legacy brand history.");
      // P2.2/W2.2.2 — judged against the SAME approved evidence the model was
      // given. With no evidence this is byte-identical to the pre-M2 blanket
      // gate; with evidence an approved programme fact is no longer deleted
      // just for mentioning residency, a permit or a tax rate (BLK-1).
      if (containsProhibitedClaim(answer, { evidence: promptEvidence, language })) throw contentPolicyError("OpenRouter returned restricted legal or financial content.");
      if (containsPriceClaim(answer) && (!allowPricing || !promptEvidence.some((item) => containsPriceClaim(item?.content)))) {
        throw contentPolicyError("OpenRouter returned an unsolicited or unsupported price or package claim.");
      }
      if (containsUnsupportedPackageInclusion(answer, promptEvidence)) throw contentPolicyError("OpenRouter linked separately described services to the priced package without evidence.");
    if (containsRawUrlClaim(answer)) throw contentPolicyError("OpenRouter returned an unverified citation.");
    // REFAL-AGENT-011: single shared threshold preset (responsePolicy.js),
    // and the internal-reasoning detection itself now lives only in
    // responsePolicy.js's INTERNAL_REASONING_PATTERNS (previously duplicated
    // here with a narrower, English-only regex of its own) — this call
    // already runs that check unconditionally, regardless of which preset is
    // passed, so no separate check is needed below.
    const responsePolicy = validateResponse(answer, expandedServiceAnswer
      ? { ...MODEL_DRAFT_THRESHOLDS, maxSentences: 20, maxChars: 1800 }
      : MODEL_DRAFT_THRESHOLDS);
    if (!responsePolicy.valid) {
      if (responsePolicy.reasons.includes("too_long")) throw contentPolicyError(`OpenRouter returned an overlong answer (${answer.length} characters).`);
      if (responsePolicy.reasons.includes("too_many_questions")) throw contentPolicyError("OpenRouter returned too many questions.");
      if (responsePolicy.reasons.includes("internal_reasoning")) throw contentPolicyError("OpenRouter returned internal reasoning text.");
      throw contentPolicyError(`OpenRouter response policy failed: ${responsePolicy.reasons.join(",")}`);
    }
    // P1.6 / W1.6.3 — precedence gate on the answer composer.
    //
    // When no approved evidence backed this turn, anything Refalco-specific in
    // the draft can only have come from general model knowledge, which is the
    // bottom rung of the ladder and may NEVER produce a Refalco-specific claim.
    // A general explanation ("a limited company is a separate legal person") is
    // fine; "Refalco charges X" is not.
    const sourceLevel = Array.isArray(evidence) && evidence.length > 0
      ? SOURCE_LEVELS.APPROVED_KNOWLEDGE
      : SOURCE_LEVELS.MODEL_KNOWLEDGE;
    const precedenceGate = assertModelKnowledgeIsGeneral(answer, sourceLevel);
    if (!precedenceGate.ok) {
      // W1.6.5 — logged as a short stable label, never as prose reasoning.
      throw contentPolicyError(precedenceGate.label);
    }

    // P1.5 — anti-pattern guards. These REPORT rather than rewrite: silently
    // stripping a caveat to satisfy AP-2 is the exact failure CX 12B warns
    // about, so a violation forces a regeneration instead.
    const antiPatterns = detectAntiPatterns({
      answer,
      customerMessage: text,
      // Without the tier, AP-6's BOOKING_READY_TIERS exception can never fire
      // from this call site, so a HOT-tier booking offer — the very thing
      // bookingOfferBlock("hot") instructs the model to make — was flagged as
      // an unrequested meeting push and forced a retry. The prompt and the
      // gate were telling the model opposite things.
      leadTier,
      history: conversationTurns,
      // W1.4.1 + AP-1. This used to be `evidence.length > 0`, which is the
      // literal constant TRUE on this path: askOpenRouter returns null above
      // when the evidence bundle is empty, so AP-1 ("do not ask for contact
      // details in a turn that delivered no approved fact") could never fire
      // in production. It only fired in its own unit test, which passes
      // `false` directly — a state the live caller cannot produce.
      //
      // Having evidence available is not the same as having DELIVERED a fact.
      // A reply that deflects ("I cannot confirm that") and then asks for a
      // phone number is exactly MB-AP1, and it happens on turns where evidence
      // was present but unusable. analyseAnswerShape already measures that
      // distinction, so AP-1 now reads the answer instead of the input bundle.
      deliveredApprovedFact: Array.isArray(evidence) && evidence.length > 0
        && analyseAnswerShape(answer).hasDirectAnswer,
      evidenceText: Array.isArray(evidence) ? evidence.map((item) => String(item?.content || "")).join("\n") : ""
    });
    if (antiPatterns.length) {
      throw contentPolicyError(`OpenRouter draft commits anti-pattern(s): ${antiPatterns.map((violation) => `${violation.id}:${violation.reason}`).join(",")}`);
    }

    // P1.3 / W1.3.4 — humour output gate, beside the response policy.
    // A joking construction is REJECTED rather than stripped, because the joke
    // is usually load-bearing in its sentence and deleting the words leaves
    // nonsense; a retry on another model is the right recovery. Disallowed
    // emoji are stripped in place, since removing them leaves the sentence
    // intact and a retry would be disproportionate.
    const humourCheck = assertHumourCompliance(answer, humourLevel);
    if (humourCheck.rejected) {
      throw contentPolicyError(`OpenRouter returned humour above level ${humourLevel}: ${humourCheck.violations.map((violation) => violation.rule).join(",")}`);
    }
    if (!humourCheck.ok) answer = humourCheck.sanitized;

    const hasTerminalPunctuation = /[.!?؟。！？]["'”»)]*$/u.test(answer) || /\p{Script=Greek};["'”»)]*$/u.test(answer);
    if (!hasTerminalPunctuation) throw contentPolicyError("OpenRouter returned an unfinished sentence.");
    answer = suppressRepeatedSpecialistOffer(answer, { text, conversationTurns });
    // W1.4.3 / BLK-4 — this second length check re-runs after
    // suppressRepeatedSpecialistOffer has rewritten the answer, so it is not
    // redundant with the validateResponse call above. It WAS, however, still
    // carrying the stale hard-coded 500, which is the exact BLK-4 symptom the
    // rest of the phase removed: 5 sentences allowed by the prompt and the
    // validator, 500 characters enforced here. A compliant 501-700 character
    // reply was rejected and retried on the fallback model, worst in Arabic
    // and Greek where the same content runs longer. Driven by the constants
    // now, so it cannot drift from the budget again.
    const postEditLimit = expandedServiceAnswer ? EXPANDED.maxChars : ORDINARY.maxChars;
    if (answer.length > postEditLimit) throw contentPolicyError("OpenRouter returned an overlong answer.");
    const sourceLinks = [...new Map(promptEvidence.slice(0, 3).map((item) => [item.source_url, item])).values()]
      .map((item) => `${item.source_name}: ${item.source_url}`);
    return includeSources ? `${answer}\n\nSources: ${sourceLinks.join(" | ")}` : answer;
    } catch (error) {
      lastError = error;
      // A content-policy rejection gets one attempt on the next distinct
      // configured model (the `models` list is already de-duplicated above);
      // only a genuine non-retryable transport/provider error gives up
      // immediately without trying the fallback model.
      if (!isRetryableModelError(error) && !error.contentPolicy) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("OpenRouter could not produce an answer.");
}

const SPECIALIST_OFFER_RE = /(?:\b(?:would you like|shall i|can i|should i|want me to)\b.{0,100}\b(?:specialist|team|contact|follow.?up|arrange|connect)\b|\b(?:would you like|want me to) arrange\b|\b(?:specialist|team)\b.{0,80}\b(?:contact|call|follow.?up|review)\b.{0,60}\b(?:would you like|shall i|can i)\b|(?:هل|بدك|بتحب|بتفضّل|تحب).{0,70}(?:مختص|الفريق|يتواصل|متابعة)|(?:θέλετε|θα θέλατε|να ζητήσω).{0,80}(?:ειδικό|επικοινωνία|να επικοινωνήσει))/iu;
const CUSTOMER_DIRECT_CONTACT_RE = /(?:\b(?:please have (?:a|the) (?:specialist|team) contact me|ask (?:a|the) specialist to contact me|contact me about this|i want (?:a )?(?:human|specialist) to contact me|please (?:call|contact) me)\b|(?:خلي|بدي|اطلبوا).{0,60}(?:مختص|الفريق).{0,30}(?:يتواصل|اتصال)|(?:θέλω|επικοινωνήστε).{0,60}(?:ειδικό|επικοινωνία))/iu;

function suppressRepeatedSpecialistOffer(answer, { text = "", conversationTurns = [] } = {}) {
  const priorOffer = Array.isArray(conversationTurns) && conversationTurns.some((turn) =>
    turn?.role === "assistant" && SPECIALIST_OFFER_RE.test(String(turn.content || ""))
  );
  if (!priorOffer || CUSTOMER_DIRECT_CONTACT_RE.test(String(text || "")) || !SPECIALIST_OFFER_RE.test(String(answer || ""))) return answer;

  const retained = String(answer || "").split(/(?<=[.!?؟;；])\s+/u)
    .filter((sentence) => !SPECIALIST_OFFER_RE.test(sentence.trim()));
  const result = retained.join(" ").trim();
  return result || answer;
}

function normalizeOpenRouterUsage(body, requestedModel) {
  const usage = body?.usage && typeof body.usage === "object" ? body.usage : {};
  const readInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const promptTokens = readInteger(usage.prompt_tokens);
  const completionTokens = readInteger(usage.completion_tokens);
  const totalTokens = readInteger(usage.total_tokens);
  const costUsd = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  return {
    model: String(body?.model || requestedModel || "Unknown model").slice(0, 160),
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    providerReported: promptTokens !== null || completionTokens !== null || totalTokens !== null || costUsd !== null
  };
}

function isRetryableModelError(error) {
  if (error?.name === "AbortError" || error?.name === "TypeError") return true;
  if (error?.status === 429 || Number(error?.status) >= 500) return true;
  return /temporarily overloaded|temporarily unavailable|upstream timeout|gateway timeout|connection reset|network error/i.test(
    `${error?.code || ""} ${error?.message || ""}`
  );
}

function redactPersonalData(value) {
  // Redact structured credentials first; the broad phone matcher would
  // otherwise partially rewrite digit-heavy tokens before they are detected.
  return redactSensitiveData(String(value || ""))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/\b(?:my name is|i am|i'm|my email is|my phone is|call me at)\s+[^,.!?\n]+/gi, "[personal detail]");
}

module.exports = { askOpenRouter, embedText, embedTexts, embedWithPipeline, warmEmbeddingPipeline: loadEmbeddingPipeline, normalizeOpenRouterUsage, redactPersonalData, containsPriceClaim, containsUnsupportedPackageInclusion, withoutPriceFacts, suppressRepeatedSpecialistOffer, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
