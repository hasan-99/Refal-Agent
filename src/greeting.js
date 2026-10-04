function localHour(now = new Date(), timezone = "Europe/Nicosia") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).map((part) => [part.type, part.value])
  );

  return Number(parts.hour);
}

function timeGreeting(now = new Date(), timezone = "Europe/Nicosia") {
  const hour = localHour(now, timezone);
  if (hour >= 5 && hour < 12) return "صباح الخير ☀️";
  return "مساء الخير";
}

module.exports = { localHour, timeGreeting };
