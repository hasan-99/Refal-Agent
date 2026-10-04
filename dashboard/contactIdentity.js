export function isPlausibleCustomerName(value) {
  const name = String(value || "").trim();
  if (name.length < 2 || name.length > 60 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name)) return false;
  if (name.split(/\s+/u).length > 4) return false;
  return !/(?:^|\s)(?:a|an|the|and|or|of|for|to|in|on|at|with|interested|looking|want|need|please|my|your|who|what|how|hello|hi|yes|no|مرحبا|مرحبًا|أهلا|اهلا|شو|ماذا|كيف|هل|من|في|على|عن|إلى|الى|مع|بدي|أريد|اريد|مهتم|مهتمة|أحتاج|احتاج|أنا|انا|και|σε|με|για|από|απο|είμαι|ειμαι|ενδιαφέρομαι)(?:$|\s)/iu.test(name) && !/^(?:ιδιοκτήτης|ιδιοκτήτρια|υπεύθυνος|υπεύθυνη|πελάτης|πελάτισσα|owner|director|manager|client|customer)$/iu.test(name);
}

export function displayName(user = {}) {
  return String(
    user.profile?.nameOverride ||
      (isPlausibleCustomerName(user.profile?.name) ? user.profile.name : "") ||
      user.whatsapp?.pushName ||
      user.profile?.whatsappName ||
      ""
  ).trim();
}
