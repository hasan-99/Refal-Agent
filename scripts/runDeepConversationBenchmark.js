const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

const { createStore } = require("../src/supabaseStore");
const { BenchmarkStore, processTurn, safeBenchmarkErrorCategory } = require("./runConversationBenchmark");
const { buildDeepConversationCases } = require("./conversationDeepScenarios");
const { safeSimulatorFailureReason, simulateCustomerTurn } = require("./benchmarkCustomerRoleplay");
const { detectExplicitLanguageRequest, detectMessageLanguage } = require("../src/language");
const { DEFAULT_EMBEDDING_MODEL } = require("../src/ai");

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/u);
    if (match) result[match[1]] = match[2];
    else if (arg.startsWith("--")) result[arg.slice(2)] = true;
  }
  return result;
}

function safeConversationHistory(turns) {
  return turns.slice(-4).flatMap(({ incoming, response }) => [
    { role: "user", content: incoming },
    { role: "assistant", content: response }
  ]);
}

const LANGUAGE_CODES = { english: "en", arabic: "ar", greek: "el" };
const ARABIZI_MARKERS = new Set(["arabizi", "shoghlha", "shoghl", "baddi", "bdi", "bade", "shu", "shoo", "bt2addmo", "t2aked", "t2akkad", "mish", "mesh", "3am", "3andi", "wein", "leish", "kifak", "keefak", "hayda", "hayde", "yalla", "wallah"]);
const GREEKLISH_MARKERS = new Set(["thelo", "anoikso", "etaireia", "stin", "kypro", "yperesies", "exete", "asxoleitai", "rantevou", "kostizei", "sigouro", "poso", "kata8esi", "kataesi", "egkrisi", "synithismeno", "xroniko", "diastima", "mexri", "kathorisei", "teliko", "desmeftiko", "epivevaiose", "anthropos", "paketo", "perilamvanei", "perilambanei", "perilamvanetai", "perilambanetai", "tesseres", "mines", "grammateia", "diefthynsi"]);

function detectTransliteratedLanguage(message) {
  const text = String(message || "").normalize("NFKC");
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(text)) return "arabic";
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/u.test(text)) return "greek";
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) || [];
  const arabiziHits = new Set(words.filter((word) => ARABIZI_MARKERS.has(word)));
  const greeklishHits = new Set(words.filter((word) => GREEKLISH_MARKERS.has(word)));
  if (arabiziHits.size && !greeklishHits.size) return "arabic";
  if (greeklishHits.size && !arabiziHits.size) return "greek";
  return null;
}

function detectRoleplayLanguageRequest(message) {
  return detectExplicitLanguageRequest(message)
    || (/(?:جاوبني|احكي معي|رد علي|كمل معي)\s+بالشامي/u.test(String(message || "")) ? "arabic" : null);
}

function updateCustomerLanguage(current, message, allowLanguageSwitch, explicitLanguageLock = null, scenario = "") {
  const explicit = detectRoleplayLanguageRequest(message);
  if (explicit) return { language: explicit, explicitLanguageLock: explicit };
  if (explicitLanguageLock) return { language: explicitLanguageLock, explicitLanguageLock };
  // These corpus families intentionally use transliteration as a language
  // signal. Preserve that signal through later romanized turns, which generic
  // script detection otherwise mistakes for English.
  const transliterated = detectTransliteratedLanguage(message);
  if (transliterated && ["transliteration", "greeklish"].includes(scenario)) {
    // A transliterated current message is a strong signal for this turn, not
    // an explicit request to keep that language forever. Follow a later
    // language change unless the customer actually asked to lock one.
    return { language: transliterated, explicitLanguageLock: null };
  }
  if (allowLanguageSwitch) return { language: detectMessageLanguage(message) || current, explicitLanguageLock: null };
  return { language: current, explicitLanguageLock: null };
}

function attributeCustomerTurn(turn, source, fallbackReason = null) {
  turn.clientTurnSource = source;
  if (fallbackReason) turn.clientTurnFallbackReason = fallbackReason;
  return turn;
}

function classifyHardProviderFailure(value) {
  const text = String(value || "");
  const status = text.match(/(?:http[_ -]?|status\s*[:=]?\s*)(401|402|403|429)\b/iu)?.[1];
  if (status) return `http_${status}`;
  if (/insufficient[_ -]quota|quota[_ -]exceeded|usage[_ -]limit|billing[_ -]limit|payment[_ -]required/iu.test(text)) return "quota_or_billing";
  if (/invalid[_ -]api[_ -]?key|unauthorized|authentication[_ -]failed/iu.test(text)) return "authentication";
  return null;
}

function summarizeCoverage(rows, field) {
  const output = {};
  for (const row of rows) {
    const key = row[field] || "unknown";
    output[key] ||= { requested: 0, completed: 0, fullyAdaptive: 0, degraded: 0, scripted: 0, partial: 0 };
    const bucket = output[key];
    bucket.requested += 1;
    if (row.runStatus !== "partial") bucket.completed += 1;
    if (row.runStatus === "fully_adaptive") bucket.fullyAdaptive += 1;
    if (row.runStatus === "degraded") bucket.degraded += 1;
    if (row.runStatus === "scripted") bucket.scripted += 1;
    if (row.runStatus === "partial") bucket.partial += 1;
  }
  return output;
}

function classifyConversationStatus({ turnCount, expectedTurns, modelEnabled, localOnly, customerFallbacks = 0, operationalErrors = 0 }) {
  if (turnCount < expectedTurns) return "partial";
  if (!modelEnabled || localOnly) return "scripted";
  if (customerFallbacks > 0 || operationalErrors > 0) return "degraded";
  return "fully_adaptive";
}

function safeErrorSummary(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\b(?:sk-or-v1-|sk-|Bearer\s+)[A-Za-z0-9._-]{12,}/giu, "[redacted]")
    .replace(/https?:\/\/\S+/giu, "[provider-url]")
    .replace(/[\r\n\t]/gu, " ").slice(0, 180);
}

async function runDeepConversation(item, ragStore, modelEnabled, counters) {
  const started = performance.now();
  const store = new BenchmarkStore(`deep-benchmark:${item.id}`);
  const turns = [];
  const dialogue = [];
  let incoming = item.messages[0];
  let customerLanguage = item.locale === "ar" ? "arabic" : item.locale === "el" ? "greek" : "english";
  let explicitCustomerLanguage = null;
  let incomingSource = "scripted-seed";
  let incomingFallbackReason = null;
  let roleplayFallbackCount = 0;
  const roleplayFallbacks = [];
  try {
    for (let turnIndex = 0; turnIndex < item.messages.length; turnIndex += 1) {
      if (counters.hardFailure) break;
      const languageState = updateCustomerLanguage(customerLanguage, incoming, item.allowLanguageSwitch, explicitCustomerLanguage, item.scenario);
      customerLanguage = languageState.language;
      explicitCustomerLanguage = languageState.explicitLanguageLock;
      const agentTurn = await processTurn({ item, incoming, store, ragStore, modelEnabled, counters });
      attributeCustomerTurn(agentTurn, incomingSource, incomingFallbackReason);
      incomingFallbackReason = null;
      turns.push(agentTurn);
      dialogue.push({ incoming, response: agentTurn.response });
      const agentFailure = (agentTurn.operationalEvents || []).map(classifyHardProviderFailure).find(Boolean);
      if (agentFailure) {
        counters.hardFailure ||= agentFailure;
        counters.hardFailureSource ||= "agent";
        counters.hardFailureConversation ||= item.id;
        break;
      }

      const nextIndex = turnIndex + 1;
      if (nextIndex >= item.messages.length) continue;
      const plannedMessage = item.messages[nextIndex];
      if (nextIndex < 3 || !modelEnabled || item.localOnly) {
        incoming = plannedMessage;
        incomingSource = item.localOnly ? "scripted-local-only" : !modelEnabled ? "scripted-model-disabled" : "scripted-seed";
        continue;
      }
      try {
        const generated = await simulateCustomerTurn({
          locale: LANGUAGE_CODES[customerLanguage] || item.locale,
          scenario: item.scenario,
          allowLanguageSwitch: item.allowLanguageSwitch,
          plannedMessage,
          persona: item.persona?.instruction,
          responseBeat: item.responseBeats?.[nextIndex - 3],
          seed: item.seed * 100 + nextIndex,
          conversation: safeConversationHistory(dialogue),
          onUsage: (usage) => {
            counters.clientPromptTokens += Number(usage.prompt_tokens) || 0;
            counters.clientCompletionTokens += Number(usage.completion_tokens) || 0;
            counters.clientReportedCostUsd += Number(usage.cost) || 0;
          }
        });
        counters.clientModelCalls += 1;
        incoming = generated.message;
        incomingSource = "response-aware-model";
      } catch (error) {
        roleplayFallbackCount += 1;
        counters.clientModelErrors += 1;
        const reason = safeSimulatorFailureReason(error);
        const hardFailure = classifyHardProviderFailure(reason) || classifyHardProviderFailure(error?.message);
        if (hardFailure) {
          counters.hardFailure ||= hardFailure;
          counters.hardFailureSource ||= "customer_simulator";
          counters.hardFailureConversation ||= item.id;
        }
        roleplayFallbacks.push({ turn: nextIndex + 1, reason });
        counters.clientSimulatorFallbackReasons ||= {};
        counters.clientSimulatorFallbackReasons[reason] = (counters.clientSimulatorFallbackReasons[reason] || 0) + 1;
        incoming = plannedMessage;
        incomingSource = "scripted-fallback";
        incomingFallbackReason = reason;
      }
      if (counters.hardFailure) break;
    }
    const persisted = JSON.stringify({ user: store.user, effects: store.effects });
    const sensitivePatterns = [
      /FAKE-ONLY-Secret-7241/u,
      /4111111111111111/u,
      /\bCY(?:\s?\d){26}\b/iu,
      /\b(?:otp|one[- ]time code|cvv)\s*[:=]?\s*\d{3,8}\b/iu,
      /FAKE-ONLY-PASSPORT-\d{5,}/u
    ];
    const findings = turns.flatMap((turn, index) => (turn.findings || []).map((finding) => ({ turn: index + 1, finding })));
    if (sensitivePatterns.some((pattern) => pattern.test(persisted))) findings.push({ turn: 0, finding: "sensitive_test_content_persisted_in_memory_state" });
    if (store.effects.appointments.length || store.effects.externalWrites) findings.push({ turn: 0, finding: "benchmark_created_external_side_effect" });
    counters.clientSimulatorFallbacks += roleplayFallbackCount;
    counters.completed += 1;
    counters.findingTurns += findings.length;
    counters.retrievalCalls += turns.filter((turn) => turn.retrievalAttempted).length;
    counters.ragErrors += turns.filter((turn) => turn.retrievalError).length;
    return {
      id: item.id,
      index: item.index,
      scenario: item.scenario,
      category: item.category,
      depthGroup: item.depthGroup,
      locale: item.locale,
      durationMs: Math.round(performance.now() - started),
      turnCount: turns.length,
      runStatus: classifyConversationStatus({ turnCount: turns.length, expectedTurns: item.messages.length, modelEnabled, localOnly: item.localOnly, customerFallbacks: roleplayFallbackCount, operationalErrors: turns.reduce((count, turn) => count + (turn.operationalEvents || []).length, 0) }),
      fullyAdaptive: turns.length === item.messages.length && modelEnabled && !item.localOnly && roleplayFallbackCount === 0 && !turns.some((turn) => (turn.operationalEvents || []).length),
      customerSimulatorFallbacks: roleplayFallbackCount,
      customerSimulatorFallbackDetails: roleplayFallbacks,
      findings,
      turns,
      state: {
        nameCaptured: Boolean(store.user.profile?.name),
        need: store.user.profile?.need || null,
        companyActivity: store.user.profile?.opportunityIntake?.data?.businessActivity || null,
        handoverCount: store.effects.handovers.length,
        consentEvents: store.effects.consentEvents,
        bookingStatus: store.user.booking?.status || null,
        appointmentWrites: store.effects.appointments.length,
        externalWrites: store.effects.externalWrites
      }
    };
  } catch (error) {
    counters.completed += 1;
    counters.conversationErrors += 1;
    return {
      id: item.id,
      index: item.index,
      scenario: item.scenario,
      category: item.category,
      depthGroup: item.depthGroup,
      locale: item.locale,
      durationMs: Math.round(performance.now() - started),
      turnCount: turns.length,
      runStatus: "degraded",
      fullyAdaptive: false,
      findings: [{ turn: turns.length + 1, finding: `conversation_error:${safeBenchmarkErrorCategory(error, "conversation")}` }],
      turns,
      state: { handoverCount: store.effects.handovers.length, appointmentWrites: store.effects.appointments.length, externalWrites: store.effects.externalWrites }
    };
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Math.max(1, Math.min(3000, Number(args.limit) || 300));
  const concurrency = Math.max(1, Math.min(5, Number(args.concurrency) || 3));
  const modelEnabled = args.model !== "false" && args.model !== false;
  if (modelEnabled && !process.env.OPENROUTER_API_KEY) throw new Error("Live deep benchmark requires OPENROUTER_API_KEY.");
  const cases = buildDeepConversationCases(3000).slice(0, limit);
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(args.out || path.join(__dirname, "..", "reports", "client-conversation-benchmark", `${date}-deep-300-live`));
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir, { recursive: false }); // Fail instead of overwriting earlier evidence.
  const resultsPath = path.join(outDir, "conversations.jsonl");
  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = {
    benchmark: "deep-response-aware-prospect-simulations",
    requestedTotal: cases.length,
    corpusSize: 3000,
    localeCounts: cases.reduce((counts, item) => ({ ...counts, [item.locale]: (counts[item.locale] || 0) + 1 }), {}),
    scenarioFamilies: new Set(cases.map((item) => item.scenario)).size,
    customerTurnsPerConversation: 8,
    customerRoleplay: "Three seeded turns establish each storyline; up to five model-roleplayed turns use seeded persona and behavior variation and react to the actual exchange. Planned concerns are optional cues: the simulator must not repeat a concern already answered. A separate OPENROUTER_CUSTOMER_MODEL may be configured. Synthetic sensitive-data cases stay local and scripted.",
    modelEnabled,
    agentModel: process.env.OPENROUTER_MODEL || "configured-default",
    customerSimulatorModel: process.env.OPENROUTER_CUSTOMER_MODEL || process.env.OPENROUTER_MODEL || "configured-default",
    ragMode: "live read-only search against current approved knowledge; local embeddings; no Supabase contact/workflow writes",
    mockedIntegrations: ["WhatsApp delivery", "Calendar event writes", "contact/workflow persistence", "notifications"],
    generatedAt: new Date().toISOString(),
    status: "running",
    completionPolicy: "Any authentication, quota, billing, or HTTP 401/402/403/429 provider failure stops new work and preserves a partial run. Fallback conversations are labeled degraded and are not counted as fully adaptive."
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(resultsPath, "", { encoding: "utf8", flag: "wx" });

  const ragStore = createStore();
  const counters = {
    completed: 0,
    agentModelCalls: 0,
    deterministicTurns: 0,
    agentModelErrors: 0,
    clientModelCalls: 0,
    clientModelErrors: 0,
    clientSimulatorFallbacks: 0,
    clientPromptTokens: 0,
    clientCompletionTokens: 0,
    clientReportedCostUsd: 0,
    conversationErrors: 0,
    clientSimulatorFallbackReasons: {},
    findingTurns: 0,
    retrievalCalls: 0,
    ragErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    reportedCostUsd: 0
  };
  // `processTurn` shares these exact counter keys with the regular harness.
  counters.modelCalls = 0;
  counters.modelErrors = 0;
  const summaryStart = performance.now();
  let next = 0;
  const rows = [];
  let writeQueue = Promise.resolve();
  async function worker() {
    while (true) {
      if (counters.hardFailure) return;
      const index = next++;
      if (index >= cases.length) return;
      const result = await runDeepConversation(cases[index], ragStore, modelEnabled, counters);
      rows.push(result);
      writeQueue = writeQueue.then(() => fs.appendFile(resultsPath, `${JSON.stringify(result)}\n`, "utf8"));
      await writeQueue;
      if (counters.completed % 5 === 0 || counters.completed === cases.length) {
        console.log(JSON.stringify({ progress: counters.completed, total: cases.length, agentModelCalls: counters.modelCalls, customerSimulatorCalls: counters.clientModelCalls, customerSimulatorErrors: counters.clientModelErrors, conversationErrors: counters.conversationErrors, findingTurns: counters.findingTurns, ragErrors: counters.ragErrors, reportedCostUsd: Number((counters.reportedCostUsd + counters.clientReportedCostUsd).toFixed(4)), elapsedSeconds: Math.round((performance.now() - summaryStart) / 1000) }));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await writeQueue;
  counters.agentModelCalls = counters.modelCalls;
  counters.agentModelErrors = counters.modelErrors;
  const completed = rows.filter((row) => row.runStatus !== "partial").length;
  const fullyAdaptive = rows.filter((row) => row.fullyAdaptive).length;
  const summary = { ...manifest, status: counters.hardFailure ? "stopped_partial" : (completed === cases.length ? "completed" : "incomplete"), requested: cases.length, completed, partial: rows.length - completed, fullyAdaptive, degraded: rows.filter((row) => row.runStatus === "degraded").length, scripted: rows.filter((row) => row.runStatus === "scripted").length, byLocale: summarizeCoverage(rows, "locale"), byScenario: summarizeCoverage(rows, "scenario"), hardFailure: counters.hardFailure ? { category: counters.hardFailure, source: counters.hardFailureSource, conversationId: counters.hardFailureConversation } : null, counters, elapsedSeconds: Math.round((performance.now() - summaryStart) / 1000), finishedAt: new Date().toISOString(), resultsPath };
  await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, status: summary.status, requested: summary.requested, completed: summary.completed, partial: summary.partial, fullyAdaptive: summary.fullyAdaptive, degraded: summary.degraded, scripted: summary.scripted, hardFailure: summary.hardFailure }, null, 2)}\n`, { encoding: "utf8" });
  if (summary.status !== "completed") {
    await fs.writeFile(path.join(outDir, "partial-run-status.json"), `${JSON.stringify({ status: summary.status, requested: summary.requested, completed: summary.completed, partial: summary.partial, fullyAdaptive: summary.fullyAdaptive, degraded: summary.degraded, scripted: summary.scripted, hardFailure: summary.hardFailure, byLocale: summary.byLocale, byScenario: summary.byScenario, finishedAt: summary.finishedAt }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ finished: true, ...summary }));
}

if (require.main === module) run().catch((error) => {
  console.error(`Deep conversation benchmark failed: ${safeBenchmarkErrorCategory(error, "conversation")}`);
  process.exitCode = 1;
});

module.exports = { attributeCustomerTurn, classifyConversationStatus, classifyHardProviderFailure, detectRoleplayLanguageRequest, detectTransliteratedLanguage, runDeepConversation, safeErrorSummary, summarizeCoverage, updateCustomerLanguage };
