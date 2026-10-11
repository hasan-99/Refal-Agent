/** Read every PostgREST page, propagating failures instead of returning a partial ledger. */
export async function readAllRows(readPage, path, pageSize = 1000) {
  if (typeof readPage !== "function") throw new TypeError("A page reader is required.");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError("Page size must be a positive integer.");
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await readPage(path, `${offset}-${offset + pageSize - 1}`);
    if (!Array.isArray(page)) throw new TypeError("A data page must be an array.");
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** Replace the order parameter with a unique secondary key for stable page boundaries. */
export function withStableIdOrder(path, column = "created_at", direction = "desc") {
  if (!/^[a-z_][a-z0-9_]*$/u.test(column)) throw new TypeError("A safe order column is required.");
  if (!["asc", "desc"].includes(direction)) throw new TypeError("Order direction must be asc or desc.");
  const [resource, query = ""] = String(path || "").split("?");
  if (!resource) throw new TypeError("A PostgREST resource path is required.");
  const parameters = query.split("&").filter(Boolean).filter((part) => !part.startsWith("order="));
  parameters.push(`order=${column}.${direction},id.${direction}`);
  return `${resource}?${parameters.join("&")}`;
}

export function withStableCreatedAtIdOrder(path, direction = "desc") {
  return withStableIdOrder(path, "created_at", direction);
}
