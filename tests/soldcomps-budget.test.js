import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  searchSoldCompsListings,
  getSoldCompsUsageStatus,
  soldCompsMaxAttempts,
} from "../src/services/soldcomps.js";

// searchSoldCompsListings() persists a local monthly request counter (see
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
    // Return a real (non-empty) item so this test isolates the "one
    // successful request, one counted" case. An always-empty mock instead
    // exercises the empty-scrape retry path (see apify.test.js), which
    // intentionally spends more than one request against the budget.
    const restore = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            itemId: "budget_test_1",
            title: "2024 Test Set Test Player #1",
            condition: "Pre-Owned",
            soldPrice: "9.99",
            shippingPrice: "0.00",
            totalPrice: "9.99",
            endedAt: "2026-06-07T00:00:00.000Z",
            url: "https://www.ebay.com/itm/budget_test_1",
            listingType: "buy_it_now",
          },
        ],
      }),
    }));
    try {
      await searchSoldCompsListings({ playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" });
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
        await searchSoldCompsListings(metadata);
        assert.equal(soldCompsCalls, 1);

        // Budget (limit 1) is now exhausted — the next call should throw
        // without hitting the network at all.
        await assert.rejects(() => searchSoldCompsListings(metadata), /monthly request budget/i);
        assert.equal(soldCompsCalls, 1, "SoldComps should not be called again once budget is exhausted");
      } finally {
        restore();
      }
    },
  );
});

test("the retry budget is capped and configurable", async () => {
  // Worst case per card lookup is keywords x attempts. On the 100/month free
  // plan an unbounded retry count would be a real quota hazard, so this is
  // explicitly tunable and hard-capped.
  await withEnv({ SOLDCOMPS_MAX_ATTEMPTS: "2" }, () => {
    assert.equal(soldCompsMaxAttempts(), 2);
  });
  await withEnv({ SOLDCOMPS_MAX_ATTEMPTS: "99" }, () => {
    assert.equal(soldCompsMaxAttempts(), 5, "hard-capped so a typo cannot drain the quota");
  });
  await withEnv({ SOLDCOMPS_MAX_ATTEMPTS: "nonsense" }, () => {
    assert.equal(soldCompsMaxAttempts(), 3);
  });
});

test("an empty scrape retries, but never past the attempt cap", async () => {
  await withEnv(
    { SOLDCOMPS_API_KEY: "sc_test", SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "50", SOLDCOMPS_MAX_ATTEMPTS: "2" },
    async () => {
      let calls = 0;
      const restore = mockFetch(async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      });
      try {
        await searchSoldCompsListings({
          playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1",
        });
        assert.equal(calls, 2, "retried the empty scrape exactly to the cap, no further");
        const status = await getSoldCompsUsageStatus();
        assert.equal(status.count, 2, "every attempt is a real request and is counted");
      } finally {
        restore();
      }
    },
  );
});

// ── Outage breaker (added 2026-08-16) ──
// api.sold-comps.com returned a Cloudflare 502 on every request, each taking
// 12-18s to give up. A failed request costs no quota, so this is about not
// stalling a whole batch on someone else's outage.
import {
  isSoldCompsBreakerOpen,
  resetSoldCompsBreaker,
  getSoldCompsBreakerStatus,
} from "../src/services/soldcomps.js";

test("repeated upstream 5xx opens the breaker and stops calling out", async () => {
  resetSoldCompsBreaker();
  await withEnv(
    {
      SOLDCOMPS_API_KEY: "sc_test",
      SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "50",
      SOLDCOMPS_MAX_ATTEMPTS: "1",
      SOLDCOMPS_BREAKER_THRESHOLD: "2",
    },
    async () => {
      let calls = 0;
      const restore = mockFetch(async () => {
        calls += 1;
        return { ok: false, status: 502, json: async () => ({ message: "Bad gateway" }) };
      });
      const metadata = { playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" };
      try {
        await assert.rejects(() => searchSoldCompsListings(metadata), /SoldComps is down/i);
        await assert.rejects(() => searchSoldCompsListings(metadata), /SoldComps is down/i);
        assert.equal(calls, 2);
        assert.equal(isSoldCompsBreakerOpen(), true, "breaker opened after the threshold");

        // Third call must not touch the network at all.
        await assert.rejects(() => searchSoldCompsListings(metadata), /lookups paused/i);
        assert.equal(calls, 2, "no further requests once the breaker is open");

        // And an outage must never be charged against the monthly quota.
        const status = await getSoldCompsUsageStatus();
        assert.equal(status.count, 0, "failed requests cost no quota");
      } finally {
        restore();
        resetSoldCompsBreaker();
      }
    },
  );
});

test("a success clears the consecutive-error count", async () => {
  resetSoldCompsBreaker();
  await withEnv(
    { SOLDCOMPS_API_KEY: "sc_test", SOLDCOMPS_MONTHLY_REQUEST_LIMIT: "50", SOLDCOMPS_BREAKER_THRESHOLD: "3" },
    async () => {
      let n = 0;
      const restore = mockFetch(async () => {
        n += 1;
        if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              itemId: "x1", title: "2024 Test Set Test Player #1", condition: "Pre-Owned",
              soldPrice: "9.99", shippingPrice: "0.00", totalPrice: "9.99",
              endedAt: "2026-08-07T00:00:00.000Z", url: "https://www.ebay.com/itm/x1",
            }],
          }),
        };
      });
      const metadata = { playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" };
      try {
        await assert.rejects(() => searchSoldCompsListings(metadata), /SoldComps is down/i);
        assert.equal(getSoldCompsBreakerStatus().consecutiveServerErrors, 1);
        await searchSoldCompsListings(metadata);
        assert.equal(getSoldCompsBreakerStatus().consecutiveServerErrors, 0, "reset on success");
        assert.equal(isSoldCompsBreakerOpen(), false);
      } finally {
        restore();
        resetSoldCompsBreaker();
      }
    },
  );
});
