import test from "node:test";
import assert from "node:assert/strict";

// Regression guard for the 2026-10-09/10 incident: api.sold-comps.com was down
// and 13 cards in batch_0048 came out status="failed". The cards were fine —
// images, OCR and active listings all present — but a comp-provider outage
// threw out of getLiveCardComps into markCardFailed().
//
// These assert the CONTRACT the pipeline depends on: getLiveCardComps resolves
// even when the sold-comp provider throws, returns whatever active listings it
// found, and reports the reason instead of swallowing it.

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(keys) {
  for (const key of keys) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

test("a sold-comp provider outage resolves instead of throwing", async () => {
  const keys = ["SOLD_COMPS_PROVIDER", "SOLDCOMPS_API_KEY", "SOLDCOMPS_BASE_URL", "SOLDCOMPS_REQUEST_TIMEOUT_MS"];
  process.env.SOLD_COMPS_PROVIDER = "soldcomps";
  process.env.SOLDCOMPS_API_KEY = "sc_test";
  // Port 9 (discard) refuses immediately — a real connection failure, no mocks.
  process.env.SOLDCOMPS_BASE_URL = "http://127.0.0.1:9";
  process.env.SOLDCOMPS_REQUEST_TIMEOUT_MS = "1000";

  const { getLiveCardComps } = await import("../src/services/comps.js");
  const originalFetch = global.fetch;
  // Active listings succeed; only the sold-comp leg is broken.
  global.fetch = async (url) => {
    if (String(url).includes("127.0.0.1:9")) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  try {
    const result = await getLiveCardComps(
      { playerName: "Test Player", year: "2024", setName: "Test Set", cardNumber: "1" },
      null, null, null, [], null, true,
    );
    assert.ok(result, "must resolve, not throw");
    assert.deepEqual(result.sold, [], "no sold comps when the provider is down");
    assert.ok(Array.isArray(result.active), "active listings are still returned");
    assert.ok(result.soldError, "the reason is reported, not swallowed");
  } finally {
    global.fetch = originalFetch;
    restoreEnv(keys);
  }
});

test("manual comps survive a provider outage", async () => {
  const keys = ["SOLD_COMPS_PROVIDER", "SOLDCOMPS_API_KEY", "SOLDCOMPS_BASE_URL"];
  process.env.SOLD_COMPS_PROVIDER = "soldcomps";
  process.env.SOLDCOMPS_API_KEY = "sc_test";
  process.env.SOLDCOMPS_BASE_URL = "http://127.0.0.1:9";

  const { getLiveCardComps } = await import("../src/services/comps.js");
  try {
    // A manually-attached comp short-circuits the provider entirely, so this
    // path must keep working regardless of provider health.
    const result = await getLiveCardComps(
      { playerName: "Test Player", year: "2024", setName: "Test Set", cardNumber: "1" },
      null, null, null,
      [{ listingId: "m1", title: "Manual comp", totalPrice: 12.5 }],
      null, true,
    );
    assert.equal(result.sold.length, 1, "the manual comp is preserved");
  } finally {
    restoreEnv(keys);
  }
});
