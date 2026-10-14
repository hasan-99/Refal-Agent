export function formatUsageUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "Unavailable";
  const fractionDigits = amount === 0 || amount >= 1 ? 2 : amount < 0.01 ? 8 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionDigits
  }).format(amount);
}
