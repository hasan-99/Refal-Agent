export function notificationBadgeText(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return count > 99 ? "99+" : String(count);
}
