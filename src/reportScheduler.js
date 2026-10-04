const cron = require("node-cron");
const { safeErrorDiagnostics } = require("./operationalTelemetry");

function startMonthlyReportSchedule({ store, onReport, logEvent }) {
  const timezone = process.env.REPORT_TIMEZONE || "Europe/Nicosia";
  const schedule = process.env.REPORT_CRON || "0 9 1 * *";

  const task = cron.schedule(
    schedule,
    async () => {
      try {
        const report = await onReport({ store });
        logEvent("monthly_report_sent", {
          userCount: report.userCount,
          rowCount: report.rowCount
        });
      } catch (error) {
        console.error("Monthly report failed:", safeErrorDiagnostics(error));
        logEvent("monthly_report_error", safeErrorDiagnostics(error));
      }
    },
    { timezone }
  );

  return task;
}

module.exports = { startMonthlyReportSchedule };
