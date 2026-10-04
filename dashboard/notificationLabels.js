export function notificationJobLabel(job = {}) {
  const channel = job.channel === "email" ? "email" : "WhatsApp";
  if (job.kind === "owner_review") return "Admin email";
  if (job.kind === "handover_review") return "Admin handover email";
  if (job.kind === "admin_followup") return `Admin follow-up ${channel}`;
  if (job.kind === "customer_message") return `Customer ${channel}`;
  return `Notification ${channel}`;
}
