const DEFAULT_BUSINESS_HOURS = {
  timezone: "Europe/Nicosia",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00"
};

const OUTSIDE_BUSINESS_HOURS_NOTE =
  "حالياً برا ساعات العمل الرسمية، رح نرد عليك بشكل كامل أول شي بأول يوم عمل ";

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  const dayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    day: dayMap[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || "").split(":").map(Number);
  return hours * 60 + minutes;
}

function businessHoursConfig(company) {
  return {
    ...DEFAULT_BUSINESS_HOURS,
    ...(company.businessHours || {})
  };
}

function isWithinBusinessHours(company, now = new Date()) {
  const config = businessHoursConfig(company);
  const local = localParts(now, config.timezone);
  const start = minutesFromTime(config.start);
  const end = minutesFromTime(config.end);

  return config.days.includes(local.day) && local.minutes >= start && local.minutes < end;
}

function withBusinessHoursNotice(company, response, now = new Date()) {
  if (isWithinBusinessHours(company, now)) return response;
  return `${OUTSIDE_BUSINESS_HOURS_NOTE}\n\n${response}`;
}

module.exports = {
  OUTSIDE_BUSINESS_HOURS_NOTE,
  isWithinBusinessHours,
  withBusinessHoursNotice
};
