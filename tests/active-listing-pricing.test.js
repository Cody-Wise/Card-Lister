import test from "node:test";
import assert from "node:assert/strict";
import {
  printRunFromListing,
  scarcityFactor,
  selectCompTier,
  percentile,
  computeActiveListingPrice,
} from "../src/services/active-listing-pricing.js";

const listing = (title, price, extra = {}) => ({ title, totalPrice: price, ...extra });

test("printRunFromListing reads the run from structured fields and title forms", () => {
  assert.equal(printRunFromListing({ printRun: 25 }), 25);
  assert.equal(printRunFromListing({ serialNumber: "12/99" }), 99);
  assert.equal(printRunFromListing({ title: "2023 Panini Prizm Green #/175" }), 175);
  assert.equal(printRunFromListing({ title: "2023 Select Blue 08/25 RC" }), 25);
  assert.equal(printRunFromListing({ title: "1970 Super Stars 10 of 60 Autographed" }), 60);
  // Unnumbered/base is a real answer, not a failure.
  assert.equal(printRunFromListing({ title: "2024 Donruss Base Rookie RC" }), null);
});

// The user's spec, stated directly: a /25 priced off /50 listings takes a
// premium; that same /25 priced off /10 listings comes in below them.
test("scarcityFactor: rarer target than the comp tier yields a premium", () => {
  const factor = scarcityFactor(25, 50);
  assert.ok(factor > 1, `expected a premium, got ${factor}`);
  assert.ok(factor < 2, `premium should be sub-linear, got ${factor}`);
});

test("scarcityFactor: more common target than the comp tier yields a discount", () => {
  const factor = scarcityFactor(25, 10);
  assert.ok(factor < 1, `expected a discount, got ${factor}`);
  assert.ok(factor > 0.5, `discount should be sub-linear, got ${factor}`);
});

test("scarcityFactor: identical print runs are unadjusted", () => {
  assert.equal(scarcityFactor(25, 25), 1);
  assert.equal(scarcityFactor(null, null), 1);
});

test("scarcityFactor: value scales sub-linearly, not proportionally", () => {
  // Halving the print run must NOT double the price.
  const factor = scarcityFactor(25, 50);
  assert.ok(factor < 1.6, `a /25 vs /50 shouldn't approach 2x, got ${factor}`);
});

test("scarcityFactor: a numbered target vs unnumbered comps takes the max premium", () => {
  assert.equal(scarcityFactor(25, null, { maxFactor: 2 }), 2);
});

test("scarcityFactor: an unnumbered target vs numbered comps takes the min factor", () => {
  assert.equal(scarcityFactor(null, 25, { minFactor: 0.5 }), 0.5);
});

test("scarcityFactor: extreme tier gaps are clamped to the configured bounds", () => {
  assert.equal(scarcityFactor(1, 5000, { maxFactor: 2 }), 2);
  assert.equal(scarcityFactor(5000, 1, { minFactor: 0.5 }), 0.5);
});

test("selectCompTier prefers an exact print-run match and applies no adjustment", () => {
  const tier = selectCompTier(
    [
      listing("Card /50", 10),
      listing("Card /25", 20),
      listing("Card /25", 22),
    ],
    25,
  );
  assert.equal(tier.tier, "exact");
  assert.equal(tier.printRun, 25);
  assert.equal(tier.listings.length, 2);
  assert.equal(tier.factor, 1);
});

test("selectCompTier falls back to the closest tier by ratio, not absolute difference", () => {
  // For a /25 target, /50 (2x) is closer than /500 (20x), even though 500
  // is further in absolute terms than... well, both are — the point is the
  // ratio ordering must win.
  const tier = selectCompTier([listing("Card /500", 5), listing("Card /50", 12)], 25);
  assert.equal(tier.tier, "nearest");
  assert.equal(tier.printRun, 50);
  assert.ok(tier.factor > 1);
});

test("selectCompTier caps the sample at 50 listings", () => {
  const many = Array.from({ length: 80 }, (_, i) => listing(`Card /25 #${i}`, 10 + i));
  const tier = selectCompTier(many, 25);
  assert.equal(tier.listings.length, 50);
});

test("selectCompTier reports 'none' when nothing has a usable price", () => {
  const tier = selectCompTier([listing("Card /25", 0), listing("Card /25", null)], 25);
  assert.equal(tier.tier, "none");
  assert.equal(tier.listings.length, 0);
});

test("percentile interpolates and handles degenerate inputs", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0), 10);
  assert.equal(percentile([10, 20, 30, 40, 50], 1), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([42], 0.25), 42);
  assert.equal(percentile([], 0.5), null);
});

test("computeActiveListingPrice: exact tier prices off the low percentile, unadjusted", () => {
  const listings = [
    listing("Lively /25", 10),
    listing("Lively /25", 20),
    listing("Lively /25", 30),
    listing("Lively /25", 40),
    listing("Lively /25", 50),
  ];
  const result = computeActiveListingPrice(listings, { printRun: 25 }, { percentile: 0.25 });
  assert.equal(result.tier, "exact");
  assert.equal(result.scarcityFactor, 1);
  assert.equal(result.sampleSize, 5);
  // P25 of [10,20,30,40,50] is 20; no scarcity adjustment on an exact tier.
  assert.equal(result.price, 20);
});

test("computeActiveListingPrice: a /25 with only /50 comps is priced ABOVE the /50 basis", () => {
  const listings = [listing("Card /50", 10), listing("Card /50", 20), listing("Card /50", 30)];
  const result = computeActiveListingPrice(listings, { printRun: 25 }, { percentile: 0.5 });
  assert.equal(result.tier, "nearest");
  assert.equal(result.compPrintRun, 50);
  assert.equal(result.targetPrintRun, 25);
  assert.ok(result.scarcityFactor > 1, "should carry a premium");
  assert.ok(result.price > result.basisPrice, `${result.price} should exceed basis ${result.basisPrice}`);
  assert.match(result.reason, /premium/);
});

test("computeActiveListingPrice: a /25 with only /10 comps is priced BELOW the /10 basis", () => {
  const listings = [listing("Card /10", 100), listing("Card /10", 200), listing("Card /10", 300)];
  const result = computeActiveListingPrice(listings, { printRun: 25 }, { percentile: 0.5 });
  assert.equal(result.tier, "nearest");
  assert.equal(result.compPrintRun, 10);
  assert.ok(result.scarcityFactor < 1, "should carry a discount");
  assert.ok(result.price < result.basisPrice, `${result.price} should be under basis ${result.basisPrice}`);
  assert.match(result.reason, /discount/);
});

test("computeActiveListingPrice returns a null price (not a guess) with no usable listings", () => {
  const result = computeActiveListingPrice([], { printRun: 25 });
  assert.equal(result.price, null);
  assert.equal(result.tier, "none");
  assert.equal(result.sampleSize, 0);
});

test("computeActiveListingPrice handles unnumbered (base) cards against unnumbered comps", () => {
  const listings = [listing("Base Rookie RC", 4), listing("Base Rookie RC", 6), listing("Base Rookie RC", 8)];
  const result = computeActiveListingPrice(listings, {}, { percentile: 0.5 });
  assert.equal(result.tier, "exact");
  assert.equal(result.targetPrintRun, null);
  assert.equal(result.scarcityFactor, 1);
  assert.equal(result.price, 6);
});
