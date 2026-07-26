import test from "node:test";
import assert from "node:assert/strict";
import {
  autoActivePricingMaxPrice,
  computeActiveListingFallbackPrice,
} from "../src/services/active-listing-pricing.js";

// The $10 ceiling is the load-bearing guardrail for this whole feature.
// Sold comps went behind eBay's sign-in wall (2026-07-26), so the scheduler
// now prices from ACTIVE listings — which are asks, not sales. Unattended
// pushes are therefore allowed only where a wrong price is cheap; anything
// at or above the ceiling must fall through to human approval.

const listings = (price, count = 5) =>
  Array.from({ length: count }, (_, i) => ({ title: `Card /25 #${i}`, totalPrice: price + i }));

test("autoActivePricingMaxPrice defaults to $10 and honours the env override", () => {
  const original = process.env.AUTO_ACTIVE_PRICING_MAX_PRICE;
  delete process.env.AUTO_ACTIVE_PRICING_MAX_PRICE;
  assert.equal(autoActivePricingMaxPrice(), 10);
  process.env.AUTO_ACTIVE_PRICING_MAX_PRICE = "25";
  assert.equal(autoActivePricingMaxPrice(), 25);
  process.env.AUTO_ACTIVE_PRICING_MAX_PRICE = "not-a-number";
  assert.equal(autoActivePricingMaxPrice(), 10);
  if (original === undefined) delete process.env.AUTO_ACTIVE_PRICING_MAX_PRICE;
  else process.env.AUTO_ACTIVE_PRICING_MAX_PRICE = original;
});

test("a cheap card (under the ceiling) IS eligible for unattended repricing", () => {
  const result = computeActiveListingFallbackPrice({
    card: { printRun: 25 },
    currentPrice: 4.5,
    activeListings: listings(6),
    lookupMetadata: { printRun: 25 },
  });
  assert.equal(result.eligible, true);
  assert.ok(result.price > 0);
});

test("a card AT the ceiling is NOT eligible — approval required", () => {
  const result = computeActiveListingFallbackPrice({
    card: { printRun: 25 },
    currentPrice: 10,
    activeListings: listings(20),
    lookupMetadata: { printRun: 25 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.skippedReason, "active-fallback-needs-approval");
});

test("an expensive card is NOT eligible — this is the blast-radius cap", () => {
  const result = computeActiveListingFallbackPrice({
    card: { printRun: 25 },
    currentPrice: 250,
    activeListings: listings(300),
    lookupMetadata: { printRun: 25 },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.skippedReason, "active-fallback-needs-approval");
  assert.match(result.detail.reason, /suggestion only/);
});

test("setting the ceiling to 0 disables unattended active-listing repricing entirely", () => {
  const original = process.env.AUTO_ACTIVE_PRICING_MAX_PRICE;
  process.env.AUTO_ACTIVE_PRICING_MAX_PRICE = "0";
  try {
    const result = computeActiveListingFallbackPrice({
      card: {},
      currentPrice: 1,
      activeListings: listings(2),
    });
    assert.equal(result.eligible, false);
    assert.equal(result.skippedReason, "active-fallback-disabled");
  } finally {
    if (original === undefined) delete process.env.AUTO_ACTIVE_PRICING_MAX_PRICE;
    else process.env.AUTO_ACTIVE_PRICING_MAX_PRICE = original;
  }
});

test("no usable active listings yields no price rather than a guess", () => {
  const result = computeActiveListingFallbackPrice({
    card: {},
    currentPrice: 3,
    activeListings: [],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.skippedReason, "active-fallback-no-price");
});

test("an unknown current price is treated as not-cheap and requires approval", () => {
  // Defensive: a card with no reliable current price must not slip under a
  // ceiling check that only compares numbers.
  for (const currentPrice of [null, undefined, Number.NaN]) {
    const result = computeActiveListingFallbackPrice({
      card: {},
      currentPrice,
      activeListings: listings(3),
    });
    assert.equal(result.eligible, false, `currentPrice=${currentPrice} must not be eligible`);
  }
});

test("the scarcity adjustment still applies inside the auto path", () => {
  // Target /25 priced off /50 listings -> premium, per the pricing rule.
  const result = computeActiveListingFallbackPrice({
    card: { printRun: 25 },
    currentPrice: 5,
    activeListings: [
      { title: "Card /50", totalPrice: 6 },
      { title: "Card /50", totalPrice: 6 },
    ],
    lookupMetadata: { printRun: 25 },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.detail.tier, "nearest");
  assert.ok(result.detail.scarcityFactor > 1, "a /25 off /50 comps should carry a premium");
});
