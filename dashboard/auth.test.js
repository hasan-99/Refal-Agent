import test from "node:test";
import assert from "node:assert/strict";
import { applyAuthResponseHeaders, canAccessDashboardSession, clearAuthCookies, isSameOriginRequest, parseCookieHeader, roleAllows, serializeCookie, validPassword } from "./auth.js";

test("cookie parser preserves equals signs and safely decodes values", () => {
  assert.deepEqual(parseCookieHeader("a=one%20two; token=abc==; broken"), [
    { name: "a", value: "one two" }, { name: "token", value: "abc==" }
  ]);
});

test("auth cookie serialization is HttpOnly, same-site, and secure when requested", () => {
  const cookie = serializeCookie("rafa", "token", { path: "/", sameSite: "lax", httpOnly: true, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
});

test("logout expires every auth cookie chunk", () => {
  const headers = [];
  clearAuthCookies({ headers: { cookie: "rafa-dashboard-auth.0=one; unrelated=x; rafa-dashboard-auth.1=two" } }, {
    append: (_name, value) => headers.push(value)
  }, true);
  assert.equal(headers.length, 2);
  assert.ok(headers.every((value) => value.includes("Max-Age=0") && value.includes("HttpOnly") && value.includes("Secure")));
});

test("rotated auth cookies carry Supabase no-cache response headers", () => {
  const headers = new Map();
  applyAuthResponseHeaders({ setHeader: (name, value) => headers.set(name, value) }, {
    "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
    Expires: "0",
    Pragma: "no-cache"
  });
  assert.equal(headers.get("Cache-Control"), "private, no-cache, no-store, must-revalidate, max-age=0");
  assert.equal(headers.get("Expires"), "0");
  assert.equal(headers.get("Pragma"), "no-cache");
});

test("same-origin validation rejects foreign and cross-site requests", () => {
  assert.equal(isSameOriginRequest("https://rafa.example", "rafa.example", "same-origin", "https"), true);
  assert.equal(isSameOriginRequest("http://rafa.example", "rafa.example", "same-origin", "https"), false);
  assert.equal(isSameOriginRequest("https://evil.example", "rafa.example", "cross-site", "https"), false);
  assert.equal(isSameOriginRequest(undefined, "rafa.example", "same-origin"), true);
  assert.equal(isSameOriginRequest(undefined, "rafa.example", undefined), false);
});

test("only active dashboard roles are permitted and only admins satisfy admin access", () => {
  assert.equal(roleAllows("user", "user"), true);
  assert.equal(roleAllows("user", "admin"), false);
  assert.equal(roleAllows("pending", "user"), false);
  assert.equal(roleAllows("admin", "admin"), true);
});

test("chat sessions are private to their owner while admins can inspect unowned legacy sessions", () => {
  const own = { owner_user_id: "user-a" };
  const member = { id: "user-a", role: "user" };
  assert.equal(canAccessDashboardSession(own, member), true);
  assert.equal(canAccessDashboardSession(own, { id: "admin-a", role: "admin" }), false);
  assert.equal(canAccessDashboardSession(own, { id: "user-b", role: "user" }), false);
  assert.equal(canAccessDashboardSession({ owner_user_id: null }, member), false);
  assert.equal(canAccessDashboardSession({ owner_user_id: null }, { id: "admin-a", role: "admin" }), true);
  assert.equal(canAccessDashboardSession(null, { id: "admin-a", role: "admin" }), false);
});

test("password policy enforces length and mixed character classes", () => {
  assert.equal(validPassword("StrongEnough2026"), true);
  assert.equal(validPassword("shortA1"), false);
  assert.equal(validPassword("alllowercase2026"), false);
});
