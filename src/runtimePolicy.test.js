const assert = require("node:assert/strict");
const { shouldClearLoggedOutAuth } = require("./runtimePolicy");

assert.equal(shouldClearLoggedOutAuth("210277387751547@lid"), false);
assert.equal(shouldClearLoggedOutAuth(""), true);

console.log("Runtime test policy checks passed.");
