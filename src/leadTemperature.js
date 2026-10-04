const SIGNALS = {
  booking: /\b(book|booking|appointment|schedule|meet|meeting|available time|reserve)\b|حجز|موعد|احجز|مقابلة/i,
  decline: /\b(not interested|no thanks|stop messaging|don't contact|do not contact|unsubscribe)\b|غير مهتم|لا أريد|لا تراسلني/i,
  interest: /\b(interested|tell me more|more information|learn more|how much|price|pricing|cost|investment|portfolio|project|property|properties|viewing|visit)\b|مهتم|معلومات|السعر|المشاريع|العقارات/i
};

function classifyLeadTemperature({ history = [], booking = null } = {}) {
  if (["booked", "confirmed"].includes(String(booking?.status || "").toLowerCase())) {
    return { status: "hot", reason: "appointment_booked" };
  }

  const customerMessages = history.map((turn) => String(turn.message || "")).filter(Boolean);
  const recent = customerMessages.slice(-12).join("\n");
  if (SIGNALS.decline.test(recent)) return { status: "cold", reason: "explicit_decline" };
  if (SIGNALS.booking.test(customerMessages.slice(-4).join("\n"))) {
    return { status: "hot", reason: "appointment_interest" };
  }
  if (SIGNALS.interest.test(recent)) return { status: "warm", reason: "refalco_interest" };
  return { status: "unclassified", reason: "no_clear_signal" };
}

module.exports = { classifyLeadTemperature };
