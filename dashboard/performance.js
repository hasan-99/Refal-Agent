export const QUALIFICATION_STATUSES = Object.freeze(["unreviewed", "qualified", "not_qualified"]);
export const WORKFLOW_DIMENSIONS = Object.freeze(["need", "value", "timing", "authority", "readiness", "fit"]);

export function workflowSignalStatus(lead = {}) {
  const signals = lead.workflow || lead.operatorSignals || {};
  const dimensions = signals.dimensions || {};
  const dimensionTotal = WORKFLOW_DIMENSIONS.reduce((sum, key) => sum + (Number.isFinite(Number(dimensions[key])) ? Number(dimensions[key]) : 0), 0);
  return {
    intent: signals.intent || lead.intent || "unknown",
    classification: signals.classification || lead.classification || "unclassified",
    priority: signals.priority || lead.priority || "normal",
    dimensionTotal,
    consent: signals.consent?.followUp || lead.followUpConsent || "unknown",
    followUp: signals.followUp?.status || "consent_required",
    complaint: Boolean(signals.flags?.complaint || lead.isComplaint),
    existingClient: Boolean(signals.flags?.existingClient || lead.existingClient),
    handoverRequired: Boolean(signals.handover?.required || lead.handoverRequired)
  };
}

export function normalizeQualificationStatus(value) {
  return QUALIFICATION_STATUSES.includes(value) ? value : "unreviewed";
}

export function qualificationStatus(user) {
  return normalizeQualificationStatus(user?.qualificationStatus ?? user?.profile?.qualification?.status);
}

export function leadTemperatureStatus(lead) {
  const value = lead?.leadTemperatureStatus ?? lead?.profile?.leadTemperature?.status;
  return ["hot", "warm", "cold"].includes(value) ? value : "unclassified";
}

export function aggregatePerformance({ overview = {}, leads = [], bookings = [], now = new Date() } = {}) {
  const qualified = leads.filter((lead) => qualificationStatus(lead) === "qualified").length;
  const notQualified = leads.filter((lead) => qualificationStatus(lead) === "not_qualified").length;
  const bookedStatuses = new Set(["booked", "confirmed"]);
  const booked = bookings.filter((booking) => bookedStatuses.has(String(booking.status || "").toLowerCase()));
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const upcomingAppointments = booked
    .filter((booking) => {
      const start = new Date(booking.start || 0).getTime();
      return Number.isFinite(start) && start >= nowTime;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  const appointmentContactIds = new Set(booked.map((booking) => booking.userId).filter(Boolean));
  const bookedLeadCount = leads.filter((lead) => appointmentContactIds.has(lead.id)).length;
  const temperature = { hot: 0, warm: 0, cold: 0, unclassified: 0 };
  const workflow = { priority: 0, complaints: 0, existingClients: 0, handovers: 0, consentGranted: 0, consentUnknown: 0 };
  for (const lead of leads) temperature[leadTemperatureStatus(lead)] += 1;
  for (const lead of leads) {
    const status = workflowSignalStatus(lead);
    if (["urgent", "high"].includes(status.priority)) workflow.priority += 1;
    if (status.complaint) workflow.complaints += 1;
    if (status.existingClient) workflow.existingClients += 1;
    if (status.handoverRequired) workflow.handovers += 1;
    if (status.consent === "granted") workflow.consentGranted += 1;
    if (status.consent === "unknown") workflow.consentUnknown += 1;
  }

  return {
    conversations: {
      today: count(overview.stats?.conversationsToday),
      week: count(overview.stats?.conversationsThisWeek),
      month: count(overview.stats?.conversationsThisMonth),
      messagesToday: count(overview.stats?.messagesToday),
      engagedContacts: leads.filter((lead) => count(lead.conversationCount) > 0).length
    },
    leads: {
      total: leads.length,
      qualified,
      notQualified,
      unreviewed: leads.length - qualified - notQualified,
      reviewed: qualified + notQualified,
      booked: bookedLeadCount,
      temperature,
      workflow
    },
    appointments: {
      booked: booked.length,
      upcoming: upcomingAppointments.length,
      upcomingList: upcomingAppointments.slice(0, 5)
    }
  };
}

export function aggregateModelUsage(events = [], users = [], { now = new Date(), clientLabel = () => "Contact" } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const dayKeys = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - (365 - index)));
    return date.toISOString().slice(0, 10);
  });
  const monthKeys = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - (11 - index), 1));
    return date.toISOString().slice(0, 7);
  });
  const byDay = Object.fromEntries(dayKeys.map((key) => [key, emptyUsageBucket(key)]));
  const byMonth = Object.fromEntries(monthKeys.map((key) => [key, emptyUsageBucket(key)]));
  const clients = new Map();
  const interactions = [];
  let actualTokens = 0;
  let actualCostUsd = 0;
  let tokenReportedInteractions = 0;
  let costReportedInteractions = 0;
  let missingTokenInteractions = 0;
  let missingCostInteractions = 0;
  let trackedSince = "";
  const modelTokens = new Map();

  for (const event of events) {
    if (event.event !== "ai_usage" && event.event !== "ai_usage_missing") continue;
    const at = event.at && Number.isFinite(new Date(event.at).getTime()) ? new Date(event.at).toISOString() : "";
    const userId = event.userId || "";
    const source = event.source === "dashboard" ? "dashboard" : "whatsapp";
    const model = String(event.model || "Unknown model").slice(0, 160);
    const promptTokens = nonnegativeInteger(event.promptTokens);
    const completionTokens = nonnegativeInteger(event.completionTokens);
    const totalTokens = nonnegativeInteger(event.totalTokens);
    const costUsd = nonnegativeNumber(event.costUsd);
    const usageAvailable = event.event === "ai_usage";
    const label = clientLabel(userId, source);
    const day = at.slice(0, 10);
    const month = at.slice(0, 7);
    const dayBucket = byDay[day];
    const monthBucket = byMonth[month];
    const clientKey = source === "whatsapp" ? (userId || `unlinked-${interactions.length}`) : null;
    const target = clientKey ? clients.get(clientKey) || {
      clientLabel: label,
      interactions: 0,
      actualTokens: 0,
      tokenReportedInteractions: 0,
      exactCostUsd: 0,
      exactCostInteractions: 0,
      missingCostInteractions: 0,
      models: new Map()
    } : null;

    if (target) target.interactions += 1;
    if (totalTokens !== null) {
      if (target) {
        target.actualTokens += totalTokens;
        target.tokenReportedInteractions += 1;
        target.models.set(model, (target.models.get(model) || 0) + totalTokens);
      }
      actualTokens += totalTokens;
      tokenReportedInteractions += 1;
      modelTokens.set(model, (modelTokens.get(model) || 0) + totalTokens);
    } else {
      missingTokenInteractions += 1;
    }
    if (costUsd !== null) {
      if (target) {
        target.exactCostUsd += costUsd;
        target.exactCostInteractions += 1;
      }
      actualCostUsd += costUsd;
      costReportedInteractions += 1;
    } else {
      if (target) target.missingCostInteractions += 1;
      missingCostInteractions += 1;
    }
    if (target && clientKey) clients.set(clientKey, target);

    if (at && (!trackedSince || at < trackedSince)) trackedSince = at;
    for (const bucket of [dayBucket, monthBucket]) {
      if (!bucket) continue;
      bucket.interactions += 1;
      if (totalTokens !== null) bucket.actualTokens += totalTokens;
      if (costUsd !== null) {
        bucket.exactCostUsd += costUsd;
        bucket.exactCostInteractions += 1;
      } else {
        bucket.missingCostInteractions += 1;
      }
    }
    interactions.push({
      at,
      model,
      clientLabel: label,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      usageAvailable,
      source
    });
  }

  const longestContacts = users.map((user) => ({
    clientLabel: clientLabel(user.id, "whatsapp"),
    turns: Array.isArray(user.history) ? user.history.length : nonnegativeInteger(user.conversationCount) || 0
  })).filter((user) => user.turns > 0).sort((a, b) => b.turns - a.turns).slice(0, 5);
  const clientRows = [...clients.values()].map((client) => ({
    clientLabel: client.clientLabel,
    interactions: client.interactions,
    actualTokens: client.actualTokens,
    tokenReportedInteractions: client.tokenReportedInteractions,
    exactCostUsd: client.exactCostUsd,
    exactCostInteractions: client.exactCostInteractions,
    missingCostInteractions: client.missingCostInteractions
  })).sort((a, b) => b.exactCostUsd - a.exactCostUsd || b.actualTokens - a.actualTokens).slice(0, 20);
  const heaviestClient = [...clients.values()].sort((a, b) => b.actualTokens - a.actualTokens)[0];
  const heaviestModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    actual: {
      interactions: interactions.length,
      actualTokens,
      exactCostUsd: actualCostUsd,
      tokenReportedInteractions,
      missingTokenInteractions,
      exactCostInteractions: costReportedInteractions,
      missingCostInteractions,
      trackedSince: trackedSince || null,
      byDay: Object.values(byDay),
      byMonth: Object.values(byMonth),
      interactionsList: interactions.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
      clients: clientRows,
      heaviestClient: heaviestClient && heaviestClient.actualTokens > 0 ? {
        clientLabel: heaviestClient.clientLabel,
        actualTokens: heaviestClient.actualTokens,
        model: [...heaviestClient.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown model"
      } : null,
      heaviestModel: heaviestModel ? { model: heaviestModel[0], actualTokens: heaviestModel[1] } : null,
      longestContacts
    }
  };
}

function emptyUsageBucket(key) {
  return { period: key, interactions: 0, actualTokens: 0, exactCostUsd: 0, exactCostInteractions: 0, missingCostInteractions: 0 };
}

function nonnegativeInteger(value) {
  if (typeof value !== "number") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nonnegativeNumber(value) {
  if (typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
