const IDENTITY_FIELDS = Object.freeze([
  "legalName",
  "brand",
  "groupName",
  "jurisdiction",
  "timezone",
  "cities",
  "departments",
  "languages"
]);

export const COMPANY_IDENTITY_CHANGE_REASONS = Object.freeze([
  { value: "clarify_customer_follow_up", label: "Clarify customer follow-up" },
  { value: "improve_localized_wording", label: "Improve localized wording" },
  { value: "align_with_approved_process", label: "Align with approved process" },
  { value: "remove_outdated_guidance", label: "Remove outdated guidance" },
  { value: "other_operational_adjustment", label: "Other operational adjustment" }
]);

export function companyIdentityView(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("A validated company identity profile is required.");
  }

  return Object.fromEntries(IDENTITY_FIELDS.map((field) => {
    const value = profile[field];
    if (Array.isArray(value)) return [field, value.filter((item) => typeof item === "string")];
    if (typeof value !== "string") throw new TypeError(`Company identity field ${field} is invalid.`);
    return [field, value];
  }));
}
