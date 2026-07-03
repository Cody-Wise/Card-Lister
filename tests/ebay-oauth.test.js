import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exchangeEbayCode, refreshEbayToken, setEbayConfig } from "../src/services/ebay.js";

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
