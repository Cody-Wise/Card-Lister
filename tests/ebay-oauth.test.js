import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  exchangeEbayCode,
  refreshEbayToken,
  setEbayConfig,
  TRADING_AUTH_FAILURE_PATTERN,
  extractListingIdFromUrl,
} from "../src/services/ebay.js";

// These exercise the eBay OAuth token exchange/refresh flows end-to-end
// against a mocked fetch boundary — real request shape (Basic auth header,
// grant_type/redirect_uri body, correct token URL for the configured
// environment) and real response handling (success + eBay's documented error
// shape), without hitting the real eBay API. Addresses the README's
// previously-flagged gap: "no strong integration-test coverage for live eBay
// ... flows".
const ORIGINAL_ENV = { ...process.env };

// setEbayConfig() persists to data/ebay-config.json immediately and
// unconditionally (see src/services/ebay.js) — that file can hold a real
// locally-authorized refresh token, not just test fixtures. Back it up before
// these tests run and restore it verbatim afterward so running this suite
// can never permanently clobber a real local credential.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ebayConfigPath = path.join(rootDir, "data", "ebay-config.json");
let backedUpConfig;
let backupExisted = false;

before(async () => {
  try {
    backedUpConfig = await fsp.readFile(ebayConfigPath, "utf8");
    backupExisted = true;
  } catch {
    backupExisted = false;
  }
});

after(async () => {
  if (backupExisted) {
    await fsp.writeFile(ebayConfigPath, backedUpConfig);
  } else {
    await fsp.rm(ebayConfigPath, { force: true });
  }
});

function withEbayEnv(overrides, fn) {
  Object.assign(process.env, {
    EBAY_CLIENT_ID: "test-client-id",
    EBAY_CLIENT_SECRET: "test-client-secret",
    EBAY_RUNAME: "test-ru-name",
    EBAY_ENV: "production",
    ...overrides,
  });
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });
}

function mockFetchOnce(handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = originalFetch;
  };
}

test("exchangeEbayCode sends the correct token request and parses a successful response", async () => {
  await withEbayEnv({}, async () => {
    let capturedUrl = null;
    let capturedInit = null;
    const restore = mockFetchOnce((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7200,
          }),
      });
    });
    try {
      const result = await exchangeEbayCode("auth-code-123", {});
      assert.equal(capturedUrl, "https://api.ebay.com/identity/v1/oauth2/token");
      assert.equal(capturedInit.method, "POST");
      assert.match(capturedInit.headers.Authorization, /^Basic /);
      const expectedBasic = Buffer.from("test-client-id:test-client-secret").toString("base64");
      assert.equal(capturedInit.headers.Authorization, `Basic ${expectedBasic}`);
      const body = new URLSearchParams(capturedInit.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "auth-code-123");
      assert.equal(body.get("redirect_uri"), "test-ru-name");
      assert.equal(result.access_token, "new-access-token");
      assert.equal(result.refresh_token, "new-refresh-token");
    } finally {
      restore();
    }
  });
});

test("exchangeEbayCode uses the sandbox token URL when EBAY_ENV=sandbox", async () => {
  await withEbayEnv({ EBAY_ENV: "sandbox" }, async () => {
    let capturedUrl = null;
    const restore = mockFetchOnce((url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: "x" }) });
    });
    try {
      await exchangeEbayCode("code", {});
      assert.equal(capturedUrl, "https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    } finally {
      restore();
    }
  });
});

test("exchangeEbayCode surfaces eBay's documented error fields in a readable message", async () => {
  await withEbayEnv({}, async () => {
    const restore = mockFetchOnce(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: "invalid_grant",
            error_description: "Authorization code is expired",
            error_id: "1051",
          }),
      }),
    );
    try {
      await assert.rejects(
        () => exchangeEbayCode("stale-code", {}),
        (error) => {
          assert.match(error.message, /error=invalid_grant/);
          assert.match(error.message, /error_description=Authorization code is expired/);
          assert.match(error.message, /error_id=1051/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

test("exchangeEbayCode throws without hitting the network when client credentials are missing", async () => {
  await withEbayEnv({ EBAY_CLIENT_ID: "", EBAY_CLIENT_SECRET: "" }, async () => {
    let fetchCalled = false;
    const restore = mockFetchOnce(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    try {
      await assert.rejects(() => exchangeEbayCode("code", {}), /Missing EBAY_CLIENT_ID/);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

test("refreshEbayToken sends a refresh_token grant and stores the new access token", async () => {
  await withEbayEnv({}, async () => {
    setEbayConfig({ refreshToken: "existing-refresh-token" });
    let capturedBody = null;
    const restore = mockFetchOnce((url, init) => {
      capturedBody = new URLSearchParams(init.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: "refreshed-token" }),
      });
    });
    try {
      const result = await refreshEbayToken();
      assert.equal(capturedBody.get("grant_type"), "refresh_token");
      assert.equal(capturedBody.get("refresh_token"), "existing-refresh-token");
      assert.equal(result.access_token, "refreshed-token");
    } finally {
      restore();
    }
  });
});

test("refreshEbayToken throws with eBay's error message on a generic failure", async () => {
  await withEbayEnv({}, async () => {
    setEbayConfig({ refreshToken: "existing-refresh-token" });
    const restore = mockFetchOnce(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server_error" }),
      }),
    );
    try {
      await assert.rejects(() => refreshEbayToken(), /eBay token refresh failed: server_error/);
    } finally {
      restore();
    }
  });
});

test("refreshEbayToken throws immediately when there's no refresh token to use", async () => {
  await withEbayEnv({}, async () => {
    setEbayConfig({ refreshToken: "" });
    const originalRefreshTokenEnv = process.env.EBAY_REFRESH_TOKEN;
    delete process.env.EBAY_REFRESH_TOKEN;
    let fetchCalled = false;
    const restore = mockFetchOnce(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    try {
      await assert.rejects(() => refreshEbayToken(), /No refresh token available/);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
      if (originalRefreshTokenEnv !== undefined) process.env.EBAY_REFRESH_TOKEN = originalRefreshTokenEnv;
    }
  });
});

test("TRADING_AUTH_FAILURE_PATTERN matches the real live error message (confirmed 2026-07-08)", () => {
  // requestTradingEbay's old retry condition was response.status === 401
  // only — but the Trading API reports this as HTTP 200 with Ack=Failure,
  // so the retry never fired at all. Guards against the pattern being
  // narrowed back down to something that misses this real message.
  assert.ok(
    TRADING_AUTH_FAILURE_PATTERN.test(
      "Auth token is hard expired, User needs to generate a new token for this application.",
    ),
  );
});

test("TRADING_AUTH_FAILURE_PATTERN doesn't match an unrelated Trading API failure", () => {
  assert.ok(!TRADING_AUTH_FAILURE_PATTERN.test("Item not found."));
  assert.ok(!TRADING_AUTH_FAILURE_PATTERN.test("Best Offer not found."));
});

test("extractListingIdFromUrl pulls the trailing numeric ID from an SEO-slugged URL, not the leading year", () => {
  // Same real live bug as ebay-best-offers.js's extractItemIdFromListingUrl
  // (RespondToBestOffer Accept failed with 'Item "2024" is invalid') — this
  // is a second, independent copy of the same too-narrow regex.
  assert.equal(
    extractListingIdFromUrl(
      "https://www.ebay.com/itm/2024-25-Panini-Select-Neon-Icons-Victor-Wembanyama-23/236298326630",
    ),
    "236298326630",
  );
});

test("extractListingIdFromUrl still handles a bare URL and a query string", () => {
  assert.equal(extractListingIdFromUrl("https://www.ebay.com/itm/236917541201"), "236917541201");
  assert.equal(extractListingIdFromUrl("https://www.ebay.com/itm/236917541201?nordt=true"), "236917541201");
});

test("extractListingIdFromUrl returns null for a missing/non-matching URL", () => {
  assert.equal(extractListingIdFromUrl(""), null);
  assert.equal(extractListingIdFromUrl(null), null);
  assert.equal(extractListingIdFromUrl("https://www.ebay.com/sch/i.html?_nkw=x"), null);
});
