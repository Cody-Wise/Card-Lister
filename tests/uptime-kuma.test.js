import test from "node:test";
import assert from "node:assert/strict";
import { pingUptimeKuma } from "../src/lib/uptime-kuma.js";

test("does nothing when no push URL is configured", () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = () => {
    called = true;
    return Promise.resolve();
  };
  try {
    pingUptimeKuma("", { status: "up", msg: "fine" });
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("builds a push URL with status/msg query params and truncates long messages", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = (url) => {
    requestedUrl = url;
    return Promise.resolve();
  };
  try {
    pingUptimeKuma("http://kuma.local/api/push/abc123", {
      status: "down",
      msg: "x".repeat(500),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get("status"), "down");
    assert.equal(parsed.searchParams.get("msg").length, 300);
  } finally {
    global.fetch = originalFetch;
  }
});

test("swallows fetch failures instead of throwing", async () => {
  const originalFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error("network down"));
  try {
    assert.doesNotThrow(() => pingUptimeKuma("http://kuma.local/api/push/abc123", { status: "up" }));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.fetch = originalFetch;
  }
});
