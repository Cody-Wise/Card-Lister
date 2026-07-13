import test from "node:test";
import assert from "node:assert/strict";
import { computeBestOfferThresholds } from "../src/services/ebay.js";

// User's spec (2026-07-09, verbatim): "Set the auto approve threshold
// automatically to anything 85% of asking or higher and the auto decline
// automatically to anything 50% or lower on cards up to $50. Anything over
// $50 auto accept gate needs to be 90%."

test("uses the 85% accept tier for listings up to $50", () => {
  assert.deepEqual(computeBestOfferThresholds(20), {
    autoAcceptPrice: 17,
    autoDeclinePrice: 10,
  });
});

test("uses the 90% accept tier above $50", () => {
  assert.deepEqual(computeBestOfferThresholds(100), {
    autoAcceptPrice: 90,
    autoDeclinePrice: 50,
  });
});

test("treats exactly $50 as the low tier ('up to $50' is inclusive)", () => {
  assert.deepEqual(computeBestOfferThresholds(50), {
    autoAcceptPrice: 42.5,
    autoDeclinePrice: 25,
  });
});

test("rounds to cents", () => {
  // 8.15 * 0.85 = 6.9275 -> 6.93; 8.15 * 0.5 = 4.075 -> 4.08 (the exact
  // values confirmed live on the Pinsir spike listing).
  assert.deepEqual(computeBestOfferThresholds(8.15), {
    autoAcceptPrice: 6.93,
    autoDeclinePrice: 4.08,
  });
});

test("returns null when there is no usable price", () => {
  assert.equal(computeBestOfferThresholds(null), null);
  assert.equal(computeBestOfferThresholds(0), null);
  assert.equal(computeBestOfferThresholds(-5), null);
  assert.equal(computeBestOfferThresholds("not a price"), null);
});

test("honors the env overrides", () => {
  process.env.BEST_OFFER_AUTO_ACCEPT_PCT = "0.8";
  process.env.BEST_OFFER_AUTO_DECLINE_PCT = "0.4";
  process.env.BEST_OFFER_AUTO_ACCEPT_HIGH_TIER_THRESHOLD = "100";
  try {
    // 60 is above the default $50 boundary but below the overridden $100
    // one, so the (overridden) low-tier accept percentage applies.
    assert.deepEqual(computeBestOfferThresholds(60), {
      autoAcceptPrice: 48,
      autoDeclinePrice: 24,
    });
  } finally {
    delete process.env.BEST_OFFER_AUTO_ACCEPT_PCT;
    delete process.env.BEST_OFFER_AUTO_DECLINE_PCT;
    delete process.env.BEST_OFFER_AUTO_ACCEPT_HIGH_TIER_THRESHOLD;
  }
});

test("falls back to defaults when a misconfigured env pair puts decline at or above accept", () => {
  process.env.BEST_OFFER_AUTO_ACCEPT_PCT = "0.5";
  process.env.BEST_OFFER_AUTO_DECLINE_PCT = "0.6";
  try {
    assert.deepEqual(computeBestOfferThresholds(20), {
      autoAcceptPrice: 17,
      autoDeclinePrice: 10,
    });
  } finally {
    delete process.env.BEST_OFFER_AUTO_ACCEPT_PCT;
    delete process.env.BEST_OFFER_AUTO_DECLINE_PCT;
  }
});

test("ignores out-of-range env values and uses the defaults", () => {
  process.env.BEST_OFFER_AUTO_ACCEPT_PCT = "85"; // meant 0.85 — 85 is not a valid decimal pct
  try {
    assert.deepEqual(computeBestOfferThresholds(20), {
      autoAcceptPrice: 17,
      autoDeclinePrice: 10,
    });
  } finally {
    delete process.env.BEST_OFFER_AUTO_ACCEPT_PCT;
  }
});
