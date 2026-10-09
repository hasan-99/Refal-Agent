const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("./store");
const { routeMessage, routeMessageResult, isValidWhatsAppReplyKey, buildReplyEditPayload, persistWhatsAppSentMessage } = require("./messageRouter");
const { embedTexts, EMBEDDING_DIMENSIONS } = require("./ai");
const { isWithinBusinessHours, withBusinessHoursNotice } = require("./businessHours");
const { detectMessageLanguage, languageInstruction } = require("./language");
const { appointmentWindowIssue, calendarId, googleAuth, hasCalendarConfig, hasOAuthCalendarCredentials, isBookingRequest, parseBookingDetails } = require("./booking");
const { generateConversationReport } = require("./report");
const { FOLLOW_UP_MESSAGE, runFollowUpCheck, shouldSendFollowUp } = require("./followUp");
const { AI_LIMIT_MESSAGE, allowAiMessage, allowIncomingMessage, resetRateLimiters } = require("./rateLimiter");
const { validateBookingPolicy } = require("./bookingPolicy");
const { isPairingOnly } = require("./runtimePolicy");
const { clearLoggedOutAuth, pairingFailureMessage, shouldRequestPairingCode } = require("./whatsappPairing");

async function main() {
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-company-bot-"));
assert.equal(shouldRequestPairingCode({ qr: undefined, phoneNumber: "35799260049", registered: false, pairingCodeRequested: false }), false);
assert.equal(shouldRequestPairingCode({ qr: "ready", phoneNumber: "35799260049", registered: false, pairingCodeRequested: false }), true);
assert.equal(shouldRequestPairingCode({ qr: "ready", phoneNumber: "35799260049", registered: false, pairingCodeRequested: true }), false);
assert.equal(shouldRequestPairingCode({ qr: "ready", phoneNumber: "", registered: false, pairingCodeRequested: false }), false);
assert.doesNotMatch(pairingFailureMessage(new Error("Connection Closed for +35799260049"), "+35799260049"), /35799260049/);
const authFixture = path.join(tempDir, "baileys-auth");
fs.mkdirSync(authFixture);
fs.writeFileSync(path.join(authFixture, "creds.json"), "{}");
fs.writeFileSync(path.join(authFixture, "session-1.json"), "{}");
fs.writeFileSync(path.join(authFixture, "notes.txt"), "preserve");
await clearLoggedOutAuth(authFixture);
assert.equal(fs.existsSync(path.join(authFixture, "creds.json")), false);
assert.equal(fs.existsSync(path.join(authFixture, "session-1.json")), false);
assert.equal(fs.existsSync(path.join(authFixture, "notes.txt")), true);
assert.equal(isPairingOnly({}), false);
assert.equal(isPairingOnly({ RAFA_PAIRING_ONLY: "false" }), false);
assert.equal(isPairingOnly({ RAFA_PAIRING_ONLY: " TRUE " }), true);
const store = new MemoryStore();
await assert.rejects(
  () => generateConversationReport({ outputDir: path.join(tempDir, "reports") }),
  /Supabase-backed store is required/
);
assert.equal(fs.existsSync(path.join(tempDir, "users.json")), false);
const company = { businessHours: { timezone: "Europe/Nicosia", days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "24:00" } };
const userId = "35799111222@c.us";
const sentKey = { remoteJid: userId, fromMe: true, id: "ABCDEF123456" };
assert.equal(isValidWhatsAppReplyKey(userId, sentKey), true);
assert.equal(isValidWhatsAppReplyKey(userId, { ...sentKey, fromMe: false }), false);
assert.equal(isValidWhatsAppReplyKey(userId, { ...sentKey, remoteJid: "35799999999@c.us" }), false);
assert.equal(isValidWhatsAppReplyKey(userId, { ...sentKey, id: "short" }), false);
assert.equal(isValidWhatsAppReplyKey("123@g.us", { ...sentKey, remoteJid: "123@g.us" }), false);
assert.deepEqual(buildReplyEditPayload({ userId, text: "Updated answer", mode: "platform_edit", messageKey: sentKey }), {
  text: "Updated answer", edit: sentKey
});
assert.deepEqual(buildReplyEditPayload({ userId, text: "Updated answer", mode: "correction_resend" }), {
  text: "Correction: Updated answer"
});
assert.throws(() => buildReplyEditPayload({ userId, text: "Updated answer", mode: "platform_edit", messageKey: { ...sentKey, fromMe: false } }), /key is invalid/i);
let sentTurnPatch;
await persistWhatsAppSentMessage({
  store: { updateHistoryTurn: async (id, turnId, patch) => { sentTurnPatch = { id, turnId, patch }; return { id: turnId, ...patch }; } },
  userId,
  response: "An approved answer",
  turn: { id: "turn-1", metadata: { citations: ["source-1"] } },
  sentMessage: { key: sentKey },
  sentAt: "2026-09-30T12:00:00.000Z"
});
assert.equal(sentTurnPatch.id, userId);
assert.deepEqual(sentTurnPatch.patch.metadata, {
  whatsapp: { messageKey: sentKey, sentAt: "2026-09-30T12:00:00.000Z" }
});
await assert.rejects(() => persistWhatsAppSentMessage({
  store: { updateHistoryTurn: async () => { throw new Error("persistence unavailable"); } },
  userId,
  response: "An approved answer",
  turn: { id: "turn-1", metadata: { citations: ["source-1"] } },
  sentMessage: { key: sentKey }
}), /persistence unavailable/);

const trackedTurn = await routeMessageResult({
  userId: "35799111000@c.us",
  text: "hello",
  store: {
    ensureUser: async () => ({ profile: {} }),
    addHistory: async () => ({ id: "turn-123", metadata: {} })
  }
});
assert.equal(trackedTurn.turnId, "turn-123");
assert.equal(trackedTurn.turn.id, "turn-123");

const firstGreeting = await routeMessage({
  userId,
  text: "hello",
  store,
  company,
  now: new Date("2026-01-05T07:00:00.000Z")
});
assert.match(firstGreeting, /digital assistant/i);
const rafaQuestion = await routeMessageResult({ userId, text: "Could you tell me about a project for families?", store });
assert.equal(rafaQuestion.shouldUseAi, true);
assert.match(await routeMessage({ userId, text: "profile", store }), /Name: not set/);
assert.match(await routeMessage({ userId, text: "menu", store }), /approved Refalco Group information/i);

const firstQuestionStore = new MemoryStore();
const firstQuestionResponse = await routeMessage({
  userId: "35799111333@c.us",
  text: "what services do you do?",
  store: firstQuestionStore,
  company
});
assert.match(firstQuestionResponse, /approved Refalco Group information/i);

const invalidStore = new MemoryStore();
assert.equal((await routeMessageResult({ userId: "35799111444@c.us", text: "?", store: invalidStore })).shouldUseAi, true);
assert.equal(invalidStore.getUser("35799111444@c.us").profile.name, undefined);

const saved = store.getUser(userId);
assert.equal(saved.profile.name, undefined);
assert.ok(saved.history.length >= 2);

const historyLength = saved.history.length;
assert.match(await routeMessage({ userId, text: "reset", store }), /cleared/i);
assert.ok(store.getUser(userId).history.length > historyLength);
assert.equal(store.getUser(userId).profile.name, undefined);

assert.equal(store.deleteUser(userId), true);
assert.equal(store.getUser(userId), null);
assert.match(await routeMessage({ userId, text: "hello", store }), /digital assistant/i);

assert.equal(detectMessageLanguage("Tell me about Refalco Group projects"), "english");
assert.equal(detectMessageLanguage("شو مشاريع الشركة؟"), "arabic");
assert.match(languageInstruction("arabic"), /Reply in Arabic/);
assert.match(languageInstruction("english"), /Reply in English/);
assert.equal(isBookingRequest("I want to book a meeting"), true);
assert.equal(isBookingRequest("how can I call you?"), false);
assert.equal(isBookingRequest("بدي احجز موعد"), true);
const bookingPolicy = validateBookingPolicy({ timezone: "Europe/Nicosia", calendarId: "primary", weekdays: [1,2,3,4,5], startTime: "10:00", endTime: "15:00", durationMinutes: 30, durationOwnerConfirmed: true, minimumNoticeHours: 24, reminderHours: [24,1], createMeetLink: true });
const incompleteBookingPolicy = { ...bookingPolicy, durationMinutes: null, durationOwnerConfirmed: false, minimumNoticeHours: null, reminderHours: [] };
assert.throws(() => validateBookingPolicy({ ...bookingPolicy, timezone: "not-a-timezone" }));
assert.throws(() => validateBookingPolicy({ ...bookingPolicy, weekdays: [0] }));
assert.equal(hasCalendarConfig(bookingPolicy), false);
process.env.GOOGLE_CALENDAR_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "test-refresh-token";
assert.equal(hasOAuthCalendarCredentials(), true);
assert.equal(calendarId(bookingPolicy), "primary");
assert.equal(hasCalendarConfig(bookingPolicy), true);
const oauthCalendarClient = googleAuth();
assert.equal(oauthCalendarClient.credentials.refresh_token, "test-refresh-token");
process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "";
assert.equal(hasOAuthCalendarCredentials(), false);
assert.equal(hasCalendarConfig(bookingPolicy), false);
process.env.GOOGLE_CALENDAR_CLIENT_ID = "";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "";
process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "";
assert.equal(
  appointmentWindowIssue(new Date("2026-01-05T08:00:00.000Z"), new Date("2026-01-05T08:30:00.000Z"), bookingPolicy, new Date("2026-01-01T08:00:00.000Z")),
  null
);
assert.equal(
  appointmentWindowIssue(new Date("2026-01-04T08:00:00.000Z"), new Date("2026-01-04T08:30:00.000Z"), bookingPolicy, new Date("2026-01-01T08:00:00.000Z")),
  "hours"
);
assert.equal(
  appointmentWindowIssue(new Date("2026-01-02T08:00:00.000Z"), new Date("2026-01-02T08:30:00.000Z"), bookingPolicy, new Date("2026-01-01T12:00:00.000Z")),
  "notice"
);
delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
const parsedBooking = parseBookingDetails("Monday 14:00 to discuss investment", bookingPolicy, new Date("2026-01-01T08:00:00.000Z"));
assert.ok(parsedBooking);
assert.equal(parseBookingDetails("Sunday March 29, 2026 at 03:30", bookingPolicy, new Date("2026-01-01T08:00:00.000Z")), null);
assert.equal(parseBookingDetails("Sunday October 25, 2026 at 03:30", bookingPolicy, new Date("2026-01-01T08:00:00.000Z")), null);
assert.ok(parseBookingDetails("Monday March 30, 2026 at 10:30", bookingPolicy, new Date("2026-01-01T08:00:00.000Z")));
assert.match(
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Nicosia",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(parsedBooking.start),
  /14:00/
);
const dstForwardBooking = parseBookingDetails("Monday 10:00 to discuss a project", bookingPolicy, new Date("2026-03-27T08:00:00.000Z"));
assert.ok(dstForwardBooking);
assert.equal(dstForwardBooking.start.toISOString(), "2026-03-30T07:00:00.000Z");
assert.equal(parseBookingDetails("Sunday 03:30 to discuss a project", bookingPolicy, new Date("2026-03-27T08:00:00.000Z")), null);
assert.equal(parseBookingDetails("Sunday 03:30 to discuss a project", bookingPolicy, new Date("2026-10-23T08:00:00.000Z")), null);

assert.equal(isWithinBusinessHours(company, new Date("2026-01-05T08:00:00.000Z")), true);
assert.equal(isWithinBusinessHours(company, new Date("2026-01-05T16:00:00.000Z")), true);
assert.equal(isWithinBusinessHours(company, new Date("2026-01-04T08:00:00.000Z")), true);
assert.equal(
  withBusinessHoursNotice(company, "Normal reply", new Date("2026-01-05T16:00:00.000Z")),
  "Normal reply"
);
assert.equal(
  withBusinessHoursNotice(company, "Normal reply", new Date("2026-01-05T08:00:00.000Z")),
  "Normal reply"
);

const followUpStore = new MemoryStore();
const followUpUserId = "35799111555@s.whatsapp.net";
followUpStore.ensureUser(followUpUserId);
followUpStore.updateUser(followUpUserId, (user) => {
  user.history.push({
    at: "2026-01-01T08:00:00.000Z",
    message: "Tell me about projects",
    response: "Here are the projects."
  });
});
assert.equal(shouldSendFollowUp(followUpStore.getUser(followUpUserId), new Date("2026-01-02T09:00:00.000Z")), false);

const goodbyeUserId = "35799111666@s.whatsapp.net";
followUpStore.ensureUser(goodbyeUserId);
followUpStore.updateUser(goodbyeUserId, (user) => {
  user.history.push({
    at: "2026-01-01T08:00:00.000Z",
    message: "thank you",
    response: "You are welcome."
  });
});
assert.equal(shouldSendFollowUp(followUpStore.getUser(goodbyeUserId), new Date("2026-01-02T09:00:00.000Z")), false);

let sentFollowUps = 0;
const followUpPromise = runFollowUpCheck({
  store: followUpStore,
  now: new Date("2026-01-02T09:00:00.000Z"),
  sendFollowUp: async (target, text) => {
    assert.equal(target, followUpUserId);
    assert.equal(text, FOLLOW_UP_MESSAGE);
    sentFollowUps += 1;
  }
}).then(() => {
  assert.equal(sentFollowUps, 0);
  assert.equal(followUpStore.getUser(followUpUserId).lastFollowUpSent, undefined);
});

resetRateLimiters();
const rateUser = "35799111777@s.whatsapp.net";
for (let index = 0; index < 10; index += 1) {
  assert.equal(allowIncomingMessage(rateUser, new Date("2026-01-01T08:00:00.000Z")), true);
}
assert.equal(allowIncomingMessage(rateUser, new Date("2026-01-01T08:00:30.000Z")), false);
assert.equal(allowIncomingMessage(rateUser, new Date("2026-01-01T08:01:01.000Z")), true);

resetRateLimiters();
const previousDailyLimit = process.env.RATE_LIMIT_PER_DAY;
process.env.RATE_LIMIT_PER_DAY = "2";
assert.equal(allowAiMessage(rateUser, new Date("2026-01-01T08:00:00.000Z")), true);
assert.equal(allowAiMessage(rateUser, new Date("2026-01-01T09:00:00.000Z")), true);
assert.equal(allowAiMessage(rateUser, new Date("2026-01-01T10:00:00.000Z")), false);
assert.equal(allowAiMessage(rateUser, new Date("2026-01-02T08:00:00.000Z")), true);
assert.equal(
  AI_LIMIT_MESSAGE,
  "وصلت للحد الأقصى من الأسئلة اليوم، تواصل معنا مباشرة على الإيميل أو الهاتف وفريقنا رح يساعدك "
);
process.env.RATE_LIMIT_PER_DAY = previousDailyLimit;

const previousApiKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-key";
const originalFetch = global.fetch;
let embeddingPayload;
global.fetch = async (_url, options) => {
  embeddingPayload = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0.25) }] })
  };
};
const testEmbeddings = await embedTexts(["My email is hasan@example.com, call me at +357 99112233"], async () => async (input, options) => {
  embeddingPayload = { input: Array.isArray(input) ? input : [input], options };
  const count = Array.isArray(input) ? input.length : 1;
  return { dims: [count, 384], data: new Float32Array(count * 384).fill(0.25) };
});
assert.equal(testEmbeddings[0].length, EMBEDDING_DIMENSIONS);
assert.doesNotMatch(embeddingPayload.input[0], /hasan@example\.com|99112233/);
global.fetch = originalFetch;
if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = previousApiKey;

Promise.all([
  followUpPromise,
  generateConversationReport({
  store,
  outputDir: path.join(tempDir, "reports"),
  now: new Date("2026-01-31T12:00:00.000Z")
  })
])
  .then(([, report]) => {
    assert.ok(fs.existsSync(report.filePath));
    assert.ok(report.userCount >= 1);
    assert.ok(report.rowCount >= 1);
    console.log("Smoke test passed.");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
