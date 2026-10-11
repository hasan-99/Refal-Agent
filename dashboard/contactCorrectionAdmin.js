const CORRECTABLE_FIELDS = Object.freeze(["nameOverride", "phoneOverride", "needOverride", "conversationSummary"]);

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function valuesFor(user) {
  const profile = user?.profile || {};
  return {
    nameOverride: String(profile.nameOverride || ""),
    phoneOverride: String(profile.phoneOverride || ""),
    needOverride: String(profile.needOverride || ""),
    conversationSummary: String(profile.conversationSummary || "")
  };
}

export function registerContactCorrectionAdminRoutes(app, { store, requireAdmin, now = () => new Date() }) {
  app.put("/api/leads/:id/contact", requireAdmin, async (req, res) => {
    const submitted = req.body?.contact;
    const expected = req.body?.expected;
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      return res.status(400).json({ error: "Submit contact correction fields." });
    }
    const fields = Object.keys(submitted);
    if (!fields.length || fields.some((field) => !CORRECTABLE_FIELDS.includes(field))) {
      return res.status(400).json({ error: "Choose supported contact correction fields." });
    }
    if (expected !== undefined && (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).some((field) => !CORRECTABLE_FIELDS.includes(field)))) {
      return res.status(400).json({ error: "The correction baseline is invalid. Reload the contact and try again." });
    }

    try {
      if (typeof store.correctContactProfile !== "function") {
        return res.status(503).json({ error: "Atomic, audited contact correction is unavailable." });
      }
      const limits = { nameOverride: 120, phoneOverride: 40, needOverride: 160, conversationSummary: 700 };
      const changes = Object.fromEntries(fields.map((field) => [field, cleanText(submitted[field], limits[field])]));
      const baseline = expected || valuesFor(await store.getUser(req.params.id, { includeHistory: false }));
      const result = await store.correctContactProfile(req.params.id, changes, baseline, req.dashboardUser.email || req.dashboardUser.id);
      res.json({ ok: true, profile: result.profile || {} });
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({ code: "contact_correction_stale", error: "This contact changed since you opened it. Reload the current values before saving." });
      }
      if (error?.status === 404) {
        return res.status(404).json({ error: "User not found." });
      }
      res.status(502).json({ error: "Could not save and audit the contact correction. No success was confirmed." });
    }
  });
}

export { CORRECTABLE_FIELDS, valuesFor };
