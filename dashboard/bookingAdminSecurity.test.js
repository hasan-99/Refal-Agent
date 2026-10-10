import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("./server.js", import.meta.url), "utf8");

function routeDeclaration(method, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`app\\.${method}\\(\\s*[\"']${escaped}[\"']\\s*,([\\s\\S]*?)=>\\s*\\{`);
  return serverSource.match(pattern)?.[1] || "";
}

test("M7 calendar authorization, access verification, and policy writes require administrator middleware", () => {
  for (const [method, route] of [
    ["post", "/api/bookings/calendar-oauth/start"],
    ["post", "/api/bookings/test-calendar"],
    ["put", "/api/bookings/policy"],
    ["post", "/api/bookings/:id/review"]
  ]) {
    const declaration = routeDeclaration(method, route);
    assert.ok(declaration, `route exists: ${method.toUpperCase()} ${route}`);
    assert.match(declaration, /\brequireAdmin\b/, `${method.toUpperCase()} ${route} must enforce administrator access`);
  }
});
