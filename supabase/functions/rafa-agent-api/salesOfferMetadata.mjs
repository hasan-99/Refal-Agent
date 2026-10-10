const HOOK_IDS = new Set(["H1_IP_BOX", "H2_RESIDENCY", "H3_RELOCATION", "H4_SUBSTANCE", "H5_TRADEMARK", "H6_PR_TO_PROPERTY"]);

export function validateSalesOfferMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["type", "id"].includes(key))) return null;
  if (value.type !== "hook" || !HOOK_IDS.has(value.id)) return null;
  return { type: "hook", id: value.id };
}

export function validateSpecialistOfferMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !["offered", "consentRequired", "offeredAt"].includes(key))) return null;
  if (value.offered !== true || value.consentRequired !== true || typeof value.offeredAt !== "string" || !Number.isFinite(Date.parse(value.offeredAt))) return null;
  return { offered: true, consentRequired: true, offeredAt: value.offeredAt };
}
