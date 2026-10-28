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

test("response style settings are read and changed only through administrator routes", () => {
  for (const method of ["get", "put"]) {
    const route = "/api/settings/response-style";
    const declaration = routeDeclaration(method, route);
    assert.ok(declaration, `route exists: ${method.toUpperCase()} ${route}`);
    assert.match(declaration, /\brequireAdmin\b/, `${method.toUpperCase()} ${route} must enforce administrator access`);
  }
});

test("business rules and hooks are administrator-only, reasoned edits to the validated setting", () => {
  for (const method of ["get", "put"]) {
    const route = "/api/settings/business-guidance";
    const declaration = routeDeclaration(method, route);
    assert.ok(declaration, `route exists: ${method.toUpperCase()} ${route}`);
    assert.match(declaration, /\brequireAdmin\b/, `${method.toUpperCase()} ${route} must enforce administrator access`);
  }
  const start = serverSource.indexOf('app.put("/api/settings/business-guidance"');
  const end = serverSource.indexOf("\napp.", start);
  const putRoute = serverSource.slice(start, end < 0 ? undefined : end);
  assert.match(putRoute, /reasonCodes\.has\(reason\)/u, "business guidance changes require a controlled reason code");
  assert.match(putRoute, /validateBusinessGuidance/u, "server validates the complete typed rules and hooks shape");
  assert.match(putRoute, /business_guidance_admin_updated/u, "saves create an admin audit event");
  assert.match(serverSource, /business_guidance_admin_updated/u, "business-guidance changes are included in the admin audit allowlist");
  assert.match(putRoute, /saved:\s*true,\s*error:/u, "audit write failures tell the admin the value saved but the audit did not");
});
