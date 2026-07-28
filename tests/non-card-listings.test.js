import test from "node:test";
import assert from "node:assert/strict";

import {
  isCardCategory,
  isNonCardListing,
  partitionListingsByCategory,
  summarizeByCategory,
  categoryLabel,
  computeAdjustedPrice,
  clampListingPrice,
  planBulkReprice,
  minimumListingPrice,
} from "../src/services/non-card-listings.js";

function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("card categories cover the four seen on the live account", () => {
  for (const id of ["261328", "183454", "183050", "261329"]) {
    assert.equal(isCardCategory(id), true, `${id} should be a card category`);
  }
  // Fan apparel categories observed on the store.
  for (const id of ["206", "2888", "15687", "24410", "24510", "24541", "155183"]) {
    assert.equal(isCardCategory(id), false, `${id} should not be a card category`);
  }
});

test("CARD_CATEGORY_IDS env overrides the default set", () => {
  withEnv("CARD_CATEGORY_IDS", "261328", () => {
    assert.equal(isCardCategory("261328"), true);
    // Card lots become non-card when the override omits them.
    assert.equal(isCardCategory("261329"), false);
  });
});

test("a garbage CARD_CATEGORY_IDS value falls back to the defaults", () => {
  withEnv("CARD_CATEGORY_IDS", "  ,,abc, ", () => {
    assert.equal(isCardCategory("261328"), true);
    assert.equal(isCardCategory("206"), false);
  });
});

test("an unknown category is never treated as non-card", () => {
  // Failing closed matters: a mis-parse that returned true here would sweep
  // ~900 cards into a panel whose whole purpose is bulk price changes.
  assert.equal(isNonCardListing({ categoryId: null }), false);
  assert.equal(isNonCardListing({ categoryId: "" }), false);
  assert.equal(isNonCardListing({ categoryId: "not-a-number" }), false);
  assert.equal(isNonCardListing({}), false);
  assert.equal(isNonCardListing({ categoryId: "206" }), true);
});

test("partition splits cards, non-cards and unclassified", () => {
  const listings = [
    { listingId: "1", categoryId: "261328" },
    { listingId: "2", categoryId: "206" },
    { listingId: "3", categoryId: "261329" },
    { listingId: "4", categoryId: null },
    { listingId: "5", categoryId: "24541" },
  ];
  const { nonCard, card, unclassified } = partitionListingsByCategory(listings);
  assert.deepEqual(nonCard.map((r) => r.listingId), ["2", "5"]);
  assert.deepEqual(card.map((r) => r.listingId), ["1", "3"]);
  assert.deepEqual(unclassified.map((r) => r.listingId), ["4"]);
});

test("summary groups by category with counts and total value", () => {
  const summary = summarizeByCategory([
    { categoryId: "206", currentPrice: 63.61 },
    { categoryId: "206", currentPrice: 50.86 },
    { categoryId: "24541", currentPrice: 21.11 },
    { categoryId: "206", currentPrice: null },
  ]);
  assert.equal(summary[0].categoryId, "206");
  assert.equal(summary[0].count, 3);
  assert.equal(summary[0].totalValue, 114.47);
  assert.equal(summary[1].categoryId, "24541");
  assert.equal(summary[1].count, 1);
});

test("category labels are human-readable, with a fallback for unknown ids", () => {
  assert.equal(categoryLabel("206"), "Football-NFL Fan Apparel");
  assert.equal(categoryLabel("999999"), "Category 999999");
  assert.equal(categoryLabel(null), "Unknown category");
});

test("percent adjustments round to cents and allow negatives", () => {
  assert.equal(computeAdjustedPrice(50.86, { type: "percent", value: 10 }), 55.95);
  assert.equal(computeAdjustedPrice(50.86, { type: "percent", value: -15 }), 43.23);
  assert.equal(computeAdjustedPrice(10, { type: "percent", value: 0 }), 10);
});

test("a -100% or worse cut is rejected rather than silently floored", () => {
  assert.equal(computeAdjustedPrice(50, { type: "percent", value: -100 }), null);
  assert.equal(computeAdjustedPrice(50, { type: "percent", value: -150 }), null);
});

test("amount and fixed adjustments behave as documented", () => {
  assert.equal(computeAdjustedPrice(20, { type: "amount", value: 5.5 }), 25.5);
  assert.equal(computeAdjustedPrice(20, { type: "amount", value: -5.5 }), 14.5);
  assert.equal(computeAdjustedPrice(20, { type: "fixed", value: 9.99 }), 9.99);
  // fixed ignores the current price entirely, including a missing one
  assert.equal(computeAdjustedPrice(null, { type: "fixed", value: 9.99 }), 9.99);
  assert.equal(computeAdjustedPrice(null, { type: "percent", value: 10 }), null);
  assert.equal(computeAdjustedPrice(0, { type: "percent", value: 10 }), null);
  assert.equal(computeAdjustedPrice(20, { type: "nonsense", value: 10 }), null);
  assert.equal(computeAdjustedPrice(20, { type: "percent", value: "abc" }), null);
});

test("clamping applies the floor and an optional ceiling", () => {
  assert.equal(clampListingPrice(0.25), minimumListingPrice());
  assert.equal(clampListingPrice(5, { minPrice: 10 }), 10);
  assert.equal(clampListingPrice(50, { maxPrice: 25 }), 25);
  assert.equal(clampListingPrice(15, { minPrice: 10, maxPrice: 25 }), 15);
});

test("NON_CARD_MIN_PRICE overrides the default floor", () => {
  withEnv("NON_CARD_MIN_PRICE", "4.99", () => {
    assert.equal(minimumListingPrice(), 4.99);
    assert.equal(clampListingPrice(1), 4.99);
  });
});

test("bulk plan produces exact per-listing changes and totals", () => {
  const plan = planBulkReprice({
    listings: [
      { listingId: "1", sku: "A", title: "Jets Hoodie", categoryId: "206", currentPrice: 63.61 },
      { listingId: "2", sku: "B", title: "Iowa Shirt", categoryId: "24541", currentPrice: 21.11 },
    ],
    adjustment: { type: "percent", value: -10 },
  });
  assert.equal(plan.changes.length, 2);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.changes[0].newPrice, 57.25);
  assert.equal(plan.changes[0].delta, -6.36);
  assert.equal(plan.changes[0].deltaPercent, -10);
  assert.equal(plan.changes[1].newPrice, 19);
  assert.equal(plan.totalCurrentValue, 84.72);
  assert.equal(plan.totalNewValue, 76.25);
});

test("bulk plan skips listings it cannot price, with a reason each", () => {
  const plan = planBulkReprice({
    listings: [
      { listingId: null, currentPrice: 20 },
      { listingId: "2", currentPrice: null },
      { listingId: "3", currentPrice: 0 },
      { listingId: "4", currentPrice: 20 },
    ],
    adjustment: { type: "percent", value: 0 },
  });
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.skipped.map((row) => row.reason), [
    "no_listing_id",
    "no_current_price",
    "no_current_price",
    "unchanged",
  ]);
});

test("a change flattened onto the floor is marked clamped, not silently applied", () => {
  const plan = planBulkReprice({
    listings: [{ listingId: "1", currentPrice: 2 }],
    adjustment: { type: "percent", value: -90 },
  });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].newPrice, minimumListingPrice());
  assert.equal(plan.changes[0].clamped, true);
});

test("a clamp that lands exactly on the current price is skipped as unchanged", () => {
  const plan = planBulkReprice({
    listings: [{ listingId: "1", currentPrice: 10 }],
    adjustment: { type: "percent", value: -50 },
    minPrice: 10,
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.skipped[0].reason, "unchanged");
});
