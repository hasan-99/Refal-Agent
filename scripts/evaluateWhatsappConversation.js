const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

const { askOpenRouter, embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
const { handleBookingMessage, isBookingRequest } = require("../src/booking");
const { buildConversationContext } = require("../src/conversationMemory");
const { prepareInboundMessage, routeMessageResult, recordHistory } = require("../src/messageRouter");
const { answerFromEvidence } = require("../src/refalcoAnswer");
const { createStore } = require("../src/supabaseStore");

const cases = [
  {
    id: "ar-services-declines-meeting",
    text: "بدي أعرف بشكل عام شو خدماتكم، وما بدي احجز موعد حالياً.",
    language: "arabic",
    source: "REFALCO GROUP official website",
    mustMention: /تطوير|البنية التحتية|التقنية|الاستراتيجي/,
    mustNotMention: /(?:احجز|حجز|نحدد|نرتب|ننسق).{0,15}(?:موعد|اجتماع)|(?:موعد|اجتماع).{0,15}(?:احجز|نحدد|نرتب|ننسق|مناسب)/
  },
  {
    id: "ar-services-paraphrase",
    text: "مرحبا، شو خدماتكم؟",
    language: "arabic",
    source: "REFALCO GROUP official website",
    mustMention: /تطوير|البنية التحتية|التقنية|الاستراتيجي/
  },
  {
    id: "en-lamar-services-transition",
    text: "What happened to LAMAR's former Cyprus company-formation services?",
    language: "english",
    source: "Owner-confirmed REFALCO services transition",
    mustMention: /LAMAR.*REFALCO|REFALCO.*LAMAR/i,
    mustNotMention: /owner|confirmed by|verification|999|price|package/i
  },
  {
    id: "ar-services-page",
    text: "ما هي الخدمات التي تقدمها ريفالكو؟",
    language: "arabic",
    source: "REFALCO GROUP Services",
    mustMention: /(?:شركة|خدمات|تأسيس|قبرص)/,
    mustNotMention: /مالك|تأكيد المالك|999|٩٩٩|owner|confirmed by/i
  },
  {
    id: "en-services",
    text: "What business areas and platforms does Refalco focus on?",
    language: "english",
    source: "REFALCO GROUP official website",
    mustMention: /development|infrastructure|operation|technology|strategic/i,
    mustNotMention: /book (?:a )?meeting|schedule (?:a )?call/i
  },
  {
    id: "el-services-language-switch",
    text: "Μπορείτε να μου πείτε με τι ασχολείται η Refalco; Δεν θέλω ραντεβού ακόμη.",
    language: "greek",
    mustIntent: "business_areas",
    source: "REFALCO GROUP official website",
    mustMention: /ανάπτυξη|υποδομ|λειτουργ|τεχνολογ|στρατηγικ/i,
    mustNotMention: /(?:κλείσουμε|κανονίσουμε|ορίσουμε).{0,20}(?:ραντεβού|συνάντηση)|(?:ραντεβού|συνάντηση).{0,20}(?:κλείσουμε|κανονίσουμε|ορίσουμε)/i
  },
  {
    id: "el-services-activity-paraphrase",
    text: "Τι δραστηριότητες έχει η Refalco; Δεν θέλω ραντεβού τώρα.",
    language: "greek",
    mustIntent: "business_areas",
    source: "REFALCO GROUP official website",
    mustMention: /ανάπτυξη|υποδομ|λειτουργ|τεχνολογ|στρατηγικ/i,
    mustNotMention: /(?:κλείσουμε|κανονίσουμε|ορίσουμε).{0,20}(?:ραντεβού|συνάντηση)|(?:ραντεβού|συνάντηση).{0,20}(?:κλείσουμε|κανονίσουμε|ορίσουμε)/i
  }
];

async function run() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for live conversation evaluation.");
  const ragStore = createStore();
  const totals = [];
  for (const item of cases) {
    const startedAt = performance.now();
    const userId = `qa-${item.id}`;
    const user = { id: userId, phone: "QA test contact", profile: {}, history: [], booking: null };
    const store = {
      ensureUser: async () => user,
      getUser: async () => user,
      updateUser: async (_id, update) => update(user),
      addHistory: async (_id, message, response, extra) => {
        const turn = { message, response, metadata: extra?.metadata || {} };
        user.history.push(turn);
        return turn;
      }
    };

    const normalizeStartedAt = performance.now();
    const prepared = await prepareInboundMessage({ userId, incoming: item.text, user, store });
    const routed = await routeMessageResult({ userId, text: item.text, store, existingUser: user, preparedInbound: prepared });
    const routeMs = Math.round(performance.now() - normalizeStartedAt);
    const bookingStartedAt = performance.now();
    const booking = await handleBookingMessage({ userId, text: item.text, store, user });
    const bookingMs = Math.round(performance.now() - bookingStartedAt);
    if (booking || isBookingRequest(item.text)) throw new Error(`${item.id}: informational request entered booking flow`);
    if (!isBookingRequest(item.text) && routed.metadata.intent.intents.includes("appointment")) throw new Error(`${item.id}: declined meeting remained classified as an appointment request`);
    if (item.mustIntent && !routed.metadata.intent.intents.includes(item.mustIntent)) throw new Error(`${item.id}: intent did not include ${item.mustIntent}; got ${routed.metadata.intent.intents.join(", ")}`);
    if (user.profile.name) throw new Error(`${item.id}: unexpectedly captured a name`);
    if (routed.metadata.intent.language !== item.language) throw new Error(`${item.id}: language ${routed.metadata.intent.language}, expected ${item.language}`);
    if (!routed.shouldUseAi) throw new Error(`${item.id}: request did not reach the AI/RAG answer path`);

    let stageStartedAt = performance.now();
    const embedding = await embedText(item.text);
    const embeddingMs = Math.round(performance.now() - stageStartedAt);
    stageStartedAt = performance.now();
    const evidence = await ragStore.searchKnowledge(item.text, embedding, DEFAULT_EMBEDDING_MODEL, 6);
    const retrievalMs = Math.round(performance.now() - stageStartedAt);
    if (!evidence.some((row) => row.source_name === item.source)) throw new Error(`${item.id}: expected approved evidence ${item.source}; got ${evidence.map((row) => row.source_name).join(", ") || "none"}`);

    const context = buildConversationContext(user, { currentMessage: item.text });
    stageStartedAt = performance.now();
    const generated = await askOpenRouter({ text: item.text, evidence, includeSources: false, conversationSummary: context.summary, conversationTurns: context.turns });
    const modelMs = Math.round(performance.now() - stageStartedAt);
    const response = generated || answerFromEvidence(evidence)?.answer;
    if (!response) throw new Error(`${item.id}: no grounded response generated`);
    if (item.mustMention && !item.mustMention.test(response)) throw new Error(`${item.id}: generated response missed expected source-supported details: ${response}`);
    if (item.mustNotMention && item.mustNotMention.test(response)) throw new Error(`${item.id}: generated response contradicted request/policy: ${response}`);
    await recordHistory(store, userId, item.text, response, { metadata: routed.metadata });

    const result = {
      id: item.id,
      language: routed.metadata.intent.language,
      intent: routed.metadata.intent.intents,
      source: evidence.find((row) => row.source_name === item.source).source_name,
      response,
      capturedName: user.profile.name || null,
      bookingCreated: Boolean(user.booking),
      bookingIntent: isBookingRequest(item.text),
      handover: Boolean(routed.metadata.handover),
      modelUsed: Boolean(generated),
      stagesMs: { route: routeMs, bookingGate: bookingMs, embedding: embeddingMs, retrieval: retrievalMs, model: modelMs, total: Math.round(performance.now() - startedAt) }
    };
    console.log(JSON.stringify(result));
    totals.push(result.stagesMs);
  }
  for (const stage of ["route", "bookingGate", "embedding", "retrieval", "model", "total"]) {
    const values = totals.map((item) => item[stage]);
    console.log(`Latency ${stage}: avg=${Math.round(values.reduce((a, b) => a + b, 0) / values.length)}ms n=${values.length} max=${Math.max(...values)}ms`);
  }
}

run().catch((error) => {
  console.error(`WhatsApp conversation evaluation failed: ${String(error.message || error).slice(0, 500)}`);
  process.exitCode = 1;
});
