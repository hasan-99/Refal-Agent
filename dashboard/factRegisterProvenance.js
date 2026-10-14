const OWNER_MANUAL = /Master Brain & Operating Rules Manual/i;

export function summarizeManualEvidenceFacts(facts = []) {
  const manualFacts = (Array.isArray(facts) ? facts : []).filter((fact) => OWNER_MANUAL.test(String(fact?.sourceDocument || "")));
  return {
    facts: manualFacts,
    approved: manualFacts.filter((fact) => fact.status === "approved").length,
    pending: manualFacts.filter((fact) => fact.status === "pending").length,
  };
}
