import test from "node:test";
import assert from "node:assert/strict";
import { detectSalePriceAnomaly } from "../src/app.js";

// Real incident that prompted this feature: the repricer's compounding-clamp
// bug repriced a ~$15 card down to $3, and it sold at that price with
// nothing surfacing the gap between the sale and the card's own comps.

test("flags a sale that lands well below the card's comp range", () => {
  const card = { externalPricingSummary: { low: 12, high: 18 } };
  const anomaly = detectSalePriceAnomaly(card, 3);
  assert.ok(anomaly);
  assert.equal(anomaly.reason, "under_comp_range");
  assert.equal(anomaly.expectedLow, 12);
  assert.equal(anomaly.expectedHigh, 18);
  assert.equal(anomaly.soldAmount, 3);
});

test("flags a sale that lands well above the card's comp range", () => {
  const card = { externalPricingSummary: { low: 10, high: 20 } };
  const anomaly = detectSalePriceAnomaly(card, 35);
  assert.ok(anomaly);
  assert.equal(anomaly.reason, "over_comp_range");
});

test("does not flag a sale inside a sane range around the comps", () => {
  const card = { externalPricingSummary: { low: 12, high: 18 } };
  assert.equal(detectSalePriceAnomaly(card, 14), null);
  // Right at the boundary should not flag either (strict inequality only).
  assert.equal(detectSalePriceAnomaly(card, 12 * 0.7), null);
  assert.equal(detectSalePriceAnomaly(card, 18 * 1.5), null);
});

test("returns null when the card has no comp data to compare against", () => {
  assert.equal(detectSalePriceAnomaly({}, 3), null);
  assert.equal(detectSalePriceAnomaly({ externalPricingSummary: {} }, 3), null);
});

test("returns null for a non-finite or non-positive sold amount", () => {
  const card = { externalPricingSummary: { low: 12, high: 18 } };
  assert.equal(detectSalePriceAnomaly(card, null), null);
  assert.equal(detectSalePriceAnomaly(card, 0), null);
  assert.equal(detectSalePriceAnomaly(card, NaN), null);
});

test("compares against soldPrice (per-unit), so a fairly-priced multi-quantity sale is not penalized for its line total", () => {
  // This is exactly why the sales-sync call site passes card.soldPrice, not
  // card.soldAmount — a 2-unit sale of a $15 card totals $30, which would
  // otherwise look like a wildly overpriced single sale against a $10-$20
  // comp range.
  const card = { externalPricingSummary: { low: 10, high: 20 } };
  assert.equal(detectSalePriceAnomaly(card, 15), null);
});
