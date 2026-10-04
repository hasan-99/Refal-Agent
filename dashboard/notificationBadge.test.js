import test from "node:test";
import assert from "node:assert/strict";
import { notificationBadgeText } from "./notificationBadge.js";

test("notification badge count is readable, bounded, and safe for invalid values", () => {
  assert.equal(notificationBadgeText(0), "0");
  assert.equal(notificationBadgeText(1), "1");
  assert.equal(notificationBadgeText(99), "99");
  assert.equal(notificationBadgeText(100), "99+");
  assert.equal(notificationBadgeText(-2), "0");
  assert.equal(notificationBadgeText("unknown"), "0");
});
