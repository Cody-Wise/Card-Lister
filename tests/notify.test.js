import test from "node:test";
import assert from "node:assert/strict";
import { sendPushNotification, hasPushNotifyConfig } from "../src/services/notify.js";

function withMockedFetch(mock, run) {
  const original = global.fetch;
  global.fetch = mock;
  return run().finally(() => {
    global.fetch = original;
  });
}

test("does nothing when PUSH_NOTIFY_URL is not configured", async () => {
  delete process.env.PUSH_NOTIFY_URL;
  assert.equal(hasPushNotifyConfig(), false);
  let called = false;
  await withMockedFetch(async () => { called = true; }, async () => {
    const result = await sendPushNotification({ title: "t", message: "m" });
    assert.deepEqual(result, { sent: false, reason: "not configured" });
  });
  assert.equal(called, false);
});

test("sends ntfy-style plain text with Title/Click headers for a generic URL", async () => {
  process.env.PUSH_NOTIFY_URL = "https://ntfy.sh/my-topic";
  try {
    let captured = null;
    await withMockedFetch(async (url, options) => {
      captured = { url, options };
      return { ok: true };
    }, async () => {
      const result = await sendPushNotification({
        title: "New eBay Best Offer: $3.25",
        message: "Ja'Kobe Walter — offer $3.25 vs asking $5",
        clickUrl: "https://www.ebay.com/itm/236263906800",
      });
      assert.equal(result.sent, true);
    });
    assert.equal(captured.url, "https://ntfy.sh/my-topic");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Title, "New eBay Best Offer: $3.25");
    assert.equal(captured.options.headers.Click, "https://www.ebay.com/itm/236263906800");
    assert.equal(captured.options.body, "Ja'Kobe Walter — offer $3.25 vs asking $5");
  } finally {
    delete process.env.PUSH_NOTIFY_URL;
  }
});

test("sends Discord {content} JSON when the URL is a discord webhook", async () => {
  process.env.PUSH_NOTIFY_URL = "https://discord.com/api/webhooks/123/abc";
  try {
    let captured = null;
    await withMockedFetch(async (url, options) => {
      captured = { url, options };
      return { ok: true };
    }, async () => {
      const result = await sendPushNotification({ title: "Title", message: "Body" });
      assert.equal(result.sent, true);
    });
    assert.equal(captured.options.headers["Content-Type"], "application/json");
    const payload = JSON.parse(captured.options.body);
    assert.match(payload.content, /\*\*Title\*\*/);
    assert.match(payload.content, /Body/);
  } finally {
    delete process.env.PUSH_NOTIFY_URL;
  }
});

test("reports sent:false (never throws) on network failure and non-2xx responses", async () => {
  process.env.PUSH_NOTIFY_URL = "https://ntfy.sh/my-topic";
  try {
    await withMockedFetch(async () => { throw new Error("network down"); }, async () => {
      const result = await sendPushNotification({ title: "t", message: "m" });
      assert.equal(result.sent, false);
      assert.match(result.reason, /network down/);
    });
    await withMockedFetch(async () => ({ ok: false, status: 502, text: async () => "bad gateway" }), async () => {
      const result = await sendPushNotification({ title: "t", message: "m" });
      assert.equal(result.sent, false);
      assert.match(result.reason, /502/);
    });
  } finally {
    delete process.env.PUSH_NOTIFY_URL;
  }
});
