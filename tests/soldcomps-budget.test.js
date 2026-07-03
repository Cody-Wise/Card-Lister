import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchApifySoldListings, getSoldCompsUsageStatus } from "../src/services/apify.js";

// searchApifySoldListings() persists a local monthly request counter (see
// src/services/apify.js) so it can fail clearly before actually hitting
// SoldComps' real quota and getting 403s on every subsequent lookup for the
// rest of the billing cycle. Point that counter at an isolated per-file temp
// path — Node's test runner runs separate *.test.js files concurrently by
// default, so sharing the real data/soldcomps-usage.json with other suites
// (e.g. apify.test.js) would race.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usagePath = path.join(rootDir, "tmp", "test-soldcomps-usage-budget.json");
process.env.SOLDCOMPS_USAGE_FILE = usagePath;

// Each test starts from a clean slate (current month, zero count) so tests
// don't interfere with each other's budget math.
beforeEach(async () => {
  await fsp.mkdir(path.dirname(usagePath), { recursive: true });
  await fsp.writeFile(
    usagePath,
    JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 0 }),
  );
});

const ORIGINAL_ENV = { ...process.env };
function withEnv(overrides, fn) {
  Object.assign(process.env, overrides);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(overrides)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });
}

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = originalFetch;
  };
}

test("getSoldCompsUsageStatus reports zero usage against the configured limit", async () => {
  await withEnv({ SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "5" }, async () => {
    const status = await getSoldCompsUsageStatus();
    assert.equal(status.count, 0);
    assert.equal(status.limit, 5);
    assert.equal(status.remaining, 5);
  });
});

test("a successful SoldComps request increments the monthly usage counter", async () => {
  await withEnv({ SOLDCOMPS_API_KEY: "sc_test", SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "5" }, async () => {
    const restore = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
    try {
      await searchApifySoldListings({ playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" });
      const status = await getSoldCompsUsageStatus();
      assert.equal(status.count, 1);
      assert.equal(status.remaining, 4);
    } finally {
      restore();
    }
  });
});

test("throws a clear quota error once the monthly budget is exhausted (no fallback provider exists)", async () => {
  await withEnv(
    { SOLDCOMPS_API_KEY: "sc_test", SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "1" },
    async () => {
      let soldCompsCalls = 0;
      const restore = mockFetch(async () => {
        soldCompsCalls += 1;
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      });
      try {
        const metadata = { playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" };
        await searchApifySoldListings(metadata);
        assert.equal(soldCompsCalls, 1);

        // Budget (limit 1) is now exhausted — the next call should throw
        // without hitting the network at all.
        await assert.rejects(() => searchApifySoldListings(metadata), /monthly request budget/i);
        assert.equal(soldCompsCalls, 1, "SoldComps should not be called again once budget is exhausted");
      } finally {
        restore();
      }
    },
  );
});
