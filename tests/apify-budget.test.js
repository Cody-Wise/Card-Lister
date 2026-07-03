import test from "node:test";
import assert from "node:assert/strict";
import { searchApifySoldListings, getApifyUsageStatus } from "../src/services/apify.js";

// Apify bills per real actor run rather than a flat monthly request count,
// so — unlike the old SoldComps.com local counter — the actual spend/cap
// live only on Apify's own account (queried via /v2/users/me/limits).
// Force every check to go through whatever fetch mock is live for the
// current test rather than a cached status from an earlier case (this
// module caches that status in memory, and Node's test runner runs separate
// *.test.js files concurrently by default).
process.env.APIFY_BUDGET_CACHE_MS = "0";

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

function mockLimitsFetch({ usageUsd, limitUsd }) {
  return async (url) => {
    if (String(url).includes("/v2/users/me/limits")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { limits: { maxMonthlyUsageUsd: limitUsd }, current: { monthlyUsageUsd: usageUsd } } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
}

test("getApifyUsageStatus reports configured: false when APIFY_TOKEN is unset", async () => {
  await withEnv({ APIFY_TOKEN: "" }, async () => {
    const status = await getApifyUsageStatus();
    assert.equal(status.configured, false);
  });
});

test("getApifyUsageStatus reports real usage/limit from the account and has budget when well under the cap", async () => {
  await withEnv({ APIFY_TOKEN: "test-token" }, async () => {
    const restore = mockFetch(mockLimitsFetch({ usageUsd: 10, limitUsd: 40 }));
    try {
      const status = await getApifyUsageStatus();
      assert.equal(status.configured, true);
      assert.equal(status.usageUsd, 10);
      assert.equal(status.limitUsd, 40);
      assert.equal(status.hasBudget, true);
    } finally {
      restore();
    }
  });
});

test("a lookup succeeds normally when comfortably under the account's usage cap", async () => {
  await withEnv({ APIFY_TOKEN: "test-token" }, async () => {
    const restore = mockFetch(mockLimitsFetch({ usageUsd: 5, limitUsd: 40 }));
    try {
      const result = await searchApifySoldListings({
        playerName: "Test Player",
        year: 2024,
        setName: "Test Set",
        cardNumber: "1",
      });
      assert.equal(result.source, "apify");
    } finally {
      restore();
    }
  });
});

test("refuses new lookups once real usage is within the safety margin of the cap, without spending a real run", async () => {
  await withEnv({ APIFY_TOKEN: "test-token", APIFY_BUDGET_SAFETY_MARGIN_USD: "2" }, async () => {
    let actorCalls = 0;
    const restore = mockFetch(async (url) => {
      if (String(url).includes("/v2/users/me/limits")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { limits: { maxMonthlyUsageUsd: 40 }, current: { monthlyUsageUsd: 39 } } }),
        };
      }
      actorCalls += 1;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });
    try {
      const metadata = { playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" };
      await assert.rejects(() => searchApifySoldListings(metadata), /usage.*exhausted/i);
      assert.equal(actorCalls, 0, "should not spend a real actor run once within the safety margin");
    } finally {
      restore();
    }
  });
});

test("fails open (allows the lookup) if Apify's own account-limits endpoint can't be reached", async () => {
  await withEnv({ APIFY_TOKEN: "test-token" }, async () => {
    const restore = mockFetch(async (url) => {
      if (String(url).includes("/v2/users/me/limits")) {
        throw new Error("network down");
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    });
    try {
      const result = await searchApifySoldListings({
        playerName: "Test Player",
        year: 2024,
        setName: "Test Set",
        cardNumber: "1",
      });
      assert.equal(result.source, "apify");
    } finally {
      restore();
    }
  });
});
