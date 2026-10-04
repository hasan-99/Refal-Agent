function validateBookingPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Booking policy must be an object.");
  const timezone = String(value.timezone || "").trim();
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new Error("Choose a valid IANA timezone."); }

  const calendarId = String(value.calendarId || "").trim();
  if (!calendarId || calendarId.length > 320 || /\s/.test(calendarId)) throw new Error("Choose a valid calendar ID.");

  const weekdays = [...new Set(value.weekdays || [])].sort((a, b) => a - b);
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 5)) throw new Error("Choose one or more weekdays (Monday-Friday).");

  const startTime = String(value.startTime || "");
  const endTime = String(value.endTime || "");
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(startTime) || !timePattern.test(endTime) || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    throw new Error("Enter a valid same-day start and end time.");
  }

  const durationMinutes = value.durationMinutes === null || value.durationMinutes === "" ? null : Number(value.durationMinutes);
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240)) throw new Error("Duration must be between 1 and 240 minutes.");
  if (typeof value.durationOwnerConfirmed !== "boolean") throw new Error("Duration confirmation must be true or false.");
  if (value.durationOwnerConfirmed && durationMinutes === null) throw new Error("Set a duration before confirming it.");

  const minimumNoticeHours = value.minimumNoticeHours === null || value.minimumNoticeHours === "" ? null : Number(value.minimumNoticeHours);
  if (minimumNoticeHours !== null && (!Number.isFinite(minimumNoticeHours) || minimumNoticeHours < 0 || minimumNoticeHours > 8760)) throw new Error("Minimum notice must be between 0 and 8760 hours.");

  if (!Array.isArray(value.reminderHours) || value.reminderHours.length > 6 || value.reminderHours.some((hours) => !Number.isInteger(hours) || hours < 1 || hours > 8760)) {
    throw new Error("Reminder offsets must be whole hours between 1 and 8760.");
  }

  return {
    timezone,
    calendarId,
    weekdays,
    startTime,
    endTime,
    durationMinutes,
    durationOwnerConfirmed: value.durationOwnerConfirmed,
    minimumNoticeHours,
    reminderHours: [...new Set(value.reminderHours)].sort((a, b) => b - a),
    createMeetLink: Boolean(value.createMeetLink)
  };
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

module.exports = { timeToMinutes, validateBookingPolicy };
