/** Prevent an older async load from overwriting the result of a newer view. */
export function createLatestRequestGate() {
  let latest = 0;
  return {
    begin() { latest += 1; return latest; },
    isCurrent(id) { return id === latest; },
    invalidate() { latest += 1; }
  };
}
